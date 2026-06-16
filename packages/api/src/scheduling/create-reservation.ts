/**
 * create-reservation.ts — the single sanctioned write path for reservations
 * (SCHED-1, ADR-0004 invariant 2). NOTHING else inserts reservation /
 * reservation_resource rows.
 *
 * GUARANTEES:
 *   - authz first: requireCapability('schedule:create_reservation') BEFORE any
 *     data access.
 *   - org_id comes ONLY from the session (withSessionOrgContext).
 *   - all-or-nothing: a reservation with N resources inserts N join rows in ONE
 *     transaction; if ANY resource collides, the whole thing is rejected and
 *     NO row is written (the free resources are NOT booked).
 *   - the EXCLUDE constraint is the authoritative race backstop: we pre-check
 *     with the overlap probe for a rich message, but if a concurrent commit
 *     wins the race the INSERT raises 23P01 — we catch it, re-probe, and return
 *     the same rich conflict result (ADR-0004 catch-and-requery).
 *   - every successful create writes ONE audit_log row (reservations are
 *     records — no silent mutation).
 *
 * TWO CALLING FORMS (mirrors get-dashboard-summary):
 *   createReservation(session, input)        — app code; uses getDb() internally.
 *   createReservationWithDb(db, session, in)  — tests; inject pglite client.
 */
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AnyDb } from '@aeroops/db';
import type { AppSession } from '../auth/types.js';
import type { CreateReservationResult } from './types.js';
import {
  ValidationError,
  parseReservationWindow,
  gatedCreateOccurrence,
} from './internal.js';

/** Input to createReservation. */
export interface CreateReservationInput {
  startAt: Date;
  endAt: Date;
  resourceIds: string[];
  notes?: string;
}

/**
 * CreateReservationOptions — internal options bag.
 * `now` is injected (epoch ms) for deterministic tests; defaults to Date.now()
 * in the app-code form. See ADR-0005 invariant 2 (pure core, injected clock).
 */
interface CreateReservationOptions {
  now?: number;
}

// ─── Shared implementation ────────────────────────────────────────────────────

/**
 * _createReservationImpl — thin wrapper: validate → open tx → delegate to the
 * shared gatedCreateOccurrence helper (ADR-0006 §3.0 refactor).
 *
 * All per-occurrence logic (resource validation, conflict pre-check, policy
 * probe, refusal precedence, INSERT, 23P01 catch) lives in gatedCreateOccurrence
 * (internal.ts) and is shared with createSeries. Single-create behaviour is
 * BYTE-IDENTICAL to the pre-refactor implementation.
 */
async function _createReservationImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: CreateReservationInput,
  opts?: CreateReservationOptions,
): Promise<CreateReservationResult> {
  // Capture `now` once at impl top. Default to Date.now(); injectable for tests
  // (ADR-0005 invariant 2 — core stays pure, clock injected at this boundary).
  const now = opts?.now ?? Date.now();

  // 1. AUTHZ FIRST — before any data access. Throws Forbidden/Unauthenticated.
  requireCapability(session, 'schedule:create_reservation');

  // 2. VALIDATE — endAt>startAt, >=1 resource, de-dup. Throws ValidationError
  //    (distinct from a conflict result).
  const { startAt, endAt, resourceIds, notes } = parseReservationWindow(input);

  // 3. ONE transaction scoped to session.orgId (READ COMMITTED; EXCLUDE is the
  //    race backstop per ADR-0004 — no SERIALIZABLE retry loop needed).
  //    Delegate the entire gated body to gatedCreateOccurrence (ADR-0006 §3.0).
  //    seriesId is not set (single-create: series_id IS NULL, byte-identical).
  return withSessionOrgContextWithDb(db, session, (sess, tx) =>
    gatedCreateOccurrence(tx, sess, db, { startAt, endAt, resourceIds, notes }, now),
  );
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * createReservation — race-safe reservation create for the authenticated org.
 *
 * @param session - AppSession from auth(); null/undefined → UnauthenticatedError.
 * @param input   - window + resourceIds (+ optional notes).
 * @returns CreateReservationResult — ok:true with the reservation, or
 *          ok:false reason:'conflict'|'policy'|'conflict_and_policy'.
 * @throws  UnauthenticatedError | ForbiddenError | ValidationError.
 */
export async function createReservation(
  session: AppSession | null | undefined,
  input: CreateReservationInput,
): Promise<CreateReservationResult> {
  const db = await getDb();
  return _createReservationImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/**
 * createReservationWithDb — test form; inject a pglite client.
 * `opts.now` accepts an injected epoch-ms clock for deterministic policy tests.
 */
export async function createReservationWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: CreateReservationInput,
  opts?: { now?: number },
): Promise<CreateReservationResult> {
  return _createReservationImpl(db, session, input, opts);
}
