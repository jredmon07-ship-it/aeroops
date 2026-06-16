/**
 * check-conflicts.ts — the advisory, READ-ONLY pre-submit conflict preview
 * (SCHED-1, ADR-0004 "Layered, not either/or"). It runs the same overlap probe
 * the create path uses and returns the colliding existing windows WITHOUT
 * writing anything.
 *
 * GUARANTEES:
 *   - authz first: requireCapability('schedule:create_reservation') BEFORE any
 *     data access — a preview gates the same as the create it previews.
 *   - org_id comes ONLY from the session (withSessionOrgContextWithDb); RLS
 *     scopes the probe rows to the caller's org.
 *   - PURE PREVIEW: no INSERT/UPDATE/DELETE, no audit row. A single SELECT via
 *     runConflictProbe; the transaction commits nothing.
 *   - the half-open `[)` overlap semantics come ENTIRELY from runConflictProbe
 *     (same query the create path pre-checks with) — not reimplemented here.
 *
 * NOT A WRITE GATE. This is advisory only and MUST NEVER be the sole guard
 * against double-booking. The authoritative no-double-book guarantee is the
 * EXCLUDE constraint enforced inside createReservation; a clean preview here can
 * still race a concurrent commit, which the constraint catches at INSERT time.
 * The EXCLUDE constraint is the truth — this is UX.
 *
 * TWO CALLING FORMS (mirrors create-reservation):
 *   checkConflicts(session, input)        — app code; uses getDb() internally.
 *   checkConflictsWithDb(db, session, in)  — tests; inject pglite client.
 */
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import type { ConflictHit } from './types.js';
import { parseReservationWindow, runConflictProbe } from './internal.js';

/**
 * Input to checkConflicts — the same window + resource shape as create, minus
 * notes (irrelevant to a preview; ignored if present).
 */
export interface CheckConflictsInput {
  startAt: Date;
  endAt: Date;
  resourceIds: string[];
}

/**
 * CheckConflictsResult — discriminated union (mirrors CreateReservationResult's
 * conflict posture).
 *   ok:true  → the window is clear for every requested resource.
 *   ok:false → at least one resource collides; `conflicts` names every existing
 *              colliding window. NOTHING was written either way.
 */
export type CheckConflictsResult =
  | { ok: true }
  | { ok: false; reason: 'conflict'; conflicts: ConflictHit[] };

// ─── Shared implementation ────────────────────────────────────────────────────

async function _checkConflictsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: CheckConflictsInput,
): Promise<CheckConflictsResult> {
  // 1. AUTHZ FIRST — before any data access. Throws Forbidden/Unauthenticated.
  requireCapability(session, 'schedule:create_reservation');

  // 2. VALIDATE — endAt>startAt, >=1 resource, de-dup. Throws ValidationError
  //    (distinct from a conflict result). Reuses the create schema; `notes` (if
  //    passed) is parsed and discarded.
  const { startAt, endAt, resourceIds } = parseReservationWindow(input);

  // 3. ONE transaction scoped to session.orgId. Pure SELECT — commits nothing.
  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    const hits = await runConflictProbe(tx, startAt, endAt, resourceIds);
    if (hits.length > 0) {
      return { ok: false, reason: 'conflict', conflicts: hits };
    }
    return { ok: true };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * checkConflicts — advisory pre-submit overlap preview for the authenticated
 * org. Writes nothing; never the sole double-book guard (ADR-0004).
 *
 * @param session - AppSession from auth(); null/undefined → UnauthenticatedError.
 * @param input   - window + resourceIds (notes ignored).
 * @returns CheckConflictsResult — ok:true when clear, or ok:false reason:'conflict'
 *          with every colliding existing window.
 * @throws  UnauthenticatedError | ForbiddenError | ValidationError.
 */
export async function checkConflicts(
  session: AppSession | null | undefined,
  input: CheckConflictsInput,
): Promise<CheckConflictsResult> {
  const db = await getDb();
  return _checkConflictsImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/** checkConflictsWithDb — test form; inject a pglite client. */
export async function checkConflictsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: CheckConflictsInput,
): Promise<CheckConflictsResult> {
  return _checkConflictsImpl(db, session, input);
}
