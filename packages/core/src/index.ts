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
  WORK_ORDER_STATUSES,
  DISPATCH_STATUSES,
  isResourceKind,
  isReservationStatus,
  isPolicyViolationKind,
  isRecurrenceFreq,
  isRecurrenceEndKind,
  isReservationSeriesStatus,
  isWorkOrderStatus,
  isDispatchStatus,
} from './scheduling/enums.js';
export type {
  ResourceKind,
  ReservationStatus,
  PolicyViolationKind,
  RecurrenceFreq,
  RecurrenceEndKind,
  ReservationSeriesStatus,
  WorkOrderStatus,
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

export { shouldUngroundForWorkOrder } from './maintenance/work-order-rules.js';
export type {
  GroundingBasisEntry,
  ShouldUngroundResult,
} from './maintenance/work-order-rules.js';

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

// ─── Slice T1.1 — Training enum tuples (single source of truth for DB + app) ──
export {
  ENROLLMENT_STATUSES,
  LESSON_RECORD_STATUSES,
  isEnrollmentStatus,
  isLessonRecordStatus,
} from './training/enums.js';
export type { EnrollmentStatus, LessonRecordStatus } from './training/enums.js';

// ─── Slice T1.2 — Training progress ratio (pure content ratio, NOT a reg determination) ──
// [VERIFY-T1-B]: progress = completedLessons / totalLessons, operator content ratio ONLY.
// NOT a Part-141 80%-completion-rate, graduation, or certificate determination.
export { progressRatioFromCounts } from './training/progress.js';
export type { ProgressRatioResult } from './training/progress.js';

// ─── Slice S1.1 — Global search pure helpers ──────────────────────────────────
// escapeLike: escape LIKE metacharacters (\, %, _) — backslash FIRST.
// rankResults / makePrefixComparator: prefix-first then lower(primary) alpha.
// Pure (no I/O). Property-tested in packages/core/src/__tests__/search.test.ts.
export { escapeLike } from './search/escape-like.js';
export { rankResults, makePrefixComparator } from './search/rank-results.js';
export type { Rankable } from './search/rank-results.js';

// ─── Slice 4M.2 — Mobile DTOs, mappers, and window schema ─────────────────────
// RN-safe; shared by apps/web route handlers and apps/mobile.
// SECURITY: org_id ABSENT from all DTOs; Dates → ISO strings.
export {
  mobileScheduleWindowSchema,
  toMobileReservationDTO,
  toMobileResourceDTO,
} from './mobile/dto.js';
export type {
  MobileScheduleWindow,
  MobileReservationDTO,
  MobileResourceDTO,
  MobileScheduleResponse,
  MobileApiError,
} from './mobile/dto.js';
