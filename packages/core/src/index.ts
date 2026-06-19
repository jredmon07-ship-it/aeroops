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
  RECURRENCE_FREQS,
  RECURRENCE_END_KINDS,
  RESERVATION_SERIES_STATUSES,
  DISPATCH_STATUSES,
  isResourceKind,
  isReservationStatus,
  isPolicyViolationKind,
  isRecurrenceFreq,
  isRecurrenceEndKind,
  isReservationSeriesStatus,
  isDispatchStatus,
} from './scheduling/enums.js';
export type {
  ResourceKind,
  ReservationStatus,
  PolicyViolationKind,
  RecurrenceFreq,
  RecurrenceEndKind,
  ReservationSeriesStatus,
  DispatchStatus,
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

export { deriveFlightTime } from './dispatch/flight-time.js';

export {
  GROUNDING_STATES,
  SQUAWK_STATUSES,
  SQUAWK_SEVERITIES,
  isGroundingState,
  isSquawkStatus,
  isSquawkSeverity,
} from './maintenance/enums.js';
export type {
  GroundingState,
  SquawkStatus,
  SquawkSeverity,
} from './maintenance/enums.js';

export { evaluateGroundingGate } from './maintenance/grounding-gate.js';
export type {
  GroundingHit,
  GroundingGateResult,
} from './maintenance/grounding-gate.js';

export {
  computeSolarEvents,
  evaluateTwilightGate,
} from './scheduling/civil-twilight.js';
export type {
  SolarEvents,
  TwilightHit,
  TwilightGateResult,
} from './scheduling/civil-twilight.js';

export { proposeSchedule } from './scheduling/optimizer.js';
export type {
  DemandRequest,
  AvailabilityWindow,
  PerResourceTwilight,
  ProposedOccurrence,
  ProposalSet,
} from './scheduling/optimizer.js';

export { expandRecurrence } from './scheduling/recurrence.js';
export type {
  ZonedToUtc,
  RecurrenceEnd,
  RecurrenceRule,
  ExpansionOptions,
  Occurrence,
  SkippedLocalDate,
  ExpansionResult,
} from './scheduling/recurrence.js';

export { evaluateEligibilityGate } from './dispatch-gate/eligibility-gate.js';
export type { EligibilityGateResult } from './dispatch-gate/eligibility-gate.js';

export { stubBalanceSeam } from './dispatch-gate/balance-seam.js';
export type {
  BalanceCheckRequest,
  BalanceCheckResult,
  BalanceSeam,
} from './dispatch-gate/balance-seam.js';
