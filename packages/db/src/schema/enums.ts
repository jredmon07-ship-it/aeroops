/**
 * Postgres enum types shared across tables.
 *
 * MEMBERSHIP_ROLES is imported from @aeroops/core as the single
 * source of truth so that the DB enum and application-layer types
 * cannot drift apart.
 *
 * RESOURCE_KINDS and RESERVATION_STATUSES are likewise imported from
 * @aeroops/core as the single source of truth for scheduling enum types
 * (ADR-0004). The core module re-exports them from scheduling/enums.ts.
 *
 * RECURRENCE_FREQS, RECURRENCE_END_KINDS, RESERVATION_SERIES_STATUSES are
 * imported from @aeroops/core for the Slice 2b recurrence schema (ADR-0006).
 * The DB pgEnums and application-layer types are guaranteed in sync.
 *
 * DISPATCH_STATUSES is imported from @aeroops/core for the Slice 3a dispatch
 * schema (ADR-0007). The DB pgEnum and application-layer types are guaranteed
 * in sync. Three values: 'open' (checked out), 'closed' (checked in),
 * 'voided' (mistaken check-out abandoned while open).
 *
 * GROUNDING_STATES, SQUAWK_STATUSES, SQUAWK_SEVERITIES are imported from
 * @aeroops/core for the Slice 3b squawks + grounding schema (ADR-0008).
 * The DB pgEnums and application-layer types are guaranteed in sync.
 * grounding_state: operator-set event state (never a computed reg verdict).
 * squawk_status: lifecycle status; 'deferred' is operator triage, NOT an
 *   MEL/airworthiness construct. [VERIFY-3b-A]
 * squawk_severity: operator triage label; 'grounding' is a UI hint only —
 *   it does NOT auto-ground. [VERIFY-3b-B]
 *
 * ENROLLMENT_STATUSES, LESSON_RECORD_STATUSES are imported from @aeroops/core
 * for the Slice T1.1 training schema (ADR-0011). The DB pgEnums and application-
 * layer types are guaranteed in sync.
 * enrollment_status: operator lifecycle flag only. 'completed' ≠ Part-141
 *   graduation or regulatory completion. [VERIFY-T1-B]
 * lesson_record_status: append-only audit posture. 'voided' = tombstone,
 *   NOT a deletion or e-signature removal. [VERIFY-T1-C]
 *
 * WORK_ORDER_STATUSES is imported from @aeroops/core for the Slice M1.1
 * maintenance work-order schema. The DB pgEnum and application-layer types
 * are guaranteed in sync.
 * work_order_status: four values: 'open', 'in_progress', 'completed',
 *   'cancelled'. completed ≠ FAA return-to-service. [VERIFY-M1-A]
 *   Terminal states (completed/cancelled) have no reopen path. [VERIFY-M1-B]
 */
import { pgEnum } from 'drizzle-orm/pg-core';
import {
  MEMBERSHIP_ROLES,
  RESOURCE_KINDS,
  RESERVATION_STATUSES,
  RECURRENCE_FREQS,
  RECURRENCE_END_KINDS,
  RESERVATION_SERIES_STATUSES,
  DISPATCH_STATUSES,
  GROUNDING_STATES,
  SQUAWK_STATUSES,
  SQUAWK_SEVERITIES,
  ENROLLMENT_STATUSES,
  LESSON_RECORD_STATUSES,
  WORK_ORDER_STATUSES,
} from '@aeroops/core';

/**
 * membershipRole — Postgres enum `membership_role`.
 * Derived from the @aeroops/core MEMBERSHIP_ROLES tuple so the
 * application type and DB type are guaranteed in sync.
 */
export const membershipRole = pgEnum('membership_role', MEMBERSHIP_ROLES);

/**
 * resourceKind — Postgres enum `resource_kind`.
 * Derived from the @aeroops/core RESOURCE_KINDS tuple (scheduling/enums.ts)
 * so the application type and DB type are guaranteed in sync.
 * Slice 1 only populates aircraft + instructor; sim/room/vehicle are
 * forward-compatible data changes, not schema changes (ADR-0004).
 */
export const resourceKind = pgEnum('resource_kind', RESOURCE_KINDS);

/**
 * reservationStatus — Postgres enum `reservation_status`.
 * Derived from the @aeroops/core RESERVATION_STATUSES tuple.
 * The EXCLUDE constraint only fires for status='booked' rows.
 */
export const reservationStatus = pgEnum('reservation_status', RESERVATION_STATUSES);

/**
 * recurrenceFreq — Postgres enum `recurrence_freq`.
 * Derived from the @aeroops/core RECURRENCE_FREQS tuple (ADR-0006).
 * Slice 2b supports 'weekly' only; the single-value tuple is intentional —
 * adding 'monthly'/'yearly' later is a data change, not an enum change.
 */
export const recurrenceFreq = pgEnum('recurrence_freq', RECURRENCE_FREQS);

/**
 * recurrenceEndKind — Postgres enum `recurrence_end_kind`.
 * Derived from the @aeroops/core RECURRENCE_END_KINDS tuple (ADR-0006).
 * Exactly one of 'count' (number of occurrences, ≤52) or 'until' (local
 * calendar end date) bounds a series; the end_shape_check CHECK constraint
 * enforces the XOR invariant.
 */
export const recurrenceEndKind = pgEnum('recurrence_end_kind', RECURRENCE_END_KINDS);

/**
 * reservationSeriesStatus — Postgres enum `reservation_series_status`.
 * Derived from the @aeroops/core RESERVATION_SERIES_STATUSES tuple (ADR-0006).
 * 'active' on create; 'cancelled' after cancelSeries.
 */
export const reservationSeriesStatus = pgEnum(
  'reservation_series_status',
  RESERVATION_SERIES_STATUSES,
);

/**
 * dispatchStatus — Postgres enum `dispatch_status`.
 * Derived from the @aeroops/core DISPATCH_STATUSES tuple (ADR-0007, Slice 3a).
 * Three values: 'open' (checked out, aircraft released), 'closed' (checked in,
 * meters IN + derived flight time recorded), 'voided' (mistaken check-out
 * abandoned while open — audited tombstone, frees the aircraft).
 *
 * The only valid transitions are open→closed and open→voided. Meters are
 * write-once; closed→voided correction is NOT in 3a (deferred to a future
 * append-only dispatch_ticket_correction table — ADR-0007 §1).
 *
 * The partial UNIQUE index on (resource_id) WHERE (status='open') enforces the
 * one-open-per-aircraft backstop using only 'open' — 'closed' and 'voided'
 * rows never participate (ADR-0007 §2).
 */
export const dispatchStatus = pgEnum('dispatch_status', DISPATCH_STATUSES);

/**
 * groundingState — Postgres enum `grounding_state`.
 * Derived from the @aeroops/core GROUNDING_STATES tuple (ADR-0008, Slice 3b).
 * Two values: 'grounded' (operator set not available for dispatch),
 * 'released' (grounding cleared). Current state per aircraft = the state of
 * its latest event row (append-only event table; no silent mutation).
 * This is operator data, NEVER a computed FAR/Part-91/43 reg verdict.
 */
export const groundingState = pgEnum('grounding_state', GROUNDING_STATES);

/**
 * squawkStatus — Postgres enum `squawk_status`.
 * Derived from the @aeroops/core SQUAWK_STATUSES tuple (ADR-0008, Slice 3b).
 * Three values: 'open' (reported; unaddressed), 'deferred' (acknowledged,
 * noted for later — operator triage status only, NOT an MEL/airworthiness
 * construct [VERIFY-3b-A]), 'resolved' (addressed and signed off).
 * Transitions: open→resolved | open→deferred. No reopen path ([VERIFY-3b-D]).
 */
export const squawkStatus = pgEnum('squawk_status', SQUAWK_STATUSES);

/**
 * squawkSeverity — Postgres enum `squawk_severity`.
 * Derived from the @aeroops/core SQUAWK_SEVERITIES tuple (ADR-0008, Slice 3b).
 * Four values: 'low', 'medium', 'high', 'grounding'. This is an operator
 * triage label, not a computed airworthiness class. 'grounding' is a UI hint
 * only — it does NOT auto-ground the aircraft. [VERIFY-3b-B]
 */
export const squawkSeverity = pgEnum('squawk_severity', SQUAWK_SEVERITIES);

/**
 * enrollmentStatus — Postgres enum `enrollment_status`.
 * Derived from the @aeroops/core ENROLLMENT_STATUSES tuple (ADR-0011, Slice T1.1).
 * Three values: 'active' (enrolled and participating), 'completed' (operator-
 * toggled content-state flag — NOT a Part-141 graduation or reg determination
 * [VERIFY-T1-B]), 'withdrawn' (roster management only — no re-enroll restriction
 * in T1 [VERIFY-T1-F]).
 * Valid transitions (API-enforced): active→completed | active→withdrawn only.
 */
export const enrollmentStatus = pgEnum('enrollment_status', ENROLLMENT_STATUSES);

/**
 * lessonRecordStatus — Postgres enum `lesson_record_status`.
 * Derived from the @aeroops/core LESSON_RECORD_STATUSES tuple (ADR-0011, Slice T1.1).
 * Two values: 'recorded' (the lesson-completion fact, write-once at INSERT),
 * 'voided' (append-only tombstone — the record is preserved, not deleted).
 * voided_by SET NULL on user hard-delete: the durable "who" lives in audit_log.
 * [VERIFY-T1-C]: this void-tombstone is NOT an e-signature removal.
 */
export const lessonRecordStatus = pgEnum('lesson_record_status', LESSON_RECORD_STATUSES);

/**
 * workOrderStatus — Postgres enum `work_order_status`.
 * Derived from the @aeroops/core WORK_ORDER_STATUSES tuple (Slice M1.1).
 * Four values: 'open' (created, not yet started), 'in_progress' (work underway),
 * 'completed' (sign-off recorded; terminal), 'cancelled' (abandoned; terminal).
 *
 * completed ≠ FAA return-to-service / §43.9 / §43.11 determination. [VERIFY-M1-A]
 * No reopen path from completed or cancelled — terminal states. [VERIFY-M1-B]
 * signed_off_by ON DELETE SET NULL ("signed_off_by"): durable "who" in audit_log,
 * NOT the column. [VERIFY-M1-C]
 *
 * Valid transitions (API-enforced; NOT a DB pair-CHECK):
 *   open→in_progress | open→completed | open→cancelled
 *   in_progress→completed | in_progress→cancelled
 */
export const workOrderStatus = pgEnum('work_order_status', WORK_ORDER_STATUSES);
