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
