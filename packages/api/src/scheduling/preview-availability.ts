/**
 * preview-availability.ts — previewAvailability: advisory read-only preview of
 * whether a candidate window falls within each resource's operating-hours windows.
 * (Slice AV1.2)
 *
 * GUARANTEES:
 *   - authz: requireCapability('schedule:create_reservation') — the same gate as
 *     the create it previews (mint NO new cap; mirrors previewTwilight).
 *   - PURE PREVIEW: no INSERT/UPDATE/DELETE, no audit row.
 *   - Uses loadAvailabilityContext (RLS-scoped) + evaluateAvailabilityGate per
 *     resource via runAvailabilityGate (evaluated in 'warn' so any hit surfaces).
 *   - Returns per-resource { resolvedCount, wouldViolate, hits }.
 *
 * NOT A WRITE GATE: advisory only. The authoritative gate is gatedCreateOccurrence.
 *
 * IMPORTANT (AV1.2 semantics): the preview is INDEPENDENT of the enabled flag and
 * the mode — it always reports what the operating-hours windows say (wouldViolate =
 * "the candidate falls outside the resource's operating-hours union"). This lets the
 * UI surface an "outside operating hours" indicator even before the operator turns
 * the gate on. The config's enabled/mode only governs the WRITE-path behaviour
 * (warn vs block vs inert) in gatedCreateOccurrence, not this read-only indicator.
 *
 * TWO CALLING FORMS:
 *   previewAvailability(session, input)                  — app code.
 *   previewAvailabilityWithDb(db, session, input, opts?) — tests; inject pglite.
 */

import type { AnyDb } from '@aeroops/db';
import type { AvailabilityHit } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import {
  ValidationError,
  loadAvailabilityContext,
  runAvailabilityGate,
  makeApiZonedToUtcResolver,
} from './internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PreviewAvailabilityInput {
  resourceIds: string[];
  startAt: Date;
  endAt: Date;
}

export interface PreviewAvailabilityResourceReport {
  resourceId: string;
  /** true iff this resource has operating-hours windows (gate is NOT inert here). */
  hasWindows: boolean;
  /**
   * true iff the candidate window falls (partly) outside this resource's
   * operating-hours union. Always false when the resource has no windows (inert).
   */
  wouldViolate: boolean;
  /** The uncovered sub-interval(s), in chronological order. Empty when within hours. */
  hits: AvailabilityHit[];
}

export interface PreviewAvailabilityResult {
  perResource: PreviewAvailabilityResourceReport[];
}

/** Validate + normalize input; throws ValidationError on any failure. */
function parsePreviewAvailabilityInput(raw: unknown): PreviewAvailabilityInput {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('[scheduling] invalid previewAvailability input');
  }
  const r = raw as Record<string, unknown>;

  const startAt = r['startAt'];
  const endAt = r['endAt'];
  if (!(startAt instanceof Date) || Number.isNaN(startAt.getTime())) {
    throw new ValidationError('[scheduling] startAt must be a valid Date');
  }
  if (!(endAt instanceof Date) || Number.isNaN(endAt.getTime())) {
    throw new ValidationError('[scheduling] endAt must be a valid Date');
  }
  if (endAt.getTime() <= startAt.getTime()) {
    throw new ValidationError('[scheduling] endAt must be strictly after startAt');
  }

  const rawIds = r['resourceIds'];
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new ValidationError('[scheduling] resourceIds must be a non-empty array of UUIDs');
  }
  for (const id of rawIds) {
    if (typeof id !== 'string' || !UUID_RE.test(id)) {
      throw new ValidationError('[scheduling] each resourceId must be a UUID');
    }
  }
  const seen = new Set<string>();
  const resourceIds: string[] = [];
  for (const id of rawIds as string[]) {
    if (!seen.has(id)) { seen.add(id); resourceIds.push(id); }
  }

  return { startAt, endAt, resourceIds };
}

async function _previewAvailabilityImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<PreviewAvailabilityResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'schedule:create_reservation');

  // 2. VALIDATE.
  const { startAt, endAt, resourceIds } = parsePreviewAvailabilityInput(input);

  // 3. Read-only availability context + per-resource gate evaluation (RLS-scoped).
  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // Force a 'warn'-mode evaluation regardless of the operator's configured mode,
    // and INDEPENDENT of the enabled flag — the preview is advisory + mode-agnostic.
    const ctx = await loadAvailabilityContext(
      tx,
      sess.orgId,
      resourceIds,
      startAt.getTime(),
      endAt.getTime(),
      makeApiZonedToUtcResolver(),
      { enabled: true, mode: 'warn' },
    );

    const perResource: PreviewAvailabilityResourceReport[] = ctx.perResource.map((r) => {
      const { warnings, blocked } = runAvailabilityGate(
        { config: { enabled: true, mode: 'warn' }, perResource: [r] },
        startAt.getTime(),
        endAt.getTime(),
      );
      const hits = [...warnings, ...blocked];
      return {
        resourceId: r.resourceId,
        hasWindows: r.resolved !== null,
        wouldViolate: hits.length > 0,
        hits,
      };
    });

    return { perResource };
  });
}

/**
 * previewAvailability — advisory operating-hours preview for a candidate window.
 * Writes nothing; never the sole write guard. Independent of the enabled flag.
 *
 * @param session - AppSession; null/undefined → UnauthenticatedError.
 * @param input   - { resourceIds, startAt, endAt }.
 * @throws  UnauthenticatedError | ForbiddenError | ValidationError.
 */
export async function previewAvailability(
  session: AppSession | null | undefined,
  input: PreviewAvailabilityInput,
): Promise<PreviewAvailabilityResult> {
  const db = await getDb();
  return _previewAvailabilityImpl(db, session, input);
}

/** previewAvailabilityWithDb — test form; inject a pglite client. */
export async function previewAvailabilityWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: PreviewAvailabilityInput,
): Promise<PreviewAvailabilityResult> {
  return _previewAvailabilityImpl(db, session, input);
}
