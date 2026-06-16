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
