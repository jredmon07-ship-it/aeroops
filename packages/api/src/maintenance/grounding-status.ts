/**
 * grounding-status.ts — getGroundingStatus read path.
 * (DISPATCH-3b, ADR-0008 §2.2)
 *
 * GUARANTEES:
 *   - authz first: requireCapability('maintenance:access') BEFORE any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - validates input with Zod → ValidationError on malformed/empty resourceIds.
 *   - one DISTINCT ON query via loadGroundingProbe — no N+1.
 *   - returns Map<resourceId, GroundingStatusView> — every id keyed.
 *   - absent (no events) → grounded:false, all nulls.
 *
 * TWO CALLING FORMS:
 *   getGroundingStatus(session, input)        — app code; uses getDb() internally.
 *   getGroundingStatusWithDb(db, session, in) — tests; inject pglite client.
 */
import { z } from 'zod';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { loadGroundingProbe } from './internal.js';
import type { GroundingStatusView } from './types.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Input schema ─────────────────────────────────────────────────────────────

const getGroundingStatusInputSchema = z.object({
  resourceIds: z
    .array(z.string().regex(UUID_RE, { message: 'resourceIds must be UUIDs' }))
    .min(1, { message: 'At least one resourceId is required' }),
});

export type GetGroundingStatusInput = z.infer<typeof getGroundingStatusInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _getGroundingStatusImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<Map<string, GroundingStatusView>> {
  // 1. AUTHZ FIRST — before any data access.
  requireCapability(session, 'maintenance:access');

  // 2. VALIDATE — Zod parse.
  const parsed = getGroundingStatusInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[maintenance] invalid getGroundingStatus input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { resourceIds } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const probe = await loadGroundingProbe(tx, resourceIds);

    // Map GroundingProbeEntry → GroundingStatusView (same shape — no transformation needed).
    const result = new Map<string, GroundingStatusView>();
    for (const [resourceId, entry] of probe.entries()) {
      result.set(resourceId, {
        grounded:   entry.grounded,
        reason:     entry.reason,
        since:      entry.since,
        groundedBy: entry.groundedBy,
        eventId:    entry.eventId,
      });
    }
    return result;
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getGroundingStatus(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<Map<string, GroundingStatusView>> {
  const db = await getDb();
  return _getGroundingStatusImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getGroundingStatusWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<Map<string, GroundingStatusView>> {
  return _getGroundingStatusImpl(db, session, input);
}
