/**
 * get-aircraft-detail.ts — Full aircraft detail aggregation (Slice 5.2).
 *
 * getAircraftDetail — returns all facets for a single aircraft in one org context:
 *   identity + home-base name/icao; grounding; open-squawk count + recent squawks ≤10;
 *   last-10 dispatch (incl. voided) + current meters (latest closed ticket's _in);
 *   upcoming reservations ≤10.
 *
 * GUARANTEES:
 *   - requireCapability('fleet:access') FIRST.
 *   - org_id from session only; cross-org id → not_found (never a 500, never a peek).
 *   - kind !== 'aircraft' → not_found.
 *   - ~5 queries inside ONE withSessionOrgContextWithDb call (no N+1).
 *   - RLS-scoped throughout; org_id never taken from caller input.
 *
 * TWO CALLING FORMS:
 *   getAircraftDetail(session, { resourceId })          — app code.
 *   getAircraftDetailWithDb(db, session, { resourceId }) — tests.
 */
import { z } from 'zod';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { assembleAircraftDetail } from './internal.js';
import type { AircraftDetail } from './types.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const getAircraftDetailInputSchema = z.object({
  resourceId: z.string().regex(UUID_RE, { message: 'resourceId must be a UUID' }),
});

export type GetAircraftDetailInput = z.infer<typeof getAircraftDetailInputSchema>;

// ─── Result type ──────────────────────────────────────────────────────────────

export type GetAircraftDetailResult =
  | { ok: true; aircraft: AircraftDetail }
  | { ok: false; reason: 'not_found' };

// ─── Shared implementation ────────────────────────────────────────────────────

async function _getAircraftDetailImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<GetAircraftDetailResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'fleet:access');

  // 2. VALIDATE.
  const parsed = getAircraftDetailInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[fleet] invalid getAircraftDetail input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { resourceId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // 3–9. Aggregate all facets via shared helper (same queries, same limits,
    //      same null-meter rule as the post-update re-read in updateAircraft).
    const aircraft = await assembleAircraftDetail(tx, resourceId);

    // not_found when invisible (cross-org RLS blocks) OR kind !== 'aircraft'.
    if (!aircraft) {
      return { ok: false, reason: 'not_found' };
    }

    return { ok: true, aircraft };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getAircraftDetail(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GetAircraftDetailResult> {
  const db = await getDb();
  return _getAircraftDetailImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getAircraftDetailWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GetAircraftDetailResult> {
  return _getAircraftDetailImpl(db, session, input);
}
