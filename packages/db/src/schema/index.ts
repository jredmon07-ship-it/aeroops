/**
 * Schema barrel — re-exports all tables, enums, and inferred model types.
 *
 * Tenant-scoped tables (RLS ENABLE + FORCE in migration):
 *   org, location, appUser (table: app_user), membership, auditLog (table: audit_log),
 *   authCredential (table: auth_credential),
 *   resource, reservation, reservationResource (table: reservation_resource),
 *   bookingPolicy (table: booking_policy), resourceBlackout (table: resource_blackout),
 *   reservationSeries (table: reservation_series) — Slice 2b / ADR-0006
 *   dispatchTicket (table: dispatch_ticket) — Slice 3a / ADR-0007
 *   squawk (table: squawk) — Slice 3b / ADR-0008
 *   aircraftGrounding (table: aircraft_grounding) — Slice 3b / ADR-0008
 *   memberTag (table: member_tag) — Slice 6.1 / People (migration 0008)
 *     FREE-TEXT operator labels only. [VERIFY-6-A]: no FAA/currency/medical meaning.
 *   dispatchRequirement (table: dispatch_requirement) — Slice 3c / ADR-0009 (migration 0009)
 *     FREE-TEXT per-aircraft dispatch tags. [VERIFY-3c-A]: no computed currency/medical.
 *   dispatchConfig (table: dispatch_config) — Slice 3c / ADR-0009 (migration 0009)
 *     Per-org gate config. [VERIFY-3c-MONEY]: balance_check_enabled is a stub flag only.
 *   scheduleOptimizationRun (table: schedule_optimization_run) — Slice 4b (migration 0011)
 *     Audited optimizer-run header. Per-proposal outcomes reconstructable from each
 *     created reservation's audit row (metadata.optimizationRunId). NO money.
 *   course (table: course) — Slice T1.1 / Training (migration 0012)
 *     Operator-defined training curriculum. Title + status are operator content only.
 *     NO FAA/Part-141 determination computed. [VERIFY-T1-B]
 *   courseLesson (table: course_lesson) — Slice T1.1 / Training (migration 0012)
 *     Ordered lesson within a course. stage_label = FREE-TEXT operator grouping,
 *     NOT a Part-141 stage. [VERIFY-T1-G]
 *   enrollment (table: enrollment) — Slice T1.1 / Training (migration 0012)
 *     Student enrolled in a course. 'completed' = operator flag, NOT graduation.
 *     [VERIFY-T1-B/F/E]
 *   lessonRecord (table: lesson_record) — Slice T1.1 / Training (migration 0012)
 *     WRITE-ONCE lesson-completion fact. Voided via tombstone, never deleted.
 *     grade_label = FREE-TEXT only, NOT a computed ACS/Part-61/141 verdict.
 *     [VERIFY-T1-A/C/D]
 *   workOrder (table: work_order) — Slice M1.1 / Maintenance (migration 0013)
 *     Maintenance task on an aircraft; optionally linked to a squawk.
 *     work_performed/sign_off_notes = FREE-TEXT operator data ONLY.
 *     NO FAA/Part-43/airworthiness determination computed. [VERIFY-M1-A/B/C/D/E]
 *     signed_off_by ON DELETE SET NULL: durable "who" in audit_log, NOT column.
 *   resourceAvailabilityWindow (table: resource_availability_window) — Slice AV1.1 (migration 0014)
 *     Per-resource weekly operating-hours windows (add/remove-only, NO updated_at).
 *     day_of_week int (1=Mon,7=Sun); start_minute/end_minute in minutes-since-midnight;
 *     end_minute > start_minute forbids overnight wrap (two rows required).
 *     [VERIFY-AV1-A]: OPERATOR scheduling/operating-hours data ONLY.
 *     NO FAA duty-time/rest/Part-117/135/121 determination computed.
 *     dispatch_config.availability_constraint_enabled/mode control the gate.
 *   bookingRequest (table: booking_request) — Slice PB1.1 / ADR-0013 (migration 0015)
 *     Unauthenticated inbound booking enquiry from the public booking page (/book/[slug]).
 *     Requester fields (name/email/phone/requested_start/end/aircraft_type_pref/message)
 *     are WRITE-ONCE (set at INSERT, never mutated). Triage fields (status/handled_by/
 *     handled_at/triage_notes) are staff-mutable via booking:triage cap.
 *     ADR-0013: org_id is set ONLY from resolveOrgBySlug (never from client input);
 *     booking_request_insert WITH CHECK is the RLS backstop for the anon write path.
 *     Composite FK (handled_by,org_id) → app_user ON DELETE SET NULL (handled_by) —
 *     column-list syntax: org_id is NEVER nulled; durable "who" in audit_log.
 *     NO requester FK (anon by design); NO reservation FK; NO money.
 *     [VERIFY-PB1-COMP-1]: PII lead-data retention/purge posture before public launch.
 *     [VERIFY-PB1-SEC-1]: edge rate-limiter/WAF+CAPTCHA before public exposure.
 *
 * Platform/control-plane tables (NO RLS):
 *   plan, subscription
 */

// Enums (derived from @aeroops/core tuples — DB and app types cannot drift)
export {
  membershipRole,
  resourceKind,
  reservationStatus,
  recurrenceFreq,
  recurrenceEndKind,
  reservationSeriesStatus,
  dispatchStatus,
  groundingState,
  squawkStatus,
  squawkSeverity,
  enrollmentStatus,
  lessonRecordStatus,
  workOrderStatus,
} from './enums.js';

// Tenant-scoped tables
export { org } from './org.js';
export type { OrgSelect, OrgInsert } from './org.js';

export { location } from './location.js';
export type { LocationSelect, LocationInsert } from './location.js';

export { appUser, users } from './user.js';
export type { AppUserSelect, AppUserInsert } from './user.js';

export { membership } from './membership.js';
export type { MembershipSelect, MembershipInsert } from './membership.js';

export { auditLog } from './audit-log.js';
export type { AuditLogSelect, AuditLogInsert } from './audit-log.js';

export { authCredential } from './auth-credential.js';
export type { AuthCredentialSelect, AuthCredentialInsert } from './auth-credential.js';

// Platform / control-plane tables (NOT org-scoped)
export { plan } from './plan.js';
export type { PlanSelect, PlanInsert } from './plan.js';

export { subscription } from './subscription.js';
export type { SubscriptionSelect, SubscriptionInsert } from './subscription.js';

// Scheduling — tenant-scoped (SCHED-1 / Phase 1 Slice 1)
export { resource } from './resource.js';
export type { ResourceSelect, ResourceInsert } from './resource.js';

export { reservation } from './reservation.js';
export type { ReservationSelect, ReservationInsert } from './reservation.js';

export { reservationResource, tstzrange } from './reservation-resource.js';
export type {
  ReservationResourceSelect,
  ReservationResourceInsert,
} from './reservation-resource.js';

// Booking policies — tenant-scoped (SCHED-2a / Phase 1 Slice 2a)
// NOTE: required_tags is DEFERRED (scope amendment 2026-06-16) — no required_tags column.
export { bookingPolicy } from './booking-policy.js';
export type { BookingPolicySelect, BookingPolicyInsert } from './booking-policy.js';

export { resourceBlackout } from './resource-blackout.js';
export type { ResourceBlackoutSelect, ResourceBlackoutInsert } from './resource-blackout.js';

// Recurring reservations — tenant-scoped (SCHED-2b / Phase 1 Slice 2b, ADR-0006)
export { reservationSeries } from './reservation-series.js';
export type {
  ReservationSeriesSelect,
  ReservationSeriesInsert,
} from './reservation-series.js';

// Dispatch tickets — tenant-scoped (DISPATCH-3a / Phase 1 Slice 3a, ADR-0007)
export { dispatchTicket } from './dispatch-ticket.js';
export type {
  DispatchTicketSelect,
  DispatchTicketInsert,
} from './dispatch-ticket.js';

// Squawks + grounding — tenant-scoped (DISPATCH-3b / Phase 1 Slice 3b, ADR-0008)
export { squawk } from './squawk.js';
export type { SquawkSelect, SquawkInsert } from './squawk.js';

export { aircraftGrounding } from './aircraft-grounding.js';
export type {
  AircraftGroundingSelect,
  AircraftGroundingInsert,
} from './aircraft-grounding.js';

// People / Members — tenant-scoped (Slice 6.1 / migration 0008)
// member_tag: FREE-TEXT operator labels only. [VERIFY-6-A]: no FAA/currency/
// medical/cert/eligibility meaning is computed or enforced from a tag.
export { memberTag } from './member-tag.js';
export type { MemberTagSelect, MemberTagInsert } from './member-tag.js';

// Dispatch gate — tenant-scoped (Slice 3c / ADR-0009 / migration 0009)
// dispatch_requirement: FREE-TEXT per-aircraft required tags for check-out.
//   [VERIFY-3c-A]: no computed currency/medical/endorsement/FAA meaning.
// dispatch_config: per-org gate settings.
//   [VERIFY-3c-MONEY]: balance_check_enabled is a Phase-1 stub flag ONLY;
//   no dollar value, minimum balance, or payment data in this table.
export { dispatchRequirement } from './dispatch-requirement.js';
export type {
  DispatchRequirementSelect,
  DispatchRequirementInsert,
} from './dispatch-requirement.js';

export { dispatchConfig } from './dispatch-config.js';
export type { DispatchConfigSelect, DispatchConfigInsert } from './dispatch-config.js';

// Optimizer run — tenant-scoped (Slice 4b / migration 0011)
// Audited run header: demand set + constraints snapshot + seed + outcome counts.
// Per-proposal outcomes live in each reservation's audit_log metadata.optimizationRunId.
// NO money: schedules time only, never prices.
export { scheduleOptimizationRun } from './schedule-optimization-run.js';
export type {
  ScheduleOptimizationRunSelect,
  ScheduleOptimizationRunInsert,
} from './schedule-optimization-run.js';

// Training — tenant-scoped (Slice T1.1 / ADR-0011 / migration 0012)
// course: operator-defined curriculum. NO FAA/Part-141 determination. [VERIFY-T1-B]
// courseLesson: ordered lesson. stage_label = FREE-TEXT grouping, NOT a Part-141 stage.
//   [VERIFY-T1-G]. Hard-delete blocked when lesson_records exist (has_records + RESTRICT FK).
// enrollment: student enrolled in course. 'completed' = operator flag, NOT graduation.
//   [VERIFY-T1-B/F/E]. No re-enroll after withdraw in T1.
// lessonRecord: WRITE-ONCE completion fact. Void = tombstone; never deleted.
//   grade_label = FREE-TEXT only, NOT ACS/Part-61/141 verdict. [VERIFY-T1-A/C/D].
//   voided_by SET NULL: durable "who" in audit_log, NOT the column.
export { course } from './course.js';
export type { CourseSelect, CourseInsert } from './course.js';

export { courseLesson } from './course-lesson.js';
export type { CourseLessonSelect, CourseLessonInsert } from './course-lesson.js';

export { enrollment } from './enrollment.js';
export type { EnrollmentSelect, EnrollmentInsert } from './enrollment.js';

export { lessonRecord } from './lesson-record.js';
export type { LessonRecordSelect, LessonRecordInsert } from './lesson-record.js';

// Maintenance work orders — tenant-scoped (Slice M1.1 / migration 0013)
// work_order: maintenance task on an aircraft/resource; optionally squawk-linked.
//   work_performed + sign_off_notes = FREE-TEXT operator data ONLY.
//   NO FAA/Part-43/airworthiness/RTS/annual/100-hr/AD/MEL determination.
//   [VERIFY-M1-A]: completed ≠ RTS. [VERIFY-M1-B]: no reopen from terminal.
//   [VERIFY-M1-C]: signed_off_by SET NULL; durable "who" in audit_log, NOT column.
//   [VERIFY-M1-D]: unground = operator affirmative action, NOT a computed clearance.
//   [VERIFY-M1-E]: open WOs surface on fleet detail (fleet:access gate).
export { workOrder } from './work-order.js';
export type { WorkOrderSelect, WorkOrderInsert } from './work-order.js';

// Resource availability windows — tenant-scoped (Slice AV1.1 / migration 0014)
// resource_availability_window: per-resource weekly operating-hours windows.
//   add/remove-only (no updated_at); day_of_week 1–7 (ISO 8601, Mon=1, Sun=7);
//   start_minute 0–1439, end_minute 1–1440, end_minute > start_minute (no overnight wrap).
//   Composite FK (resource_id,org_id) → resource RESTRICT; (created_by,org_id) → app_user RESTRICT.
//   Natural-key UNIQUE (resource_id,day_of_week,start_minute,end_minute).
//   Gate enabled by dispatch_config.availability_constraint_enabled (default false → INERT).
//   [VERIFY-AV1-A]: OPERATOR scheduling/operating-hours data ONLY.
//   NO FAA duty-time/rest-period/Part-117/135/121 determination computed.
export { resourceAvailabilityWindow } from './resource-availability-window.js';
export type {
  ResourceAvailabilityWindowSelect,
  ResourceAvailabilityWindowInsert,
} from './resource-availability-window.js';

// Public booking requests — tenant-scoped (Slice PB1.1 / ADR-0013 / migration 0015)
// booking_request: unauthenticated inbound enquiry from the public booking page.
//   org_id set ONLY from resolveOrgBySlug (never client input); RLS INSERT WITH CHECK
//   is the ADR-0013 backstop for the anon write path. Requester fields write-once.
//   status: new | contacted | converted | declined; booking_request_handled_shape_check.
//   Composite FK (handled_by,org_id) → app_user ON DELETE SET NULL (handled_by) —
//   column-list: org_id NEVER nulled; durable "who" in audit_log.
//   NO requester FK (anon); NO reservation FK; NO money.
//   [VERIFY-PB1-COMP-1]: PII retention/purge posture before public launch.
//   [VERIFY-PB1-SEC-1]: edge rate-limiter/WAF+CAPTCHA before public exposure.
export { bookingRequest } from './booking-request.js';
export type {
  BookingRequestSelect,
  BookingRequestInsert,
} from './booking-request.js';
