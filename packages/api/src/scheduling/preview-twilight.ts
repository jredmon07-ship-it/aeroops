/**
 * preview-twilight.ts — previewTwilight: advisory read-only preview of whether a
 * candidate window would cross civil dawn/dusk for each aircraft resource.
 * (Slice 4a, civil-twilight)
 *
 * GUARANTEES:
 *   - authz: requireCapability('schedule:create_reservation') — the same gate as
 *     the create it previews (conductor decision 2026-06-19: mint NO new cap).
 *   - PURE PREVIEW: no INSERT/UPDATE/DELETE, no audit row.
 *   - `now`/date injectable via opts so the preview is deterministic.
 *   - Uses loadTwilightContext (RLS-scoped) + evaluateTwilightGate per resource.
 *   - Returns per-resource { events|null, wouldViolate, classification }.
 *
 * NOT A WRITE GATE: advisory only. The authoritative gate is gatedCreateOccurrence.
 *
 * IMPORTANT (Slice 4a semantics): the preview is INDEPENDENT of the enabled flag
 * and the mode — it always reports what the astronomy says (wouldViolate =
 * "ends after civil dusk OR starts before civil dawn"). This lets the UI surface a
 * day/night badge + no-coords hint even before the operator turns the gate on. The
 * config's enabled/mode only governs the WRITE-path behaviour (warn vs block vs
 * inert) in gatedCreateOccurrence, not this read-only indicator.
 *
 * pilotIsExempt is DEFERRED in 4a (always false) — see loadTwilightContext.
 *
 * TWO CALLING FORMS:
 *   previewTwilight(session, input)                  — app code.
 *   previewTwilightWithDb(db, session, input, opts?) — tests; inject pglite.
 */

import type { AnyDb } from '@aeroops/db';
import { evaluateTwilightGate } from '@aeroops/core';
import type { SolarEvents } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError, loadTwilightContext } from './internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PreviewTwilightInput {
  startAt: Date;
  endAt: Date;
  resourceIds: string[];
}

export interface PreviewTwilightResourceReport {
  resourceId: string;
  events: SolarEvents | null;
  /**
   * true iff the candidate window crosses civil dawn/dusk for this resource
   * (events non-null + classification 'normal' + start<dawn OR end>dusk). Always
   * false when events=null or classification≠'normal' (undefined boundary → inert).
   */
  wouldViolate: boolean;
  /** The solar classification, or null when this resource has no events (no coords). */
  classification: SolarEvents['classification'] | null;
}

export interface PreviewTwilightResult {
  perResource: PreviewTwilightResourceReport[];
}

/** Validate + normalize input; throws ValidationError on any failure. */
function parsePreviewTwilightInput(raw: unknown): PreviewTwilightInput {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('[scheduling] invalid previewTwilight input');
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

interface PreviewTwilightOptions {
  now?: number;
}

async function _previewTwilightImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  _opts?: PreviewTwilightOptions,
): Promise<PreviewTwilightResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'schedule:create_reservation');

  // 2. VALIDATE.
  const { startAt, endAt, resourceIds } = parsePreviewTwilightInput(input);

  // 3. Read-only twilight context + per-resource gate evaluation (RLS-scoped).
  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const ctx = await loadTwilightContext(
      tx,
      sess.orgId,
      resourceIds,
      startAt.getTime(),
    );

    const perResource: PreviewTwilightResourceReport[] = ctx.perResource.map((r) => {
      // Evaluate in 'warn' so any hit lands in `warnings` regardless of the
      // operator's configured mode — the preview is advisory and mode-agnostic.
      const res = evaluateTwilightGate({
        candidateStartUtcMs: startAt.getTime(),
        candidateEndUtcMs: endAt.getTime(),
        events: r.events,
        pilotIsExempt: ctx.pilotIsExempt,
        mode: 'warn',
      });
      return {
        resourceId: r.resourceId,
        events: r.events,
        wouldViolate: res.warnings.length > 0 || res.blocked.length > 0,
        classification: r.events?.classification ?? null,
      };
    });

    return { perResource };
  });
}

/**
 * previewTwilight — advisory civil-twilight preview for a candidate window.
 * Writes nothing; never the sole write guard.
 *
 * @param session - AppSession; null/undefined → UnauthenticatedError.
 * @param input   - { startAt, endAt, resourceIds }.
 * @throws  UnauthenticatedError | ForbiddenError | ValidationError.
 */
export async function previewTwilight(
  session: AppSession | null | undefined,
  input: PreviewTwilightInput,
): Promise<PreviewTwilightResult> {
  const db = await getDb();
  return _previewTwilightImpl(db, session, input);
}

/** previewTwilightWithDb — test form; inject a pglite client. */
export async function previewTwilightWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: PreviewTwilightInput,
  opts?: PreviewTwilightOptions,
): Promise<PreviewTwilightResult> {
  return _previewTwilightImpl(db, session, input, opts);
}
