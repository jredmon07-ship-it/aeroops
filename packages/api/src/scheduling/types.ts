/**
 * scheduling/types.ts — public result/IO types for the reservation
 * persistence layer (SCHED-1, ADR-0004). Framework-agnostic; no I/O.
 *
 * These are the contract the backend-engineer (resource CRUD + day view) and
 * the frontend (drag-and-drop preview + submit) build against. The functions
 * live in create-reservation.ts / cancel-reservation.ts / check-conflicts.ts.
 *
 * DESIGN POSTURE:
 *   - A *conflict* is a normal, expected outcome — it is returned as a
 *     discriminated-union value `{ ok: false, reason: 'conflict', ... }`, NOT
 *     thrown. The UI renders it as "this slot is taken".
 *   - A *validation* failure (end<=start, no resources, inactive/wrong-kind/
 *     cross-org resource) is a programmer/UX error and is THROWN as a
 *     ValidationError — distinct from a conflict so the caller can tell them
 *     apart (ADR-0004: conflict ≠ validation).
 *   - authz / auth failures are thrown as ForbiddenError / UnauthenticatedError
 *     (from @aeroops/api) before any data access.
 */

/**
 * ConflictHit — one colliding (resourceId × existing booked window) pair.
 *
 * Built from the conflict-probe query joined to the resource row for the
 * human-readable name. `start`/`end` are the EXISTING (already-booked)
 * window's bounds (extracted from the colliding join row's `during`), so the
 * UI can say "N12345 is booked 10:00–11:00".
 */
export interface ConflictHit {
  /** The resource that is double-booked (globally-unique uuid). */
  resourceId: string;
  /** Human-readable resource name (resource.display_name) for the message. */
  resourceDisplayName: string;
  /** The id of the EXISTING reservation that holds the colliding window. */
  reservationId: string;
  /** Lower bound of the existing booked window (inclusive). */
  start: Date;
  /** Upper bound of the existing booked window (exclusive). */
  end: Date;
}

/** The reservation row shape returned on a successful create. */
export interface CreatedReservation {
  id: string;
  orgId: string;
  startAt: Date;
  endAt: Date;
  status: 'booked';
  notes: string | null;
  createdBy: string;
  /** The resourceIds that were booked (de-duplicated, in request order). */
  resourceIds: string[];
}

/**
 * CreateReservationResult — discriminated union.
 *   ok:true  → the reservation + all its join rows were committed.
 *   ok:false → at least one requested resource collided; NOTHING was written
 *              (all-or-nothing). `conflicts` names every colliding resource.
 */
export type CreateReservationResult =
  | { ok: true; reservation: CreatedReservation }
  | { ok: false; reason: 'conflict'; conflicts: ConflictHit[] };

/**
 * CancelResult — discriminated union.
 *   ok:true                      → reservation is cancelled (idempotent: a
 *                                  no-op on an already-cancelled reservation
 *                                  still returns ok:true).
 *   ok:false reason:'not_found'  → no reservation with that id is visible in
 *                                  the caller's org (RLS-scoped).
 */
export type CancelResult = { ok: true } | { ok: false; reason: 'not_found' };
