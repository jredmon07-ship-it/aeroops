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
  MAINTENANCE_TRACK_BY,
  METER_BASIS,
  isMaintenanceTrackBy,
  isMeterBasis,
} from './maintenance/enums.js';
export type { MaintenanceTrackBy, MeterBasis } from './maintenance/enums.js';

export {
  evaluateMaintenanceDue,
  MAINTENANCE_DUE_STATUS_RANK,
} from './maintenance/maintenance-due.js';
export type {
  MaintenanceDueItemInput,
  CurrentMetersInput,
  MaintenanceDueStatus,
  MaintenanceDueEvaluation,
} from './maintenance/maintenance-due.js';

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

// ─── Slice AV1.1 — Resource availability windows + pure availability gate ─────
// resolveAvailabilityWindowsToUtc: weekly local windows → UTC [open,close) via an
// INJECTED tz resolver (recurrence.ts seam; DST decision 10: gap-open snaps
// forward, gap-close snaps to gap-start, ambiguous → earlier instant).
// evaluateAvailabilityGate: INERT when no windows; else candidate must be FULLY
// CONTAINED in the UNION of windows, mutually-exclusive warn/block, STRICT
// half-open — symmetric with evaluateTwilightGate. Operator operating-hours data,
// NOT an FAA duty/rest/Part-117 determination ([VERIFY-AV1]). Property-tested.
// DISTINCT type names (ResourceAvailabilityWindow / AvailabilityHit) to avoid
// colliding with the optimizer's existing AvailabilityWindow.
export {
  resolveAvailabilityWindowsToUtc,
  evaluateAvailabilityGate,
} from './scheduling/availability.js';
export type {
  ResourceAvailabilityWindow,
  ResolvedAvailabilityWindow,
  AvailabilityHit,
  AvailabilityGateResult,
} from './scheduling/availability.js';

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

// ─── Slice P2-ESIGN — canonical lesson_record snapshot (tamper-evidence, NOT a signature) ──
// [VERIFY-P2-A]: canonicalLessonRecordSnapshot is a PURE, deterministic, key-order-
// independent serializer. The API layer sha256s its output for lesson_signature.content_hash.
// This is a tamper-evidence digest ONLY — NOT a cryptographic/PKI signature, NOT an
// FAA-recognized digital/electronic signature, and confers no §61/§141 endorsement meaning.
export { canonicalLessonRecordSnapshot } from './training/lesson-record-snapshot.js';
export type { LessonRecordSnapshotInput } from './training/lesson-record-snapshot.js';

// ─── Slice S1.1 — Global search pure helpers ──────────────────────────────────
// escapeLike: escape LIKE metacharacters (\, %, _) — backslash FIRST.
// rankResults / makePrefixComparator: prefix-first then lower(primary) alpha.
// Pure (no I/O). Property-tested in packages/core/src/__tests__/search.test.ts.
export { escapeLike } from './search/escape-like.js';
export { rankResults, makePrefixComparator } from './search/rank-results.js';
export type { Rankable } from './search/rank-results.js';

// ─── Slice A1.1 — Activity feed pure helpers (safety boundary) ────────────────
// summarizeAuditEntry: whitelist-only metadata reader → curated human string.
// activityPath: entity type + id → relative nav path or null.
// Property-tested: no raw metadata, no PII, total + deterministic.
// NO money, NO FAA determination, NO I/O.
export { summarizeAuditEntry, activityPath } from './activity/index.js';
export type { SummarizeAuditEntryInput, ActivityPathInput } from './activity/index.js';

// ─── Slice 4M.2 — Mobile DTOs, mappers, and window schema ─────────────────────
// RN-safe; shared by apps/web route handlers and apps/mobile.
// SECURITY: org_id ABSENT from all DTOs; Dates → ISO strings.
export {
  mobileScheduleWindowSchema,
  toMobileReservationDTO,
  toMobileResourceDTO,
  toMobileAircraftListDTO,
  toMobileSquawkDTO,
  toMobileAircraftDetailDTO,
  toMobileAlertDTO,
} from './mobile/dto.js';
export type {
  MobileScheduleWindow,
  MobileReservationDTO,
  MobileResourceDTO,
  MobileScheduleResponse,
  MobileApiError,
  MobileAircraftListDTO,
  MobileFleetListResponse,
  MobileSquawkDTO,
  MobileSquawksResponse,
  MobileUpcomingReservationDTO,
  MobileAircraftDetailDTO,
  MobileFleetDetailResponse,
  MobileAlertDTO,
  MobileAlertsResponse,
} from './mobile/dto.js';

// ─── Phase-2 B1 — Pure invoice / billing math (integer cents, no Stripe) ────────
// applyRate: line amount = round-half-up(hours × ratePerHourCents) → integer cents.
// computeLineTotal: alias for applyRate (line-total vocabulary).
// computeInvoiceTotals: subtotal = Σ lineTotalCents (exact integer sum); in B1
//   totalCents === subtotalCents (tax/discount seam noted in module-level comment).
// applyPricingGroupDiscount: bps discount helper (B4 seam; NOT wired into totals yet).
// computeCounterSaleLineTotal (Slice P2 — POS): line total = quantity ×
//   unitPriceCents, EXACT integer product (no rounding — both operands are
//   already integers). Consumed by createCounterSale.
// PURE: no I/O, no clock, no Stripe, no DB. Money as INTEGER CENTS only.
// Property-tested (hard guardrail): P1..P17 in __tests__/invoice-math.test.ts;
//   P-CS-1..3 (Slice P2) cover computeCounterSaleLineTotal.
// [VERIFY-B-MONEY-1]: flight_time_hours is the billable basis (ADR-0007, frozen).
export {
  applyRate,
  computeLineTotal,
  computeInvoiceTotals,
  applyPricingGroupDiscount,
  computeCounterSaleLineTotal,
} from './billing/invoice-math.js';
export type { InvoiceLine, InvoiceTotals } from './billing/invoice-math.js';

// ─── Slice B2 — Pure ledger balance math (integer cents, no Stripe) ───────────
// computeBalance: balance = Σ(credit amounts) − Σ(debit amounts). Order-
//   independent, deterministic, integer-closed. Does NOT clamp (a negative
//   balance is a legitimate "member owes money" result).
// PURE: no I/O, no clock, no Stripe, no DB. Money as INTEGER CENTS only.
// Property-tested (hard guardrail): P1..P10 in __tests__/ledger-math.test.ts.
// [VERIFY-B2-MONEY]: consumed ONLY by packages/api/src/billing/real-balance-seam.ts,
//   which is NOT injected into the FROZEN openDispatch() app-code path in this slice.
export { computeBalance } from './billing/ledger-math.js';
export type { LedgerEntryAmount } from './billing/ledger-math.js';

// ─── Fee-passing — Pure ACH pass-through processing-fee math (integer cents) ──
// computeAchPassthroughFeeCents: fee = min(round(baseCents × 0.01), 1500) — the
//   1%-capped-$15 ACH pricing, optionally passed through to the member
//   at checkout when the operator opts in (dispatch_config.pass_ach_fee_to_member).
// PURE: no I/O, no clock, no Stripe, no DB. Money as INTEGER CENTS only.
// Property-tested (hard guardrail): __tests__/fee-math.test.ts.
// MONEY BOUNDARY: computes a QUOTED amount only; moves no money. The ledger
//   credit posts the BASE (see packages/api/src/integrations/stripe/*).
export {
  computeAchPassthroughFeeCents,
  ACH_FEE_RATE,
  ACH_FEE_CAP_CENTS,
} from './billing/fee-math.js';

// ─── Slice B4 — Pure block-time (prepaid package) summary math ───────────────
// aggregateBlockPurchases: Σ hours + Σ amountCents across a member's block
//   purchases. Hours sum via an integer-tenths accumulator (no float drift,
//   mirrors packages/api/src/logbook/internal.ts's buildPilotLog convention).
//   totalAmountCents is integer-closed (property-tested).
// computeEffectiveRateCentsPerHour: price_cents / hours — DISPLAY ONLY,
//   never summed/stored/fed back into money math.
// PURE: no I/O, no clock, no Stripe, no DB. Money as INTEGER CENTS only.
// Property-tested (hard guardrail): __tests__/block-summary-math.test.ts.
export {
  aggregateBlockPurchases,
  computeEffectiveRateCentsPerHour,
} from './billing/block-summary-math.js';
export type { BlockPurchaseAmount, BlockPurchaseTotals } from './billing/block-summary-math.js';

// ─── Financial / AR reporting slice — pure AR-aging bucketer ─────────────────
// ageDaysBetween/classifyAgingBucket/bucketAgingItem/sumAgingBuckets/aggregateAging:
//   buckets an outstanding {balanceCents, asOf, referenceDate} into one of 5 AR-aging
//   tiers (current/1-30/31-60/61-90/90+). See module-level METRIC DEFINITION in
//   billing/ar-aging.ts for the exact day-boundary rule. NEVER throws (a reporting
//   surface must degrade gracefully); integer cents only.
// PURE: no I/O, no clock read internally (asOf is always caller-injected), no Stripe.
// Property-tested (hard guardrail): P1..P6 in __tests__/ar-aging.test.ts.
// [VERIFY-AR-AGING-1]: "age of the oldest unpaid invoice" is a per-account proxy —
//   this system has no per-invoice payment allocation. See getAccountsReceivable
//   (packages/api/src/billing/get-accounts-receivable.ts) for the exact reference-date
//   choice made at the call site.
export {
  ageDaysBetween,
  classifyAgingBucket,
  bucketAgingItem,
  sumAgingBuckets,
  aggregateAging,
  emptyAgingBuckets,
} from './billing/ar-aging.js';
export type {
  AgingBucketKey,
  AgingBuckets,
  AgingItem,
  AgingItemResult,
  AggregateAgingResult,
} from './billing/ar-aging.js';

// ─── Slice PB1.1 — Public booking-request submit schema (ADR-0013) ────────────
// bookingRequestSchema: zod bounds for the unauthenticated public submit.
//   name 1–120, email format ≤254 (lowercased/trimmed), phone? ≤40,
//   requestedStart ISO datetime, requestedEnd? > start, aircraftTypePref? ≤80,
//   message? ≤2000, website honeypot (value accepted here; non-empty → fake-ok
//   in the orchestrator, no DB access).
// SHARED by the public submit API (packages/api) and the public form (apps/web).
// org_id and slug are NEVER in this schema — derived server-side from the URL slug.
export { bookingRequestSchema } from './booking/booking-request-schema.js';
export type { BookingRequestInput } from './booking/booking-request-schema.js';

// ─── Slice P1.7 — Flight Circle data importer (pure CSV + normalize layer) ────
// parseCsv: dependency-free, RFC-4180-ish CSV parser. PURE, never throws —
//   the first thing an operator-uploaded file touches must be robust to
//   arbitrary bytes. No new dependency added (see csv.ts file header).
// guessColumnMapping: best-effort header→field heuristic that pre-fills the
//   operator's column-mapping confirmation step. NEVER assumes a provider's
//   exact column headers are stable.
// looksLikeSalesTransactionsExport: detects a Flight-Circle-style ledger/
//   financial-history export so previewImport can mark it out-of-scope-for-
//   commit (NO ledger/financial-history import in this slice).
// normalizeMemberRow / normalizeAircraftRow: PURE row → typed candidate |
//   skip-reason. dedupeKey = normalized email (members) / tail number
//   (aircraft). NEVER throws on garbage input.
// [VERIFY] no FAA/regulatory meaning attached to any imported field — plain
//   roster/identity import only, same posture as addMember / createResource.
export { parseCsv } from './import/csv.js';
export type { ParsedCsv } from './import/csv.js';

// serializeCsv: pure RFC-4180 CSV serializer, round-trips with parseCsv.
// neutralizeCsvFormula: spreadsheet-injection guard for operator free-text
//   columns (tail/make/model, etc.) — applied by callers, not by serializeCsv
//   itself, so the round-trip property stays clean (Slice P2 logbook export).
export { serializeCsv, neutralizeCsvFormula } from './import/csv-write.js';

export {
  guessColumnMapping,
  looksLikeSalesTransactionsExport,
  MEMBER_FIELDS,
  AIRCRAFT_FIELDS,
} from './import/column-mapping.js';
export type { ImportKind, ImportSource, ColumnMapping } from './import/column-mapping.js';

export { normalizeMemberRow, normalizeAircraftRow } from './import/normalize.js';
export type {
  NormalizeResult,
  MemberCandidate,
  AircraftCandidate,
} from './import/normalize.js';

// ─── Slice P1.4 — iCal / subscribable calendar feeds ─────────────────────────
// buildIcs: PURE RFC-5545 serializer. escapeIcsText / foldLine / formatIcsUtc
//   are exported individually so the property tests can exercise each
//   invariant (escaping, folding, UTC formatting) in isolation as well as
//   through the full buildIcs document. SECURITY-SENSITIVE: this is the one
//   place untrusted operator/member text is embedded into a format with its
//   own line-terminator grammar — see calendar/build-ics.ts header.
export { buildIcs, escapeIcsText, foldLine, formatIcsUtc } from './calendar/build-ics.js';
export type { IcsEvent, BuildIcsOptions } from './calendar/build-ics.js';

// ─── Slice W1 — METAR weather (display-only, informational) ─────────────────
// deriveFlightCategory: PURE flight-category classifier (standard AWC/FAA
//   ceiling+visibility thresholds; worse-of-the-two governs; property-tested
//   for monotonicity). parseMetarJson: the primary path — parses AWC's
//   `/api/data/metar?format=json` element shape. parseMetarText: a defensive
//   raw-text fallback (round-trip property-tested). NEVER a go/no-go,
//   airworthiness, or dispatch determination — advisory only. See
//   docs/specs/slice-weather-metar.md.
export {
  deriveFlightCategory,
  parseMetarJson,
  parseMetarText,
} from './weather/metar.js';
export type { FlightCategory, ParsedMetar, ParseMetarOptions } from './weather/metar.js';

// ─── Org modules — per-org feature toggles + operating-mode presets (0047) ──
// The PURE module registry: which whole areas of the app an operator can turn
//   off (leaner nav for a small flying club), the 'school' | 'club' operating
//   modes, their presets, and display metadata. Enforcement reads ONLY the
//   flags; the mode is a preset label. "Hide, don't destroy" — toggling a
//   module never touches its data. See docs/specs/slice-club-mode.md.
export {
  ORG_MODULES,
  OPERATING_MODES,
  ALL_MODULES_ENABLED,
  OPERATING_MODE_PRESETS,
  ORG_MODULE_META,
  OPERATING_MODE_META,
  isOrgModuleKey,
  isOperatingMode,
  mergeFeatureFlags,
} from './org-modules.js';
export type { OrgModuleKey, OrgFeatureFlags, OperatingMode } from './org-modules.js';
