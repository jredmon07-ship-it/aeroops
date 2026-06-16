/**
 * @aeroops/core — shared domain types and business rules.
 * No I/O, no runtime dependencies.
 */
export { MEMBERSHIP_ROLES, ROLE_LABELS, isMembershipRole } from './roles.js';
export type { MembershipRole } from './roles.js';

export {
  CAPABILITIES,
  ROLE_CAPABILITIES,
  can,
  capabilitiesForRole,
} from './capabilities.js';
export type { Capability } from './capabilities.js';

export {
  RESOURCE_KINDS,
  RESERVATION_STATUSES,
  POLICY_VIOLATION_KINDS,
  isResourceKind,
  isReservationStatus,
  isPolicyViolationKind,
} from './scheduling/enums.js';
export type {
  ResourceKind,
  ReservationStatus,
  PolicyViolationKind,
} from './scheduling/enums.js';

export { intervalsOverlap, findConflicts } from './scheduling/overlap.js';
export type { ConflictCandidate, ExistingBooking } from './scheduling/overlap.js';

export { evaluateBookingPolicy } from './scheduling/policy.js';
export type {
  BookingPolicy,
  BlackoutWindow,
  PolicyCandidate,
  PolicyViolation,
  MaxDurationExceededViolation,
  TooFarInAdvanceViolation,
  InsufficientLeadTimeViolation,
  BlackoutOverlapViolation,
} from './scheduling/policy.js';
