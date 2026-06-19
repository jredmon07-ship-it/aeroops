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
 *
 * ADDITIVE EXTENSION (SCHED-3b Wave 3b / ADR-0008 §2.3 Option A):
 *   The ok:true arm of CreateReservationResult gains an OPTIONAL
 *   `groundingWarnings?: GroundingHit[]` field. Grounding is WARN-ONLY at create
 *   in 3b — a grounded aircraft does NOT block the create; the warning rides along
 *   on the success result. The field is OPTIONAL and only present when there is at
 *   least one warning, so the ok:true shape is BYTE-IDENTICAL when no aircraft is
 *   grounded and no existing consumer breaks. The refusal arms are UNCHANGED:
 *   grounding is evaluated ONLY on the success path, never on a refusal.
 */

import type { PolicyViolation, GroundingHit, TwilightHit } from '@aeroops/core';

// Re-export PolicyViolation (sourced from @aeroops/core) so API callers do not
// need to depend on @aeroops/core directly.
export type { PolicyViolation };

// Re-export GroundingHit (sourced from @aeroops/core) so API callers do not need
// to depend on @aeroops/core directly. Carried on the ok:true create arms as the
// optional `groundingWarnings` field (Slice 3b Wave 3b, ADR-0008 §2.3 Option A).
export type { GroundingHit };

// Re-export TwilightHit (sourced from @aeroops/core). Slice 4a: carried on the
// ok:true create arms as the optional `twilightWarnings` field (warn mode) AND on
// the new `{ ok:false, reason:'twilight', twilight }` refusal arm (block mode).
export type { TwilightHit };

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
  | {
      ok: true;
      reservation: CreatedReservation;
      groundingWarnings?: GroundingHit[];
      /**
       * Slice 4a (warn mode only): set when the created reservation crosses civil
       * dawn/dusk on an aircraft with home-base coords + twilight enabled. OPTIONAL
       * and only present when non-empty, so the ok:true shape is BYTE-IDENTICAL when
       * the gate is disabled / inert. Exactly like groundingWarnings.
       */
      twilightWarnings?: TwilightHit[];
    }
  | { ok: false; reason: 'conflict'; conflicts: ConflictHit[] }
  | { ok: false; reason: 'policy'; violations: PolicyViolationView[] }
  | { ok: false; reason: 'conflict_and_policy'; conflicts: ConflictHit[]; violations: PolicyViolationView[] }
  // Slice 4a (block mode only): a standalone refusal arm — twilight is NEVER combined
  // with conflict/policy (those four arms above are FROZEN). Evaluated LAST in the
  // precedence chain (conflict_and_policy > policy > conflict > twilight > INSERT).
  // Nothing written, no audit on refusal.
  | { ok: false; reason: 'twilight'; twilight: TwilightHit[] };

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
  /**
   * Set when result is 'created' AND the created occurrence booked a grounded
   * aircraft (Slice 3b Wave 3b, warn-only). Absent when no aircraft is grounded
   * so existing report shapes stay byte-identical.
   */
  groundingWarnings?: GroundingHit[];
  /**
   * Set when result is 'created' AND (warn mode) the occurrence crosses civil
   * dawn/dusk. Additive — absent when the gate is disabled / inert so existing
   * report shapes stay byte-identical.
   */
  twilightWarnings?: TwilightHit[];
  /** Set when result is 'skipped'. */
  reason?: 'conflict' | 'policy' | 'conflict_and_policy' | 'twilight';
  /** Populated when reason includes conflict. */
  conflicts?: ConflictHit[];
  /** Populated when reason includes policy. */
  violations?: PolicyViolationView[];
  /** Populated when reason === 'twilight' (block mode). The dusk/dawn boundary hit(s). */
  twilight?: TwilightHit[];
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
  | {
      ok: true;
      reservation: CreatedReservation;
      groundingWarnings?: GroundingHit[];
      /** Slice 4a (warn mode): set when the new window crosses civil dawn/dusk. Additive. */
      twilightWarnings?: TwilightHit[];
    }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'conflict'; conflicts: ConflictHit[] }
  | { ok: false; reason: 'policy'; violations: PolicyViolationView[] }
  | { ok: false; reason: 'conflict_and_policy'; conflicts: ConflictHit[]; violations: PolicyViolationView[] }
  // Slice 4a (block mode): the target window crosses civil dawn/dusk → refused.
  // The original stays booked + intact (throw-to-rollback). No combination arm.
  | { ok: false; reason: 'twilight'; twilight: TwilightHit[] };

// ─── Slice 4b — Auto-scheduler types (additive; frozen types above unchanged) ──
//
// runAutoSchedule is structurally identical to createSeries: it routes EVERY
// proposal through the FROZEN gatedCreateOccurrence (the single sanctioned write
// path — NO bespoke INSERT). The pure proposer (proposeSchedule, @aeroops/core)
// produces a self-consistent set of windows; the orchestrator re-checks each one
// at commit, so a proposal can still be 'skipped' if reality drifted or a 23P01
// race lost. Partial-create is normal — the result is always ok:true; only
// auth/validation throw. NO money: schedules time only, never prices.

/**
 * DemandInput — one external (pre-validation) auto-schedule demand. Mirrors the
 * pure-core DemandRequest but is the API-layer input shape (validated here, then
 * mapped to DemandRequest before calling proposeSchedule).
 *
 *   id                  — caller-supplied stable id (echoed back in every report).
 *   requiredResourceIds — the resources this session must hold simultaneously
 *                         (de-duplicated; >=1). Each must be a visible, active,
 *                         bookable resource in the session org (validated at commit
 *                         by gatedCreateOccurrence — a bad id surfaces as a skip).
 *   durationMinutes     — session length, > 0.
 *   earliestStartUtcMs  — optional lower bound (epoch ms, inclusive).
 *   latestEndUtcMs      — optional upper bound (epoch ms, inclusive end).
 *   priority            — optional; higher = scheduled first. Default 0.
 *
 * [VERIFY-4b-A]: the demand model carries NO regulatory determination — it is
 * scheduling time + resource ids only. No FAA/currency/medical/Part-61/141 fields.
 */
export interface DemandInput {
  id: string;
  requiredResourceIds: string[];
  durationMinutes: number;
  earliestStartUtcMs?: number;
  latestEndUtcMs?: number;
  priority?: number;
}

/**
 * AutoScheduleInput — the request for runAutoSchedule / previewAutoSchedule.
 *
 *   demands      — the demand set (>=1).
 *   windowStartUtcMs / windowEndUtcMs — the OPERATOR business-hours span the
 *                  optimizer may place sessions within (epoch ms, half-open).
 *                  This is the availability BASE window from which existing
 *                  bookings / blackouts / grounded aircraft are subtracted per
 *                  resource. (No business-hours table exists in Phase 1 — the
 *                  caller passes the operating span explicitly; see the module
 *                  docblock for the default-window decision.)
 *   objective    — 'maximize_utilization' | 'maximize_sessions_scheduled'
 *                  (forward-compat seam; both behave identically today).
 *
 * org_id is NEVER part of the input — it is taken from the session only.
 */
export interface AutoScheduleInput {
  demands: DemandInput[];
  windowStartUtcMs: number;
  windowEndUtcMs: number;
  objective?: 'maximize_utilization' | 'maximize_sessions_scheduled';
}

/**
 * AutoProposalReport — per-proposal outcome in a runAutoSchedule response.
 *
 *   result:'created' → committed via gatedCreateOccurrence. reservationId set.
 *   result:'skipped' → a gate refused at commit (reality drifted / 23P01 race).
 *                      reason + payload set (mirrors the create refusal arms).
 */
export interface AutoProposalReport {
  demandId: string;
  startAt: Date;
  endAt: Date;
  resourceIds: string[];
  result: 'created' | 'skipped';
  /** Set when result is 'created'. */
  reservationId?: string;
  /** Set when result is 'skipped'. */
  reason?: 'conflict' | 'policy' | 'conflict_and_policy' | 'twilight';
  /** Populated when reason includes conflict. */
  conflicts?: ConflictHit[];
  /** Populated when reason includes policy. */
  violations?: PolicyViolationView[];
  /** Populated when reason === 'twilight' (block mode). */
  twilight?: TwilightHit[];
  /** Warn-only twilight warnings on a created proposal (additive). */
  twilightWarnings?: TwilightHit[];
  /** Warn-only grounding warnings on a created proposal (additive). */
  groundingWarnings?: GroundingHit[];
}

/**
 * AutoScheduleResult — always ok:true (partial-create is normal; auth/validation
 * throw). Carries the run header id, every proposal's outcome, the demands the
 * pure proposer could not place at all, and the aggregate counts.
 */
export interface AutoScheduleResult {
  ok: true;
  /** schedule_optimization_run.id for this run (audited run header). */
  runId: string;
  proposals: AutoProposalReport[];
  /** Demands the pure proposer could not place (no proposal was emitted). */
  unschedulable: Array<{ demandId: string; reason: 'no_feasible_window' | 'over_constrained' }>;
  createdCount: number;
  skippedCount: number;
}

/**
 * PreviewAutoProposalReport — read-only per-proposal probe outcome.
 * 'create' / 'skip' (vs the committed 'created'/'skipped') distinguishes the
 * advisory preview from the authoritative commit.
 */
export interface PreviewAutoProposalReport {
  demandId: string;
  startAt: Date;
  endAt: Date;
  resourceIds: string[];
  wouldResult: 'create' | 'skip';
  reason?: 'conflict' | 'policy' | 'conflict_and_policy' | 'twilight';
  conflicts?: ConflictHit[];
  violations?: PolicyViolationView[];
  twilight?: TwilightHit[];
}

/**
 * PreviewAutoScheduleResult — advisory preview of what runAutoSchedule would
 * produce. Nothing is written (no INSERT, no audit, no run header).
 */
export interface PreviewAutoScheduleResult {
  proposals: PreviewAutoProposalReport[];
  unschedulable: Array<{ demandId: string; reason: 'no_feasible_window' | 'over_constrained' }>;
  wouldCreateCount: number;
  wouldSkipCount: number;
}
