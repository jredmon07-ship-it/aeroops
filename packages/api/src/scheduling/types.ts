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
 *   - A *policy violation* is a returned value `{ ok: false, reason: 'policy' }`,
 *     never thrown (ADR-0005 invariant 9). Enriched with resourceDisplayName at
 *     this layer ([DEFER-G] = yes); core stays resourceId-only.
 *   - authz / auth failures are thrown as ForbiddenError / UnauthenticatedError
 *     (from @aeroops/api) before any data access.
 *
 * ADDITIVE EXTENSION (SCHED-2a / ADR-0005):
 *   CreateReservationResult gains two new arms ('policy', 'conflict_and_policy').
 *   The existing 'conflict' arm is BYTE-IDENTICAL — no existing consumer breaks.
 *   CheckConflictsResult extended with same two new arms in check-conflicts.ts.
 */

import type { PolicyViolation } from '@aeroops/core';

// Re-export PolicyViolation (sourced from @aeroops/core) so API callers do not
// need to depend on @aeroops/core directly.
export type { PolicyViolation };

/**
 * PolicyViolationView — core PolicyViolation enriched with resourceDisplayName
 * at the API layer (ADR-0005 [DEFER-G]). Core stays resourceId-only; this view
 * is what the UI and API test consumers see.
 */
export type PolicyViolationView = PolicyViolation & {
  /** Human-readable resource name (resource.display_name). */
  resourceDisplayName: string;
};

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
 * CreateReservationResult — discriminated union (SCHED-1 arms BYTE-IDENTICAL).
 *
 *   ok:true                         → reservation + join rows committed.
 *   ok:false reason:'conflict'      → at least one resource collided (FROZEN Slice-1 arm).
 *                                     Nothing written. conflicts[] names every hit.
 *   ok:false reason:'policy'        → policy gate refused; no conflict. (Slice-2a)
 *                                     Nothing written. violations[] names every rule.
 *   ok:false reason:'conflict_and_policy' → both gates fired. (Slice-2a)
 *                                     Nothing written. Both arrays populated.
 *
 * Back-compat: callers checking `reason === 'conflict'` keep working unchanged.
 */
export type CreateReservationResult =
  | { ok: true; reservation: CreatedReservation }
  | { ok: false; reason: 'conflict'; conflicts: ConflictHit[] }
  | { ok: false; reason: 'policy'; violations: PolicyViolationView[] }
  | { ok: false; reason: 'conflict_and_policy'; conflicts: ConflictHit[]; violations: PolicyViolationView[] };

/**
 * CancelResult — discriminated union.
 *   ok:true                      → reservation is cancelled (idempotent: a
 *                                  no-op on an already-cancelled reservation
 *                                  still returns ok:true).
 *   ok:false reason:'not_found'  → no reservation with that id is visible in
 *                                  the caller's org (RLS-scoped).
 */
export type CancelResult = { ok: true } | { ok: false; reason: 'not_found' };
