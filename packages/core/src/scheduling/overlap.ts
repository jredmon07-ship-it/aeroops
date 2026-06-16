/**
 * scheduling/overlap.ts — pure conflict-detection predicate.
 *
 * The `@aeroops/core` half of ADR-0004. No I/O, no Drizzle, no React. This is
 * ADVISORY only: it powers the pre-submit conflict preview and the rich
 * conflict result naming the colliding resources. It is NEVER the sole gate on
 * a write — the authoritative no-double-book guarantee is the Postgres EXCLUDE
 * constraint on the reservation_resource join (built later by the
 * schema/db/api builders).
 *
 * HALF-OPEN SEMANTICS: every interval is `[start, end)` (start inclusive, end
 * exclusive), expressed in epoch milliseconds. This matches the DB's
 * `tstzrange(start, end, '[)')` and the UI, so preview and DB verdict cannot
 * disagree (ADR-0004 invariant 6). Adjacency is NOT a conflict.
 */

/**
 * intervalsOverlap — do two half-open `[start, end)` intervals overlap?
 *
 * Inputs are epoch milliseconds. Returns `aStart < bEnd && bStart < aEnd`.
 *
 * Touching endpoints do NOT overlap: if `aEnd === bStart` or `bEnd === aStart`,
 * the intervals are adjacent, not overlapping, and this returns false — exactly
 * what half-open `[start, end)` means (a back-to-back booking is legal).
 *
 * PRECONDITION (caller-guaranteed): `start < end`. The DB enforces this with a
 * `CHECK end_at > start_at`. We do NOT throw on a degenerate input. Instead, a
 * degenerate interval where `start >= end` is treated as the EMPTY set and
 * never overlaps anything: if `aStart >= aEnd` or `bStart >= bEnd`, the
 * `aStart < bEnd && bStart < aEnd` expression cannot be satisfied for the empty
 * side in the normal case, but to be unambiguous and keep the function total
 * and pure we short-circuit empty intervals to `false`. This keeps the
 * predicate safe to call from the UI preview on partially-entered forms.
 *
 * @param aStart - epoch ms, start of interval A (inclusive)
 * @param aEnd   - epoch ms, end of interval A (exclusive)
 * @param bStart - epoch ms, start of interval B (inclusive)
 * @param bEnd   - epoch ms, end of interval B (exclusive)
 * @returns true iff A and B share at least one instant t with
 *          max(aStart,bStart) <= t < min(aEnd,bEnd).
 */
export function intervalsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  // Degenerate (empty) intervals never overlap. Documented precondition is
  // start < end; we stay total and pure rather than throwing.
  if (aStart >= aEnd || bStart >= bEnd) return false;
  return aStart < bEnd && bStart < aEnd;
}

/** A proposed booking under conflict evaluation. May hold multiple resources. */
export interface ConflictCandidate {
  /** The resourceIds this booking would hold (aircraft + instructor, etc.). */
  readonly resourceIds: readonly string[];
  /** epoch ms, start (inclusive). */
  readonly start: number;
  /** epoch ms, end (exclusive). */
  readonly end: number;
}

/** An existing (already-booked) reservation-resource window. */
export interface ExistingBooking {
  /** The single resourceId this row holds. */
  readonly resourceId: string;
  /** epoch ms, start (inclusive). */
  readonly start: number;
  /** epoch ms, end (exclusive). */
  readonly end: number;
}

/**
 * findConflicts — which of the candidate's resources collide with existing
 * bookings?
 *
 * Returns the DISTINCT set of `candidate.resourceIds` that share a resource
 * with at least one `existing` booking AND whose windows overlap (half-open).
 * The result preserves the order of first appearance in `candidate.resourceIds`
 * and contains no duplicates.
 *
 * Pure: no I/O, no mutation of inputs. Powers the rich conflict result and the
 * UI preview; the caller (db/api) supplies `existing` from a tenant-scoped,
 * `status = 'booked'` query inside `withOrgContext`. Callers are responsible
 * for org-scoping `existing` (resource_ids are globally unique and belong to
 * exactly one org per ADR-0004, so this function is org-agnostic by design).
 *
 * @param candidate - the proposed booking (resourceIds + window)
 * @param existing  - already-booked resource windows to check against
 * @returns distinct candidate resourceIds that conflict; [] if none
 */
export function findConflicts(
  candidate: ConflictCandidate,
  existing: ReadonlyArray<ExistingBooking>,
): string[] {
  const conflicting = new Set<string>();

  for (const resourceId of candidate.resourceIds) {
    if (conflicting.has(resourceId)) continue;
    for (const booking of existing) {
      if (booking.resourceId !== resourceId) continue;
      if (intervalsOverlap(candidate.start, candidate.end, booking.start, booking.end)) {
        conflicting.add(resourceId);
        break;
      }
    }
  }

  // Preserve first-appearance order of candidate.resourceIds, no duplicates.
  const seen = new Set<string>();
  const result: string[] = [];
  for (const resourceId of candidate.resourceIds) {
    if (conflicting.has(resourceId) && !seen.has(resourceId)) {
      seen.add(resourceId);
      result.push(resourceId);
    }
  }
  return result;
}
