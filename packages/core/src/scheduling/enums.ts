/**
 * scheduling/enums.ts — single source of truth for scheduling enum types.
 *
 * Mirrors the MEMBERSHIP_ROLES pattern (see ../roles.ts): both @aeroops/db
 * (pgEnum) and the application layer import these tuples so the Drizzle schema
 * and the runtime can never drift. The schema-engineer builds the pgEnums FROM
 * these `as const` tuples.
 *
 * No I/O, framework-agnostic — safe to import anywhere.
 */

/**
 * RESOURCE_KINDS — canonical list of bookable resource kinds.
 *
 * Order matters: Postgres enum types preserve insertion order and some tooling
 * displays them in this order. Do NOT reorder without a migration.
 *
 * FORWARD-COMPAT: Slice 1 only populates `aircraft` + `instructor`, but the
 * tuple intentionally includes all five so adding sim/room/vehicle is a pure
 * data change, not an enum/migration change (ADR-0004).
 */
export const RESOURCE_KINDS = [
  'aircraft',
  'instructor',
  'sim',
  'room',
  'vehicle',
] as const;

/** Union type of all valid resource-kind strings. */
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/**
 * RESERVATION_STATUSES — canonical list of reservation statuses.
 *
 * Order matters (see RESOURCE_KINDS). Slice 1 supports the full set:
 * conflict detection only considers `booked` rows; `cancelled` rows never
 * collide (the EXCLUDE constraint is `WHERE status='booked'`, ADR-0004).
 */
export const RESERVATION_STATUSES = ['booked', 'cancelled'] as const;

/** Union type of all valid reservation-status strings. */
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/**
 * isResourceKind — runtime type guard for ResourceKind.
 *
 * Returns true only when `value` is a string that is an exact member of
 * RESOURCE_KINDS. Returns false for non-strings, unknown/future kind strings,
 * and prototype-chain keys ('constructor', 'toString', '__proto__', etc.).
 * Mirrors isMembershipRole; use at untrusted boundaries.
 *
 * @param value - Any unknown value from an untrusted source.
 * @returns `true` if value is a valid ResourceKind, `false` otherwise.
 */
export function isResourceKind(value: unknown): value is ResourceKind {
  return typeof value === 'string' && (RESOURCE_KINDS as readonly string[]).includes(value);
}

/**
 * isReservationStatus — runtime type guard for ReservationStatus.
 *
 * Same contract as isResourceKind, over RESERVATION_STATUSES.
 *
 * @param value - Any unknown value from an untrusted source.
 * @returns `true` if value is a valid ReservationStatus, `false` otherwise.
 */
export function isReservationStatus(value: unknown): value is ReservationStatus {
  return (
    typeof value === 'string' && (RESERVATION_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * POLICY_VIOLATION_KINDS — canonical list of booking-policy violation kinds.
 *
 * Order matters and is the deterministic surfacing order of the policy
 * predicate (see scheduling/policy.ts): duration → advance → lead → blackout.
 *
 * RUNTIME/CORE ONLY — this is NOT a pgEnum and is NEVER stored. A policy
 * violation is an advisory, computed-at-evaluation result of
 * `evaluateBookingPolicy`, not a persisted column (ADR-0005 invariant 2).
 *
 * SCOPE AMENDMENT (2026-06-16, maintainer): Slice 2a ships FOUR rules only.
 * Required-tags / booking eligibility (and its `'missing_required_tag'` kind)
 * is DEFERRED to a follow-up slice — do NOT add it here until then.
 */
export const POLICY_VIOLATION_KINDS = [
  'max_duration_exceeded',
  'too_far_in_advance',
  'insufficient_lead_time',
  'blackout_overlap',
] as const;

/** Union type of all valid policy-violation-kind strings. */
export type PolicyViolationKind = (typeof POLICY_VIOLATION_KINDS)[number];

/**
 * isPolicyViolationKind — runtime type guard for PolicyViolationKind.
 *
 * Same contract as isResourceKind, over POLICY_VIOLATION_KINDS. Returns true
 * only for an exact string member; false for non-strings, future/unknown
 * kinds, and prototype-chain keys.
 *
 * @param value - Any unknown value from an untrusted source.
 * @returns `true` if value is a valid PolicyViolationKind, `false` otherwise.
 */
export function isPolicyViolationKind(value: unknown): value is PolicyViolationKind {
  return (
    typeof value === 'string' && (POLICY_VIOLATION_KINDS as readonly string[]).includes(value)
  );
}

/**
 * RECURRENCE_FREQS — recurrence frequency (Slice 2b, ADR-0006).
 *
 * Order matters (pgEnum insertion order; never reorder without a migration).
 * The schema-engineer builds the `recurrence_freq` pgEnum FROM this tuple.
 *
 * SCOPE: Slice 2b supports WEEKLY only (daily = the all-7-weekdays subset of
 * weekly). The tuple is single-valued on purpose; adding 'monthly'/'yearly'
 * later is a data change, not an engine change — but is explicitly OUT of 2b.
 */
export const RECURRENCE_FREQS = ['weekly'] as const;

/** Union type of all valid recurrence-frequency strings. */
export type RecurrenceFreq = (typeof RECURRENCE_FREQS)[number];

/**
 * RECURRENCE_END_KINDS — how a recurrence series is bounded (ADR-0006).
 *
 * Exactly one of `count` (number of occurrences, ≤52) or `until` (a local
 * calendar end date) bounds a series; this enum discriminates which.
 * Backs the `recurrence_end_kind` pgEnum.
 */
export const RECURRENCE_END_KINDS = ['count', 'until'] as const;

/** Union type of all valid recurrence-end-kind strings. */
export type RecurrenceEndKind = (typeof RECURRENCE_END_KINDS)[number];

/**
 * RESERVATION_SERIES_STATUSES — lifecycle status of a recurrence series.
 *
 * 'active' on create; 'cancelled' after cancelSeries (which also cancels the
 * future booked occurrences). Backs the `reservation_series_status` pgEnum.
 */
export const RESERVATION_SERIES_STATUSES = ['active', 'cancelled'] as const;

/** Union type of all valid reservation-series-status strings. */
export type ReservationSeriesStatus = (typeof RESERVATION_SERIES_STATUSES)[number];

/** Runtime guard for RecurrenceFreq (same contract as isResourceKind). */
export function isRecurrenceFreq(value: unknown): value is RecurrenceFreq {
  return typeof value === 'string' && (RECURRENCE_FREQS as readonly string[]).includes(value);
}

/** Runtime guard for RecurrenceEndKind. */
export function isRecurrenceEndKind(value: unknown): value is RecurrenceEndKind {
  return typeof value === 'string' && (RECURRENCE_END_KINDS as readonly string[]).includes(value);
}

/** Runtime guard for ReservationSeriesStatus. */
export function isReservationSeriesStatus(value: unknown): value is ReservationSeriesStatus {
  return (
    typeof value === 'string' &&
    (RESERVATION_SERIES_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * WORK_ORDER_STATUSES — lifecycle status of a maintenance work order (Slice M1.1).
 *
 * Order matters (pgEnum insertion order; never reorder without a migration). The
 * schema-engineer builds the `work_order_status` pgEnum FROM this tuple.
 *
 * 'open'        = work order created; aircraft may still be dispatched (grounding
 *                 is a separate explicit operator action, not computed from WO status).
 * 'in_progress' = work underway (operator/mechanic has started; mutable intermediate).
 * 'completed'   = work done + sign-off recorded (terminal; requires signed_off_at).
 *                 completed ≠ FAA return-to-service. [VERIFY-M1-A]
 * 'cancelled'   = work order abandoned before completion (terminal; requires cancelled_at).
 *                 does NOT resolve a linked squawk or unground the aircraft. [VERIFY-M1-B]
 *
 * Valid transitions (API-enforced, NOT a DB pair-CHECK):
 *   open → in_progress | open → completed | open → cancelled
 *   in_progress → completed | in_progress → cancelled
 *   completed / cancelled are terminal — no reopen path. [VERIFY-M1-B]
 */
export const WORK_ORDER_STATUSES = ['open', 'in_progress', 'completed', 'cancelled'] as const;

/** Union type of all valid work-order-status strings. */
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

/**
 * isWorkOrderStatus — runtime type guard for WorkOrderStatus.
 *
 * Returns true only when `value` is a string that is an exact member of
 * WORK_ORDER_STATUSES. Returns false for non-strings, unknown/future status
 * strings, and prototype-chain keys. Same contract as isResourceKind.
 *
 * @param value - Any unknown value from an untrusted source.
 * @returns `true` if value is a valid WorkOrderStatus, `false` otherwise.
 */
export function isWorkOrderStatus(value: unknown): value is WorkOrderStatus {
  return typeof value === 'string' && (WORK_ORDER_STATUSES as readonly string[]).includes(value);
}

/**
 * DISPATCH_STATUSES — lifecycle status of a dispatch ticket (Slice 3a, ADR-0007).
 *
 * Order matters (pgEnum insertion order; never reorder without a migration). The
 * schema-engineer builds the `dispatch_status` pgEnum FROM this tuple.
 *
 * 'open' = checked out (aircraft released; meters OUT recorded; blocks a second
 * open on the same aircraft via the partial-UNIQUE backstop). 'closed' = checked
 * in (meters IN + derived flight time recorded; immutable). 'voided' = a mistaken
 * check-out abandoned while open (audited tombstone; frees the aircraft). Meters
 * are write-once; the only transitions are open→closed and open→voided (ADR-0007
 * invariant 1).
 */
export const DISPATCH_STATUSES = ['open', 'closed', 'voided'] as const;

/** Union type of all valid dispatch-status strings. */
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

/** Runtime guard for DispatchStatus (same contract as isResourceKind). */
export function isDispatchStatus(value: unknown): value is DispatchStatus {
  return typeof value === 'string' && (DISPATCH_STATUSES as readonly string[]).includes(value);
}
