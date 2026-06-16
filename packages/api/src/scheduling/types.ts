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

// ─── Slice 2b — Series types (additive; frozen types above unchanged) ─────────

import type { SkippedLocalDate } from '@aeroops/core';
export type { SkippedLocalDate };

/**
 * SeriesRow — the reservation_series row as returned from the API.
 * Mirrors the DB columns; snake_case variants accepted from raw SQL rows.
 */
export interface SeriesRow {
  id: string;
  orgId?: string;
  org_id?: string;
  freq: string;
  weekdays: number[];
  intervalWeeks?: number;
  interval_weeks?: number;
  endKind?: 'count' | 'until';
  end_kind?: 'count' | 'until';
  count?: number | null;
  untilDate?: string | null;
  until_date?: string | null;
  localStartTime?: string;
  local_start_time?: string;
  durationMinutes?: number;
  duration_minutes?: number;
  ianaTz?: string;
  iana_tz?: string;
  resourceIds?: string[];
  resource_ids?: string[];
  notes?: string | null;
  status: 'active' | 'cancelled';
  createdBy?: string;
  created_by?: string;
  cancelledAt?: Date | string | null;
  cancelled_at?: Date | string | null;
  cancelledBy?: string | null;
  cancelled_by?: string | null;
  createdAt?: Date | string;
  created_at?: Date | string;
  updatedAt?: Date | string;
  updated_at?: Date | string;
}

/**
 * CreateSeriesInput — the validated shape used internally after Zod parsing.
 * Raw external input is `unknown`; callers use `createSeries(session, rawInput)`.
 */
export interface CreateSeriesInput {
  weekdays: number[];
  intervalWeeks: number;
  end: { kind: 'count'; count: number } | { kind: 'until'; untilDate: string };
  localStartTime: string;
  durationMinutes: number;
  tz: string;
  resourceIds: string[];
  notes?: string;
}

/**
 * SeriesOccurrenceReport — per-occurrence outcome in a createSeries response.
 *
 *   result:'created'  → occurrence was committed. reservationId is set.
 *   result:'skipped'  → a gate refused the occurrence. reason + payload set.
 *
 * reason + conflicts + violations mirror the CreateReservationResult refusal arms
 * (additive — frozen shapes from Slice 1/2a are reused as-is).
 */
export interface SeriesOccurrenceReport {
  /** 0-based index into the expanded occurrence list. */
  index: number;
  startAt: Date;
  endAt: Date;
  result: 'created' | 'skipped';
  /** Set when result is 'created'. */
  reservationId?: string;
  /** Set when result is 'skipped'. */
  reason?: 'conflict' | 'policy' | 'conflict_and_policy';
  /** Populated when reason includes conflict. */
  conflicts?: ConflictHit[];
  /** Populated when reason includes policy. */
  violations?: PolicyViolationView[];
}

/**
 * CreateSeriesResult — always ok:true (partial-create is normal).
 * auth/validation errors are thrown, not returned.
 */
export interface CreateSeriesResult {
  ok: true;
  series: SeriesRow;
  occurrences: SeriesOccurrenceReport[];
  truncatedByCap: boolean;
  skippedLocalDates: SkippedLocalDate[];
  createdCount: number;
  skippedCount: number;
}

/**
 * CancelSeriesResult — discriminated union.
 *   ok:true                      → series cancelled; cancelledCount future occurrences
 *                                  cancelled. Idempotent on already-cancelled series.
 *   ok:false reason:'not_found'  → series not visible in this org (RLS-scoped).
 */
export type CancelSeriesResult =
  | { ok: true; cancelledCount: number }
  | { ok: false; reason: 'not_found' };

/**
 * PreviewSeriesOccurrenceReport — per-occurrence outcome in a previewSeries response.
 * Read-only (no writes). Uses 'would_create' / 'would_skip' to distinguish from the
 * committed 'created'/'skipped' results of createSeries.
 */
export interface PreviewSeriesOccurrenceReport {
  index: number;
  startAt: Date;
  endAt: Date;
  result: 'would_create' | 'would_skip';
  reason?: 'conflict' | 'policy' | 'conflict_and_policy';
  conflicts?: ConflictHit[];
  violations?: PolicyViolationView[];
}

/**
 * PreviewSeriesResult — advisory preview of what createSeries would produce.
 * Nothing is written.
 */
export interface PreviewSeriesResult {
  occurrences: PreviewSeriesOccurrenceReport[];
  truncatedByCap: boolean;
  skippedLocalDates: SkippedLocalDate[];
  wouldCreateCount: number;
  wouldSkipCount: number;
}

// ─── Slice 2c — Reschedule types (additive; frozen types above unchanged) ─────

/**
 * RescheduleReservationInput — move one reservation to a new window/resources.
 *
 *   reservationId   — the reservation to move.
 *   newStartAt/End  — the new window (validated endAt > startAt).
 *   newResourceIds  — optional; when omitted the reservation keeps its current
 *                     resources (a pure time shift). When provided it REPLACES
 *                     the resource set (de-duplicated, ≥1) — this is how a
 *                     cross-row drag swaps a resource.
 *
 * Notes are preserved from the original; only window + resources are editable.
 */
export interface RescheduleReservationInput {
  reservationId: string;
  newStartAt: Date;
  newEndAt: Date;
  newResourceIds?: string[];
}

/**
 * RescheduleResult — discriminated union (ADR-0006 §6 / Addendum; reuses the
 * FROZEN ConflictHit / PolicyViolationView shapes and CreatedReservation).
 *
 *   ok:true                          → original cancelled + a NEW reservation
 *                                      booked at the new window (series_id NULL —
 *                                      a rescheduled occurrence detaches from its
 *                                      series). `reservation` is the new row.
 *   ok:false reason:'not_found'      → the reservation is not visible in this org
 *                                      (RLS) OR already cancelled. No write.
 *   ok:false reason:'conflict'       → a target gate refused on overlap. The
 *                                      original stays booked + intact (rollback).
 *   ok:false reason:'policy'         → a target gate refused on policy. Intact.
 *   ok:false reason:'conflict_and_policy' → both gates fired. Intact.
 *
 * Atomicity invariant: every ok:false arm leaves the DB byte-identical to the
 * pre-call state — the cancel is rolled back via throw-to-rollback so the
 * original remains booked.
 */
export type RescheduleResult =
  | { ok: true; reservation: CreatedReservation }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'conflict'; conflicts: ConflictHit[] }
  | { ok: false; reason: 'policy'; violations: PolicyViolationView[] }
  | { ok: false; reason: 'conflict_and_policy'; conflicts: ConflictHit[]; violations: PolicyViolationView[] };
