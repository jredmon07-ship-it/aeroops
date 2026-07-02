/**
 * @aeroops/api — public surface.
 *
 * Exports the auth module (Slice 0.2) and RBAC + dashboard module (Slice 0.3).
 * Additional modules (scheduling, billing, etc.) will be added in later slices.
 *
 * BOUNDARY INVARIANT: apps/web must import from '@aeroops/api' only —
 * never from '@aeroops/db' directly. The production DB client is obtained
 * internally via getDb(); apps/web never instantiates a db client.
 *
 * Exported names and their intended callers:
 *
 *   getDb                        — rare: if apps/web needs the raw client
 *                                  for a use case not covered by the helpers.
 *                                  Prefer withSessionOrgContext instead.
 *   buildAuthConfig              — apps/web/auth.ts: NextAuth(buildAuthConfig())
 *   withSessionOrgContext        — apps/web server actions / route handlers
 *   withSessionOrgContextWithDb  — test code only (inject pglite client)
 *   UnauthenticatedError         — apps/web route handlers (instanceof check)
 *   ForbiddenError               — apps/web route handlers (instanceof check)
 *   requireCapability            — every mutation / protected data fetch (THE gate)
 *   hasCapability                — UI/nav only (never the gate)
 *   getDashboardSummary          — apps/web dashboard server component
 *   getDashboardSummaryWithDb    — test code only (inject pglite client)
 *   resolveOrgBySlug             — exposed for tests; not used in apps/web directly
 *   verifyCredential             — exposed for tests; not used in apps/web directly
 *   hashPassword                 — exposed for seed scripts / tests
 */

// ─── DB accessor ──────────────────────────────────────────────────────────────
export { getDb } from './db.js';
export type { Db } from './db.js';

// ─── Auth ─────────────────────────────────────────────────────────────────────
export {
  buildAuthConfig,
  buildEdgeAuthConfig,
  jwtCallback,
  sessionCallback,
  loginSchema,
  resolveOrgBySlug,
  verifyCredential,
  hashPassword,
  withSessionOrgContext,
  withSessionOrgContextWithDb,
  UnauthenticatedError,
  getSessionOrg,
  ForbiddenError,
  requireCapability,
  hasCapability,
  // Slice 4M.1 — Mobile auth pipeline
  verifyLoginAndIssueClaims,
  verifyLoginAndIssueClaimsWithDb,
  signMobileToken,
  verifyMobileToken,
  sessionFromMobileClaims,
} from './auth/index.js';

export type {
  AppSession,
  ResolvedOrg,
  VerifiedCredential,
  SessionOrgData,
  // Slice 4M.1 — Mobile claims type
  MobileClaims,
} from './auth/index.js';

// ─── Public-demo reset-on-open (packages/api/src/demo/reset.ts) ───────────────
// resetDemoTenant(slug)          — production entry: wipe + re-seed a demo tenant
//                                  via the privileged AEROOPS_DEMO_OWNER_URL client.
// resetDemoTenantWithDb(db, slug) — test-injectable core (inject a pglite client).
// maybeResetDemoTenant(slug)     — best-effort login-path trigger (env-flag gated).
// Guarded by a hard slug allowlist + AEROOPS_DEMO_RESET_ENABLED. See DEPLOY.md.
export {
  resetDemoTenant,
  resetDemoTenantWithDb,
  maybeResetDemoTenant,
  DEMO_RESET_ALLOWLIST,
  RESET_INTERVAL_MS,
} from './demo/reset.js';
export type { ResetResult } from './demo/reset.js';

// ─── Dashboard ────────────────────────────────────────────────────────────────
export { getDashboardSummary, getDashboardSummaryWithDb } from './dashboard/get-dashboard-summary.js';
export type { DashboardSummary } from './dashboard/get-dashboard-summary.js';

// ─── Scheduling (Slice 1 — SCHED-1, ADR-0004) ─────────────────────────────────
// Reservation write path (createReservation is the ONLY sanctioned insert path;
// cancelReservation the only cancel path), the advisory conflict preview
// (checkConflicts — commits nothing), resource management, and the read surface.
// *WithDb forms are for test code only (inject a pglite client).
export { createReservation, createReservationWithDb } from './scheduling/create-reservation.js';
export type { CreateReservationInput } from './scheduling/create-reservation.js';

export { cancelReservation, cancelReservationWithDb } from './scheduling/cancel-reservation.js';
export type { CancelReservationInput } from './scheduling/cancel-reservation.js';

export { checkConflicts, checkConflictsWithDb } from './scheduling/check-conflicts.js';
export type { CheckConflictsInput, CheckConflictsResult } from './scheduling/check-conflicts.js';

export {
  createResource,
  createResourceWithDb,
  deactivateResource,
  deactivateResourceWithDb,
} from './scheduling/resource-commands.js';
export type {
  CreateResourceInput,
  CreatedResource,
  DeactivateResourceInput,
  DeactivateResult,
} from './scheduling/resource-commands.js';

export { listResources, listResourcesWithDb } from './scheduling/list-resources.js';
export type { ListResourcesOptions, ResourceRow } from './scheduling/list-resources.js';

export { listReservations, listReservationsWithDb } from './scheduling/list-reservations.js';
export type { ListReservationsInput, ReservationRow } from './scheduling/list-reservations.js';

export { listOrgMembers, listOrgMembersWithDb } from './scheduling/list-org-members.js';
export type { ListOrgMembersOptions, OrgMemberRow } from './scheduling/list-org-members.js';

// Shared scheduling result/IO types (consumed by apps/web route handlers + UI).
export type {
  ConflictHit,
  CreatedReservation,
  CreateReservationResult,
  CancelResult,
  // Policy types — re-exported from @aeroops/core (via types.ts) for API callers.
  PolicyViolation,
  PolicyViolationView,
  // Slice 4a — TwilightHit carried on the ok:true twilightWarnings + the new
  // { ok:false, reason:'twilight' } refusal arm (re-exported from @aeroops/core).
  TwilightHit,
} from './scheduling/types.js';

// ─── Booking policies + blackouts (Slice 2a — SCHED-2a, ADR-0005) ────────────
// Admin commands for per-resource booking policies and blackout windows.
// Both fn (app code) + fnWithDb (tests) forms. Authz: schedule:manage_resources.
// *WithDb forms are for test code only (inject a pglite client).

export {
  getBookingPolicy,
  getBookingPolicyWithDb,
  upsertBookingPolicy,
  upsertBookingPolicyWithDb,
  clearBookingPolicy,
  clearBookingPolicyWithDb,
} from './scheduling/booking-policy-commands.js';
export type {
  BookingPolicyView,
  GetBookingPolicyInput,
  UpsertBookingPolicyInput,
  UpsertBookingPolicyResult,
  ClearBookingPolicyInput,
  ClearBookingPolicyResult,
} from './scheduling/booking-policy-commands.js';

export {
  listBlackouts,
  listBlackoutsWithDb,
  createBlackout,
  createBlackoutWithDb,
  deleteBlackout,
  deleteBlackoutWithDb,
} from './scheduling/blackout-commands.js';
export type {
  BlackoutView,
  ListBlackoutsInput,
  CreateBlackoutInput,
  CreateBlackoutResult,
  DeleteBlackoutInput,
  DeleteBlackoutResult,
} from './scheduling/blackout-commands.js';

// NOTE: CheckConflictsResult (now four-arm) is already re-exported at line 75
// via the checkConflicts export block — no duplicate needed here.

// ─── Recurring reservations (Slice 2b — SCHED-2b, ADR-0006) ──────────────────
// createSeries / cancelSeries / listSeriesOccurrences / previewSeries.
// All gates (conflict + policy) reused via gatedCreateOccurrence.
// *WithDb forms are for test code only (inject a pglite client).

export { createSeries, createSeriesWithDb } from './scheduling/create-series.js';

export { cancelSeries, cancelSeriesWithDb } from './scheduling/cancel-series.js';
export type { CancelSeriesInput } from './scheduling/cancel-series.js';

export {
  listSeriesOccurrences,
  listSeriesOccurrencesWithDb,
} from './scheduling/list-series-occurrences.js';
export type {
  ListSeriesOccurrencesInput,
  ListSeriesOccurrencesResult,
  ListSeriesOccurrencesResponse,
} from './scheduling/list-series-occurrences.js';

export { previewSeries, previewSeriesWithDb } from './scheduling/preview-series.js';

// Slice 4a — civil-twilight advisory preview (read-only; no audit; same authz as create).
export { previewTwilight, previewTwilightWithDb } from './scheduling/preview-twilight.js';
export type {
  PreviewTwilightInput,
  PreviewTwilightResult,
  PreviewTwilightResourceReport,
} from './scheduling/preview-twilight.js';

// ─── Slice AV1.2 — Resource operating-hours availability ──────────────────────
// CRUD (cap schedule:manage_resources): list/create/delete weekly operating-hours
// windows on a resource. previewAvailability (cap schedule:create_reservation,
// read-only, enabled-flag-independent) drives the "outside operating hours" UI
// indicator. The authoritative gate is the ADDITIVE Step D3 in gatedCreateOccurrence
// (warn attaches availabilityWarnings on ok:true; block adds the 'availability'
// refusal arm LAST, after twilight) — INERT when disabled / no windows. The config
// flags (availabilityConstraintEnabled / availabilityMode) live on updateDispatchConfig.
// *WithDb forms are for test code only. [VERIFY-AV1-A]: operator scheduling data,
// NOT an FAA duty-time / rest / Part-117/135/121 determination. NO money.
export {
  listAvailabilityWindows,
  listAvailabilityWindowsWithDb,
  createAvailabilityWindow,
  createAvailabilityWindowWithDb,
  deleteAvailabilityWindow,
  deleteAvailabilityWindowWithDb,
} from './scheduling/availability-commands.js';
export type {
  AvailabilityWindowView,
  ListAvailabilityWindowsInput,
  ListAvailabilityWindowsResult,
  CreateAvailabilityWindowInput,
  CreateAvailabilityWindowResult,
  DeleteAvailabilityWindowInput,
  DeleteAvailabilityWindowResult,
} from './scheduling/availability-commands.js';
export { previewAvailability, previewAvailabilityWithDb } from './scheduling/preview-availability.js';
export type {
  PreviewAvailabilityInput,
  PreviewAvailabilityResult,
  PreviewAvailabilityResourceReport,
} from './scheduling/preview-availability.js';
export type { AvailabilityHit } from './scheduling/types.js';

// ─── Slice 4b — Auto-scheduler (the optimizer orchestrator + preview) ─────────
// runAutoSchedule routes the PURE proposeSchedule (@aeroops/core) through the
// FROZEN gatedCreateOccurrence (single write path — NO bespoke INSERT), reusing
// the createSeries SAVEPOINT/23P01-race loop. Writes ONE schedule_optimization_run
// header + tags each created reservation's audit row with metadata.optimizationRunId.
// previewAutoSchedule is read-only (no INSERT/audit/run-header). Both authz
// schedule:create_reservation FIRST; org_id from session only; NO money.
// *WithDb forms are for test code only (inject a pglite client).
export { runAutoSchedule, runAutoScheduleWithDb } from './scheduling/auto-schedule.js';
export {
  previewAutoSchedule,
  previewAutoScheduleWithDb,
} from './scheduling/preview-auto-schedule.js';
export type {
  DemandInput,
  AutoScheduleInput,
  AutoScheduleResult,
  AutoProposalReport,
  PreviewAutoScheduleResult,
  PreviewAutoProposalReport,
} from './scheduling/types.js';

// Additive series types (frozen Slice-1/2a types above unchanged).
export type {
  SeriesRow,
  CreateSeriesInput,
  SeriesOccurrenceReport,
  CreateSeriesResult,
  CancelSeriesResult,
  PreviewSeriesOccurrenceReport,
  PreviewSeriesResult,
  SkippedLocalDate,
} from './scheduling/types.js';

// ─── Reschedule (Slice 2c — SCHED-2c, ADR-0006 §6 + Addendum) ─────────────────
// rescheduleReservation = atomic cancel-original + recreate through the shared
// gatedCreateOccurrence (no new write path, no new gate, no schema change).
// Throw-to-rollback keeps the original intact on any gate refusal/race.
// *WithDb form is for test code only (inject a pglite client).
export {
  rescheduleReservation,
  rescheduleReservationWithDb,
} from './scheduling/reschedule-reservation.js';
export type {
  RescheduleReservationInput,
  RescheduleResult,
} from './scheduling/types.js';

// ─── Slice 3a — Dispatch (DISPATCH-3a, ADR-0007) ──────────────────────────────
// Dispatch ticket check-out (open) / check-in (close) / void + board read.
// All write paths: authz dispatch:create FIRST; org_id from session; one audit
// row each; meters write-once; 23505 (one-open) mapped to already_open.
// Board read: authz dispatch:access; single ANY() query; RLS-scoped.
// *WithDb forms are for test code only (inject a pglite client).

export { openDispatch, openDispatchWithDb } from './dispatch/open-dispatch.js';
export type { OpenDispatchInput } from './dispatch/open-dispatch.js';

export { closeDispatch, closeDispatchWithDb } from './dispatch/close-dispatch.js';
export type { CloseDispatchInput } from './dispatch/close-dispatch.js';

export { voidDispatch, voidDispatchWithDb } from './dispatch/void-dispatch.js';
export type { VoidDispatchInput } from './dispatch/void-dispatch.js';

export {
  getDispatchForReservation,
  getDispatchForReservationWithDb,
  listDispatchPilots,
  listDispatchPilotsWithDb,
} from './dispatch/list-dispatch.js';
export type {
  GetDispatchForReservationInput,
  DispatchPilotRow,
} from './dispatch/list-dispatch.js';

// Dispatch result/IO types (consumed by apps/web board actions + UI).
export type {
  DispatchTicketView,
  OpenDispatchResult,
  CloseDispatchResult,
  VoidDispatchResult,
} from './dispatch/types.js';

// ─── Slice 3b — Maintenance: Squawks + Grounding (DISPATCH-3b, ADR-0008) ──────
// groundAircraft / unGroundAircraft — operator-set grounding events (append-only).
// getGroundingStatus — current grounding state per aircraft (DISTINCT ON probe).
// reportSquawk / updateSquawkStatus — squawk lifecycle (open→resolved|deferred).
// listSquawks / getOpenSquawkCounts — squawk read surface.
// All write paths: authz maintenance:* FIRST; org_id from session; one audit row each.
// maintenance:ground → owner/manager/dispatcher/mechanic (NOT cfi).
// maintenance:squawk → owner/manager/dispatcher/cfi/mechanic.
// maintenance:access → owner/manager/dispatcher/cfi/mechanic.
// *WithDb forms are for test code only (inject a pglite client).

export {
  groundAircraft,
  groundAircraftWithDb,
  unGroundAircraft,
  unGroundAircraftWithDb,
} from './maintenance/ground-aircraft.js';
export type {
  GroundAircraftInput,
  UnGroundAircraftInput,
} from './maintenance/ground-aircraft.js';

export {
  getGroundingStatus,
  getGroundingStatusWithDb,
} from './maintenance/grounding-status.js';
export type {
  GetGroundingStatusInput,
} from './maintenance/grounding-status.js';

export {
  reportSquawk,
  reportSquawkWithDb,
} from './maintenance/report-squawk.js';
export type {
  ReportSquawkInput,
} from './maintenance/report-squawk.js';

export {
  updateSquawkStatus,
  updateSquawkStatusWithDb,
} from './maintenance/update-squawk-status.js';
export type {
  UpdateSquawkStatusInput,
} from './maintenance/update-squawk-status.js';

export {
  listSquawks,
  listSquawksWithDb,
  getOpenSquawkCounts,
  getOpenSquawkCountsWithDb,
} from './maintenance/list-squawks.js';
export type {
  ListSquawksInput,
  GetOpenSquawkCountsInput,
} from './maintenance/list-squawks.js';

// Maintenance result/IO types.
export type {
  GroundingEventView,
  GroundingStatusView,
  SquawkView,
  GroundAircraftResult,
  UnGroundResult,
  ReportSquawkResult,
  UpdateSquawkStatusResult,
} from './maintenance/types.js';

// ─── Slice M1.2 — Maintenance Work Orders (MAINTENANCE-M1, migration 0013) ───
// Work-order lifecycle: open → in_progress → completed | cancelled.
// Completion orchestration: WO + optional squawk-resolve + optional unground
//   all in ONE tx (atomic). shouldUngroundForWorkOrder (pure rule, @aeroops/core)
//   guards the conservative unground decision.
// maintenance:work_order → owner/manager/dispatcher/mechanic (NOT cfi/accountant).
// maintenance:squawk additional cap required when resolveSquawk=true.
// maintenance:ground additional cap required when unground=true.
// Fleet aggregate extended: openWorkOrders (≤10) + openWorkOrderCount on AircraftDetail.
// [VERIFY-M1-A]: completed ≠ RTS. [VERIFY-M1-C]: sign-off = operator entry, not e-sig.
// [VERIFY-M1-D]: unground = affirmative operator action, not computed clearance.
// [VERIFY-M1-E]: open WOs surface on fleet detail (fleet:access gate).
// NO FAA/Part-43/airworthiness determination. NO money. M1 reads NO dispatch meters.
// *WithDb forms are for test code only (inject a pglite client).

export {
  openWorkOrder,
  openWorkOrderWithDb,
} from './maintenance/open-work-order.js';
export type { OpenWorkOrderInput } from './maintenance/open-work-order.js';

export {
  listWorkOrders,
  listWorkOrdersWithDb,
  getWorkOrderDetail,
  getWorkOrderDetailWithDb,
} from './maintenance/list-work-orders.js';
export type {
  ListWorkOrdersInput,
  GetWorkOrderDetailInput,
} from './maintenance/list-work-orders.js';

export {
  updateWorkOrderStatus,
  updateWorkOrderStatusWithDb,
} from './maintenance/update-work-order-status.js';
export type { UpdateWorkOrderStatusInput } from './maintenance/update-work-order-status.js';

export {
  completeWorkOrder,
  completeWorkOrderWithDb,
} from './maintenance/complete-work-order.js';
export type { CompleteWorkOrderInput } from './maintenance/complete-work-order.js';

export {
  cancelWorkOrder,
  cancelWorkOrderWithDb,
} from './maintenance/cancel-work-order.js';
export type { CancelWorkOrderInput } from './maintenance/cancel-work-order.js';

// Work-order result/IO types.
export type {
  WorkOrderView,
  OpenWorkOrderResult,
  ListWorkOrdersResult,
  GetWorkOrderDetailResult,
  UpdateWorkOrderStatusResult,
  CompleteWorkOrderResult,
  CancelWorkOrderResult,
} from './maintenance/work-order-types.js';

// ─── Slice 5 — Fleet (FLEET-5.2) ──────────────────────────────────────────────
// Aircraft list + detail aggregation + identity edit + location picker.
// fleet:access → owner/manager/dispatcher/cfi/mechanic.
// fleet:manage → owner/manager/dispatcher/mechanic (NOT cfi).
// renter/student/accountant get neither.
// All reads: authz fleet:access FIRST; org_id from session; RLS-scoped.
// updateAircraft: authz fleet:manage; ONE audit row; never touches meters/records.
// *WithDb forms are for test code only (inject a pglite client).

export {
  listAircraft,
  listAircraftWithDb,
} from './fleet/list-aircraft.js';
export type { ListAircraftOptions } from './fleet/list-aircraft.js';

export {
  getAircraftDetail,
  getAircraftDetailWithDb,
} from './fleet/get-aircraft-detail.js';
export type {
  GetAircraftDetailInput,
  GetAircraftDetailResult,
} from './fleet/get-aircraft-detail.js';

export {
  updateAircraft,
  updateAircraftWithDb,
} from './fleet/update-aircraft.js';
export type { UpdateAircraftInput } from './fleet/update-aircraft.js';

export {
  listLocations,
  listLocationsWithDb,
} from './fleet/list-locations.js';

// Fleet result/IO types.
export type {
  AircraftListRow,
  AircraftDetail,
  UpdateAircraftResult,
  LocationOption,
  UpcomingReservationRow,
} from './fleet/types.js';

// ─── Slice 6.2 — People / Members (PEOPLE-6.2) ────────────────────────────────
// Roster management: list, detail, update identity/role, toggle status, tags,
// add new member (roster-only — NO auth_credential). people:access = read;
// people:manage = owner/manager mutations.
// *WithDb forms are for test code only (inject a pglite client).
//
// [VERIFY-6-A]: member_tag is free-text only; no FAA/currency/medical meaning.
// [VERIFY-6-C]: upcomingReservations = reservation.created_by, not flight assignment.
// [VERIFY-6-D]: status is a roster flag, NOT a login gate in this slice.

export { listMembers, listMembersWithDb } from './people/list-members.js';
export type { ListMembersOptions } from './people/list-members.js';

export { getMemberDetail, getMemberDetailWithDb } from './people/get-member-detail.js';
export type { GetMemberDetailInput } from './people/get-member-detail.js';

export { updateMember, updateMemberWithDb } from './people/update-member.js';
export type { UpdateMemberInput } from './people/update-member.js';

export { setMemberStatus, setMemberStatusWithDb } from './people/set-member-status.js';
export type { SetMemberStatusInput } from './people/set-member-status.js';

export { addMemberTag, addMemberTagWithDb } from './people/add-member-tag.js';
export type { AddMemberTagInput } from './people/add-member-tag.js';

export { removeMemberTag, removeMemberTagWithDb } from './people/remove-member-tag.js';
export type { RemoveMemberTagInput } from './people/remove-member-tag.js';

export { addMember, addMemberWithDb } from './people/add-member.js';
export type { AddMemberInput } from './people/add-member.js';

// People result/IO types.
export type {
  OrgMemberListRow,
  MemberDetail,
  MemberTagView,
  UpcomingMemberReservationRow,
  GetMemberDetailResult,
  UpdateMemberResult,
  SetMemberStatusResult,
  AddMemberTagResult,
  RemoveMemberTagResult,
  AddMemberResult,
} from './people/types.js';

// ─── Slice 3c — Dispatch gate (DISPATCH-3c, ADR-0009) ────────────────────────
// Per-aircraft free-text required tags + per-org dispatch gate config.
// getResourceRequiredTags / addResourceRequiredTag / removeResourceRequiredTag:
//   dispatch:access (read) / dispatch:manage_requirements (owner/manager/dispatcher) write.
// getDispatchConfig / updateDispatchConfig:
//   dispatch:access (read) / dispatch:manage_requirements write.
// openDispatch is additive: new ineligible/balance_block arms + eligibilityWarnings.
// [VERIFY-3c-A] requiredTag is FREE-TEXT only; no FAA/currency/medical meaning.
// [VERIFY-3c-MONEY] balance is a stub; no Stripe/dollar/payment anywhere.
// *WithDb forms are for test code only (inject a pglite client).

export {
  getResourceRequiredTags,
  getResourceRequiredTagsWithDb,
  addResourceRequiredTag,
  addResourceRequiredTagWithDb,
  removeResourceRequiredTag,
  removeResourceRequiredTagWithDb,
} from './dispatch-gate/requirements.js';
export type {
  GetResourceRequiredTagsInput,
  AddResourceRequiredTagInput,
  RemoveResourceRequiredTagInput,
} from './dispatch-gate/requirements.js';

export {
  getDispatchConfig,
  getDispatchConfigWithDb,
  updateDispatchConfig,
  updateDispatchConfigWithDb,
} from './dispatch-gate/config.js';
export type {
  UpdateDispatchConfigInput,
} from './dispatch-gate/config.js';

// Dispatch gate result/IO types.
export type {
  RequiredTagView,
  DispatchConfigView,
  GetResourceRequiredTagsResult,
  AddResourceRequiredTagResult,
  RemoveResourceRequiredTagResult,
  GetDispatchConfigResult,
  UpdateDispatchConfigResult,
} from './dispatch-gate/types.js';

// ─── Slice 7.1 — Reporting (REPORTING-7.1) ────────────────────────────────────
// Read-only aggregation over existing tables. NO schema change, NO migration.
// reporting:access → owner/manager/dispatcher/cfi/accountant (D3, Slice 7).
// All reads: authz reporting:access FIRST; org_id from session only; RLS-scoped.
// Tenant isolation is the primary risk: every aggregate inside
//   withSessionOrgContextWithDb, no N+1 across orgs.
// getOrgDashboardMetrics: range-scoped + point-in-time metric bundle.
// getAircraftUtilization: ONE LEFT-JOIN query; zero-flight tails appear (0/0).
// *WithDb forms are for test code only (inject a pglite client).

export {
  getOrgDashboardMetrics,
  getOrgDashboardMetricsWithDb,
} from './reporting/get-org-dashboard-metrics.js';
export type {
  GetOrgDashboardMetricsInput,
  OrgDashboardMetrics,
  OrgDashboardMetricsRange,
} from './reporting/get-org-dashboard-metrics.js';

export {
  getAircraftUtilization,
  getAircraftUtilizationWithDb,
} from './reporting/get-aircraft-utilization.js';
export type {
  GetAircraftUtilizationInput,
  AircraftUtilizationRow,
} from './reporting/get-aircraft-utilization.js';

// ─── R1.1 — Operational Reports backend (read-only aggregates, no migration) ──
// 5 new report reads: utilization trend, hours by tail, reservations vs flights,
// training throughput, maintenance trend. All authz reporting:access FIRST;
// org_id from session only; RLS the only org filter; zero writes.
// [VERIFY-A] hours=operational; [VERIFY-T1-B] training=operator state;
// [VERIFY-M1-A] maintenance=operator data; [VERIFY-R1-TZ] UTC bucketing.
// *WithDb forms are for test code only (inject a pglite client).

export {
  getUtilizationTrend,
  getUtilizationTrendWithDb,
} from './reporting/get-utilization-trend.js';
export type { GetUtilizationTrendInput } from './reporting/get-utilization-trend.js';

export {
  getHoursByTail,
  getHoursByTailWithDb,
} from './reporting/get-hours-by-tail.js';
export type { GetHoursByTailInput } from './reporting/get-hours-by-tail.js';

export {
  getReservationsVsFlightsTrend,
  getReservationsVsFlightsTrendWithDb,
} from './reporting/get-reservations-vs-flights-trend.js';
export type { GetReservationsVsFlightsTrendInput } from './reporting/get-reservations-vs-flights-trend.js';

export {
  getTrainingThroughput,
  getTrainingThroughputWithDb,
} from './reporting/get-training-throughput.js';
export type { GetTrainingThroughputInput } from './reporting/get-training-throughput.js';

export {
  getMaintenanceTrend,
  getMaintenanceTrendWithDb,
} from './reporting/get-maintenance-trend.js';
export type { GetMaintenanceTrendInput } from './reporting/get-maintenance-trend.js';

// R1.1 shared types.
export type {
  ReportRange,
  ReportRangeKey,
  BucketGranularity,
  UtilizationTrendBucket,
  UtilizationTrendResult,
  ReservationsVsFlightsBucket,
  ReservationsVsFlightsTrendResult,
  TrainingThroughputResult,
  MaintenanceTrendResult,
} from './reporting/types.js';

// ─── Slice T1.2 — Training (TRAINING-T1, ADR-0011) ────────────────────────────
// Course + lesson + enrollment + lesson-record lifecycle. Pure content-ratio
// progress (NOT a Part-141 or FAA determination of any kind).
// training:access → owner/manager/dispatcher/cfi (read).
// training:manage → owner/manager/cfi (build/enroll/record/void). Student gets
//   NEITHER cap in T1 (self-service portal is Phase 6). [VERIFY-T1-H]
// All write paths: ONE audit row; lesson_record WRITE-ONCE (void-only correction).
// NO money; NO computed FAA determination. [MONEY BOUNDARY] [VERIFY-T1-A/B/C]
// *WithDb forms are for test code only (inject a pglite client).

export { listCourses, listCoursesWithDb } from './training/list-courses.js';
export type { ListCoursesOptions } from './training/list-courses.js';

export { getCourseDetail, getCourseDetailWithDb } from './training/get-course-detail.js';
export type { GetCourseDetailInput } from './training/get-course-detail.js';

export { listEnrollments, listEnrollmentsWithDb } from './training/list-enrollments.js';
export type { ListEnrollmentsOptions } from './training/list-enrollments.js';

export {
  getEnrollmentDetail,
  getEnrollmentDetailWithDb,
} from './training/get-enrollment-detail.js';
export type { GetEnrollmentDetailInput } from './training/get-enrollment-detail.js';

export {
  listEnrollmentsForMember,
  listEnrollmentsForMemberWithDb,
} from './training/list-enrollments-for-member.js';
export type { ListEnrollmentsForMemberInput } from './training/list-enrollments-for-member.js';

export { createCourse, createCourseWithDb } from './training/create-course.js';
export type { CreateCourseInput } from './training/create-course.js';

export { addCourseLesson, addCourseLessonWithDb } from './training/add-course-lesson.js';
export type { AddCourseLessonInput } from './training/add-course-lesson.js';

export {
  removeCourseLesson,
  removeCourseLessonWithDb,
} from './training/remove-course-lesson.js';
export type { RemoveCourseLessonInput } from './training/remove-course-lesson.js';

export { enrollMember, enrollMemberWithDb } from './training/enroll-member.js';
export type { EnrollMemberInput } from './training/enroll-member.js';

export {
  setEnrollmentStatus,
  setEnrollmentStatusWithDb,
} from './training/set-enrollment-status.js';
export type { SetEnrollmentStatusInput } from './training/set-enrollment-status.js';

export { recordLesson, recordLessonWithDb } from './training/record-lesson.js';
export type { RecordLessonInput } from './training/record-lesson.js';

export { voidLessonRecord, voidLessonRecordWithDb } from './training/void-lesson-record.js';
export type { VoidLessonRecordInput } from './training/void-lesson-record.js';

// Training result/IO types.
export type {
  CourseListRow,
  CourseDetail,
  EnrollmentListRow,
  EnrollmentDetail,
  LessonProgressRow,
  LessonRecordView,
  MemberEnrollmentRow,
  ListCoursesResult,
  GetCourseDetailResult,
  ListEnrollmentsResult,
  GetEnrollmentDetailResult,
  ListEnrollmentsForMemberResult,
  CreateCourseResult,
  AddCourseLessonResult,
  RemoveCourseLessonResult,
  EnrollMemberResult,
  SetEnrollmentStatusResult,
  RecordLessonResult,
  VoidLessonRecordResult,
} from './training/types.js';

// ─── Slice S1.1 — Global search (READ-ONLY, no migration, no money) ───────────
// searchOrg(session, { query }) — app code form (uses getDb() internally).
// searchOrgWithDb(db, session, { query }) — test form (inject pglite client).
//
// SECURITY INVARIANTS:
//   - requireCapability('app:access') is the front door (UnauthenticatedError).
//   - Per-type hasCapability gate: a role lacking a cap runs NO query for that type.
//   - All query values bound params (injection guard). escapeLike for LIKE-semantics.
//   - org_id from session only; RLS is the only org filter.
//   - Reads NOT audited. NO money. NO computed FAA determination.
//   - q < 2 chars → { groups: [] } with NO db call.
//   - FIXED type order: aircraft, member, work_order, squawk, course, reservation.
//   - LIMIT 5 per type, empty groups omitted.
//
// Capabilities gate per type (per spec S1.1 table):
//   aircraft    → fleet:access       (owner/manager/dispatcher/cfi/mechanic)
//   member      → people:access      (owner/manager/dispatcher/cfi)
//   work_order  → maintenance:access (owner/manager/dispatcher/cfi/mechanic)
//   squawk      → maintenance:access (same)
//   course      → training:access    (owner/manager/dispatcher/cfi)
//   reservation → schedule:access    (owner/manager/dispatcher/cfi)
//
//   student/renter (app:access only) + accountant (app+reporting) → { groups: [] }.
//   mechanic → aircraft + work_order + squawk ONLY (no people/training/schedule).
//   cfi → all 6 (has maintenance:access despite lacking maintenance:work_order).
export { searchOrg, searchOrgWithDb } from './search/search-org.js';

export type {
  SearchResult,
  SearchGroup,
  SearchOrgInput,
  SearchOrgResult,
  SearchResultType,
} from './search/types.js';

// ─── Slice A1.1 — Activity feed (READ-ONLY audit timeline, no migration) ──────
// listActivity: paginated reverse-chronological audit_log read.
// Requires reporting:access; org_id from session only; RLS scopes; NOT audited.
// keyset cursor on (created_at, id); limit default 50 cap 100.
// Actor: full_name??email / null→"System" / deleted→"A former user".
// All summaries via the PURE @aeroops/core whitelist-only summarizer.
// NEVER writes to audit_log (records integrity preserved by construction).
// *WithDb form is for test code only (inject pglite client).
export { listActivity, listActivityWithDb } from './activity/list-activity.js';

export type {
  ActivityEntry,
  ActivityCursor,
  ListActivityResult,
  ListActivityOptions,
} from './activity/types.js';

// ─── Slice P1.1 — Student/Renter self-service portal (READ-ONLY, no migration) ─
// Self-scoped reads: the subject is ALWAYS session.userId (the verified JWT
// subject) — there is NO row-identifying input param, so a portal user can
// NEVER read another member's data (the load-bearing self-scoping requirement).
//
// SECURITY INVARIANTS:
//   - requireCapability('portal:access') FIRST in every read.
//   - portal:access is STANDALONE: it does NOT transitively grant
//     training/people/fleet/schedule access. These are SEPARATE functions —
//     a student calling listEnrollments/listMembers/getMemberDetail still gets
//     ForbiddenError (those gate on training:access/people:access).
//   - org_id from session only; RLS is the org backstop.
//   - Reads NOT audited. NO money. NO computed FAA determination. NO migration.
//
// portal:access → owner/manager/student/renter (cfi/dispatcher/accountant/mechanic NOT).
// Resolves [VERIFY-T1-H]: own-progress = operator content already recorded, not a
// new Part-61/141 determination. [VERIFY-T1-B] progress=coverage; [VERIFY-6-A] tags=free-text.
// *WithDb forms are for test code only (inject a pglite client).
export { getMyTraining, getMyTrainingWithDb } from './portal/get-my-training.js';
export { getMyReservations, getMyReservationsWithDb } from './portal/get-my-reservations.js';
export { getMyAccount, getMyAccountWithDb } from './portal/get-my-account.js';
export { getMyPortalSummary, getMyPortalSummaryWithDb } from './portal/get-my-portal-summary.js';

export type {
  MyEnrollmentRow,
  MyReservationRow,
  MyAccountView,
  MyPortalSummary,
} from './portal/types.js';

// ─── Slice N1.1 — In-app alerts (READ-ONLY, derived, no migration) ────────────
// Derived-on-read per-user alerts: upcoming reservations (≤24h) and grounded
// aircraft on upcoming reservations. NO write path, NO audit, NO migration.
//
// SECURITY INVARIANTS:
//   - requireCapability('app:access') FIRST — all 8 roles hold this cap.
//   - Subject = session.userId ONLY (self-scoped; zero IDOR — no row-id input).
//   - org_id from session only; ONE withSessionOrgContextWithDb call; RLS backstop.
//   - Reads NOT audited. NO money. NO computed FAA determination.
//   - Derivation: ≤2 queries (CLONE of portal predicate + loadGroundingProbe).
//   - MAX_ALERTS=20 (nearest in time kept). Sorted at ASC, deduped by id.
//
// [VERIFY-N1-A]: surfacing operator grounding data to an affected pilot (provisional).
// Grounded alert = operator data (ADR-0008), NOT an airworthiness/Part-91/43 ruling.
// app:access → owner/manager/dispatcher/cfi/mechanic/renter/student/accountant (ALL roles).
// *WithDb form is for test code only (inject a pglite client).
export { getMyAlerts, getMyAlertsWithDb } from './notifications/get-my-alerts.js';

export type {
  AlertKind,
  MyAlert,
  MyAlertsResult,
} from './notifications/types.js';

// ─── Slice PB1.1 — Public booking-request submit (ADR-0013) ──────────────────
// The ONLY unauthenticated WRITE in the app. Strict ADR-0013 invariants:
//   - tx body is INSERT-ONLY into booking_request (no cross-table read/write).
//   - org_id bound ONLY from resolveOrgBySlug (never client input).
//   - withOrgContext (normal RLS) NOT withPlatformAdminContext.
//   - booking_request_insert WITH CHECK(org_id=GUC) is the RLS backstop.
//   - Honeypot (website non-empty) → fake ok, NO DB access.
//   - Per-org rate guard (≥10 in last 1 min) → silent drop, fake ok, no insert.
//   - Unknown slug and suspended org are INDISTINGUISHABLE ('unavailable').
//   - NO id / tenant data echoed in response.
//
// PB-LR.B additive: CaptchaVerifier interface + getCaptchaVerifier() factory
// re-exported so apps/web route handlers (and tests) can inject fake verifiers.
// NoopCaptchaVerifier is the default (unconfigured) — path byte-identical to PB1.
//
// bookingRequestSchema re-exported here so apps/web can import it from
// '@aeroops/api' as well as '@aeroops/core' (belt-and-suspenders re-export).
// *WithDb form is for test code only (inject a pglite client).
export {
  submitBookingRequest,
  submitBookingRequestWithDb,
} from './booking/submit-booking-request.js';
export type { SubmitBookingRequestResult } from './booking/submit-booking-request.js';

// ─── Slice PB-LR.B — CAPTCHA verification seam ───────────────────────────────
// CaptchaVerifier: the interface for test injection and custom adapters.
// NoopCaptchaVerifier: always-true default (unconfigured; byte-identical path).
// TurnstileCaptchaVerifier: Cloudflare Turnstile adapter (reads CAPTCHA_SECRET_KEY).
// getCaptchaVerifier(): factory — call once per request; returns Noop when unset.
// NO money, NO FAA. Deploy step: set CAPTCHA_PROVIDER + CAPTCHA_SECRET_KEY in Vercel.
export {
  getCaptchaVerifier,
  NoopCaptchaVerifier,
  TurnstileCaptchaVerifier,
} from './booking/captcha.js';
export type { CaptchaVerifier } from './booking/captcha.js';

// Re-export the shared zod schema so apps/web can import from '@aeroops/api'
// rather than reaching into '@aeroops/core' directly.
export { bookingRequestSchema } from '@aeroops/core';
export type { BookingRequestInput } from '@aeroops/core';

// ─── Slice PB1.2 — Staff triage (session-scoped, booking:triage cap) ──────────
// listBookingRequests: requireCapability('booking:triage') FIRST; newest-first
//   (matches (org_id,status,created_at DESC) index); status filter + counts.
// updateBookingRequestStatus: audited status transitions; sets handled_by/handled_at.
//   PB2.1b: 'converted' is NO LONGER reachable here — the only path to converted is
//   convertBookingRequest (below). This command does new→contacted|declined,
//   contacted→declined|contacted, terminals terminal. NO money.
// booking:triage → owner/manager/dispatcher (NOT cfi/mechanic/renter/student/accountant).
// Requester fields are NEVER mutated (write-once per ADR-0013).
// *WithDb forms are for test code only (inject a pglite client).

export {
  listBookingRequests,
  listBookingRequestsWithDb,
} from './booking/list-booking-requests.js';
export type {
  ListBookingRequestsOptions,
  ListBookingRequestsResult,
  BookingRequestRow,
  BookingRequestStatus,
  BookingRequestStatusCounts,
} from './booking/list-booking-requests.js';

export {
  updateBookingRequestStatus,
  updateBookingRequestStatusWithDb,
} from './booking/update-booking-request-status.js';
export type {
  UpdateBookingRequestStatusInput,
  UpdateBookingRequestStatusResult,
} from './booking/update-booking-request-status.js';

// ─── Slice PB2.1b — Convert a booking-request into a reservation (ADR-0014) ────
// convertBookingRequest: the ATOMIC composite command. authz BOTH (booking:triage
//   THEN schedule:create_reservation) FIRST; ONE withSessionOrgContext tx; loads the
//   request FOR UPDATE (serializes double-convert); creates the reservation via the
//   FROZEN gatedCreateOccurrence (NO bespoke INSERT — the gate stays byte-identical);
//   on gate refusal a ConvertRefusedError throws-to-rollback so NEITHER the reservation
//   NOR the request-flip persists (the 5 frozen refusal arms returned verbatim);
//   on success flips the SAME row to 'converted' + sets converted_reservation_id +
//   writes ONE booking_request.converted audit row (ids-only metadata, NO PII).
// The ONLY path to status='converted' (updateBookingRequestStatus no longer reaches it).
// NO money; NO app_user/member/pilot/dispatch creation (created_by = staff via the gate).
// *WithDb form is for test code only (inject a pglite client).
export {
  convertBookingRequest,
  convertBookingRequestWithDb,
} from './booking/convert-booking-request.js';
export type {
  ConvertBookingRequestInput,
  ConvertBookingRequestResult,
} from './booking/convert-booking-request.js';

// ─── Slice PB-LR.A — Booking-request retention config + purge (ADR-0013) ──────
// getBookingRetention / setBookingRetention — per-org retention config
//   (stored on dispatch_config). Absent row → defaults {365 days, false}.
//   retentionDays = 0 means "keep forever" (NOT delete-all).
//   setBookingRetention: upsert + ONE audit row 'booking_retention.config_changed'
//     (prev/new — no PII). zod 0–3650.
// purgeExpiredBookingRequests — session form; org_id from session only.
//   dryRun=true (default): count eligible rows only, no delete, no audit.
//   dryRun=false: DELETE + ONE audit row 'booking_request.purged'
//     { deletedCount, retentionDays, includesConverted, cutoffIso } — COUNTS ONLY.
//   retentionDays=0 → no-op {retentionDisabled:true} (NEVER delete-all).
// purgeExpiredBookingRequestsForOrg — internal/script form; wraps withOrgContext
//   directly (org_id from caller); no session/requireCapability. Used by the
//   devops CLI script one org at a time.
// org:manage_settings → owner/manager only (both setter forms).
// NEVER logs requester PII (name/email/phone). Hard-DELETE. NO money, NO FAA.
// [VERIFY-PB1-COMP-1]: hard-delete vs anonymize; 365-day default; status-change
//   audit-row retention post-purge — route to compliance-officer.
// *WithDb forms are for test code only (inject a pglite client).
export {
  getBookingRetention,
  getBookingRetentionWithDb,
  setBookingRetention,
  setBookingRetentionWithDb,
} from './booking/set-booking-retention.js';
export type {
  BookingRetentionView,
  GetBookingRetentionResult,
  SetBookingRetentionInput,
  SetBookingRetentionResult,
} from './booking/set-booking-retention.js';

export {
  purgeExpiredBookingRequests,
  purgeExpiredBookingRequestsWithDb,
  purgeExpiredBookingRequestsForOrg,
} from './booking/purge-booking-requests.js';
export type {
  PurgeExpiredBookingRequestsInput,
  PurgeExpiredBookingRequestsResult,
} from './booking/purge-booking-requests.js';

// ─── Slice B1 — Billing API (records + invoice math, NO Stripe, NO charge) ─────
// Effective meter: reads the CLOSED dispatch ticket's original meters + applies
//   the latest dispatch_ticket_correction (if any). READ-ONLY; the FROZEN
//   close path is untouched. Consumed by generateInvoiceFromDispatch.
// Correction command: appends one row to dispatch_ticket_correction (INSERT-only).
//   Requires dispatch:create (same authority as closeDispatch). ONE audit row.
// Rate CRUD: createRateSchedule/listRateSchedules/deleteRateSchedule.
//   billing:manage (owner/manager) for writes; billing:access for reads.
//   amount_cents = INTEGER CENTS (non-negative). Audited create/delete.
//   deleteRateSchedule: rejects if referenced by any invoice_line_item.
// generateInvoiceFromDispatch: DRAFT invoice only. Reads effective meter +
//   stored flight_time_hours (NOT recomputed). Computes integer-cent line total
//   via @aeroops/core applyRate/computeInvoiceTotals. ONE audit row.
//   NO Stripe, NO payment, NO charge, NO finalization here.
// Invoice reads: listInvoices (status/member filters) + getInvoice (with line items).
//   billing:access required. RLS-scoped. NO money mutations.
// finalizeInvoice: draft→finalized (sets issued_at; immutable after). billing:manage.
// voidInvoice: draft|finalized→void (terminal). billing:manage. Audited.
// MONEY BOUNDARY: all amounts are INTEGER CENTS (never floats). NO Stripe/card/
//   payment/charge anywhere in this slice. The dispatch gate + close path are
//   READ-ONLY here (FROZEN; ADR-0007). Migration 0019 staged + human-gated.
// [VERIFY-B-MONEY-1]: flight_time_hours is the billable basis (ADR-0007).
// [VERIFY-B0-COMP-1]: meter correction audit-chain before Phase-2 billing.
// *WithDb forms are for test code only (inject a pglite client).

export {
  getEffectiveMeter,
} from './billing/effective-meter.js';
export type {
  GetEffectiveMeterResult,
  EffectiveMeterOk,
} from './billing/effective-meter.js';

export {
  correctDispatchMeter,
  correctDispatchMeterWithDb,
} from './billing/correct-dispatch-meter.js';
export type {
  CorrectDispatchMeterInput,
  CorrectDispatchMeterResult,
  DispatchCorrectionView,
} from './billing/correct-dispatch-meter.js';

export {
  createRateSchedule,
  createRateScheduleWithDb,
  listRateSchedules,
  listRateSchedulesWithDb,
  deleteRateSchedule,
  deleteRateScheduleWithDb,
} from './billing/rate-commands.js';
export type {
  RateKind,
  RateScheduleView,
  CreateRateScheduleInput,
  CreateRateScheduleResult,
  ListRateSchedulesOptions,
  ListRateSchedulesResult,
  DeleteRateScheduleInput,
  DeleteRateScheduleResult,
} from './billing/rate-commands.js';

export {
  generateInvoiceFromDispatch,
  generateInvoiceFromDispatchWithDb,
} from './billing/generate-invoice.js';
export type {
  GenerateInvoiceFromDispatchInput,
  GenerateInvoiceFromDispatchResult,
} from './billing/generate-invoice.js';

export {
  listInvoices,
  listInvoicesWithDb,
  getInvoice,
  getInvoiceWithDb,
} from './billing/list-invoices.js';
export type {
  InvoiceStatus,
  InvoiceView,
  InvoiceLineItemView,
  ListInvoicesOptions,
  ListInvoicesResult,
  GetInvoiceInput,
  GetInvoiceResult,
} from './billing/list-invoices.js';

export {
  finalizeInvoice,
  finalizeInvoiceWithDb,
  voidInvoice,
  voidInvoiceWithDb,
} from './billing/invoice-status-commands.js';
export type {
  FinalizeInvoiceResult,
  VoidInvoiceResult,
} from './billing/invoice-status-commands.js';

// ─── Slice B2 — Billing ledger + balance (NO Stripe, gate stays OFF) ──────────
// getMemberBalance / listLedgerEntries: billing:access. DERIVED balance —
//   NO stored/cached balance column anywhere; computeBalance (@aeroops/core)
//   is always run fresh over that member's ledger_entry rows.
// recordManualPayment: billing:manage, audited. Posts ONE 'payment' credit
//   ledger_entry (methodNote = free-text operator reference, e.g. "Check
//   #1042" — NEVER a raw card/bank value). Makes the balance gate meaningful
//   with ZERO Stripe.
// finalizeInvoice (billing/invoice-status-commands.js, unchanged export)
//   ADDITIVELY posts ONE 'invoice_finalized' debit ledger_entry in the SAME
//   tx as the status transition — idempotent via a partial UNIQUE index
//   (migration 0022).
// makeRealBalanceSeam: a REAL (ledger-backed) BalanceSeam implementation —
//   SAME interface as core's stubBalanceSeam. [VERIFY-B2-MONEY] HARD MONEY
//   BOUNDARY: fully built + tested here, but NOT injected into
//   openDispatch()'s app-code form in this slice — the FROZEN gate stays
//   wired to stubBalanceSeam (packages/api/src/dispatch/open-dispatch.ts:338).
//   dispatch_config.minimum_balance_cents (migration 0022, additive column)
//   is DATA ONLY, consumed exclusively by this seam.
// Migration 0022 staged + human-gated, NOT applied.
// *WithDb forms are for test code only (inject a pglite client).

export {
  getMemberBalance,
  getMemberBalanceWithDb,
  listLedgerEntries,
  listLedgerEntriesWithDb,
} from './billing/ledger-account.js';
export type {
  GetMemberBalanceResult,
  LedgerEntryView,
  LedgerEntryCursor,
  ListLedgerEntriesOptions,
  ListLedgerEntriesResult,
} from './billing/ledger-account.js';

export {
  recordManualPayment,
  recordManualPaymentWithDb,
} from './billing/record-manual-payment.js';
export type {
  RecordManualPaymentInput,
  RecordManualPaymentResult,
} from './billing/record-manual-payment.js';

export { makeRealBalanceSeam } from './billing/real-balance-seam.js';

// ─── Slice QB1 — QuickBooks Online integration (bookkeeping EXPORT only) ───────
// NOT a payment processor. NEVER moves money. Pushes EXISTING finalized B1
// invoice records into the operator's own connected QBO company file, with
// each line item mapped to its own QBO Item by kind (per-line-item GL
// mapping — never a lump-sum line). Migration 0021 staged + human-gated.
//
// Provider seam: getQboClient() (integrations/qbo/client.ts) — stub when
//   QBO_CLIENT_ID/QBO_CLIENT_SECRET are unset (every call throws
//   QboNotConfiguredError; callers convert to a typed not_configured
//   refusal), real fetch-based client otherwise. [VERIFY-QB1-SEC-1]: OAuth
//   tokens are stored PLAINTEXT in qbo_connection — encryption-at-rest is a
//   flagged production follow-up.
// mapInvoiceToQboPayload: PURE money-math boundary (integrations/qbo/
//   map-invoice.ts) — property-tested. Refuses (never lumps) when any
//   line's kind has no mapping and no 'default' fallback row exists.
// Account mapping: setQboAccountMapping/deleteQboAccountMapping —
//   org:manage_settings, audited. line_kind mirrors rate_schedule.rate_kind
//   (migration 0019) plus 'other' (no-rate-schedule lines) + 'default'
//   (catch-all). [VERIFY-QB1-B]: rate_kind CHECK domain is frozen here.
// getQboStatus: billing:access. Connection status (NEVER tokens) + last 20
//   export-log rows + the current account mapping + providerConfigured.
// exportInvoiceToQbo: billing:manage. Refuses draft/void invoices; ONLY
//   finalized. Idempotent (an already-exported invoice is never re-pushed —
//   backed by migration 0021's partial UNIQUE index). Every attempt writes
//   a qbo_export_log row ('exported' or 'error' — errors NEVER silently
//   swallowed) + ONE audit row. On stub/unconfigured → clean typed
//   { ok:false, reason:'not_configured' }, never a crash.
// OAuth connect: buildQboAuthorizeUrl/completeQboOAuth/disconnectQbo —
//   org:manage_settings. State = a short-lived signed token bound to
//   (orgId,userId) (integrations/qbo/state.ts, reuses AUTH_SECRET) —
//   org_id is NEVER taken from the unauthenticated OAuth callback query.
// *WithDb forms are for test code only (inject a pglite client + a fake
// QboClient — tests never make a real HTTP call).

export {
  StubQboClient,
  RealQboClient,
  getQboClient,
  __resetQboClientForTests,
  QboNotConfiguredError,
  QboProviderError,
  QBO_AUTHORIZE_URL,
  QBO_TOKEN_URL,
  QBO_ACCOUNTING_SCOPE,
} from './integrations/qbo/client.js';
export type {
  QboClient,
  QboInvoiceLine,
  QboInvoicePayload,
  QboCreateCustomerInput,
  QboRequestContext,
  QboTokenSet,
} from './integrations/qbo/client.js';

export {
  QBO_LINE_KINDS,
  QBO_MAPPABLE_LINE_KINDS,
  resolveLineKind,
  isQboLineKind,
} from './integrations/qbo/line-kind.js';
export type { QboLineKind, QboMappableLineKind } from './integrations/qbo/line-kind.js';

export { mapInvoiceToQboPayload } from './integrations/qbo/map-invoice.js';
export type {
  QboLineItemInput,
  QboAccountMappingEntry,
  QboAccountMap,
  MapInvoiceInput,
  MapInvoiceResult,
} from './integrations/qbo/map-invoice.js';

export {
  setQboAccountMapping,
  setQboAccountMappingWithDb,
  deleteQboAccountMapping,
  deleteQboAccountMappingWithDb,
} from './integrations/qbo/account-mapping.js';
export type {
  QboAccountMappingView,
  SetQboAccountMappingInput,
  SetQboAccountMappingResult,
  DeleteQboAccountMappingInput,
  DeleteQboAccountMappingResult,
} from './integrations/qbo/account-mapping.js';

export {
  getQboStatus,
  getQboStatusWithDb,
  isQboProviderConfigured,
} from './integrations/qbo/status.js';
export type {
  QboConnectionStatus,
  QboConnectionView,
  QboExportLogView,
  GetQboStatusResult,
} from './integrations/qbo/status.js';

export {
  buildQboAuthorizeUrl,
  completeQboOAuth,
  completeQboOAuthWithDb,
  disconnectQbo,
  disconnectQboWithDb,
} from './integrations/qbo/connect.js';
export type {
  BuildQboAuthorizeUrlResult,
  CompleteQboOAuthInput,
  CompleteQboOAuthResult,
  DisconnectQboResult,
} from './integrations/qbo/connect.js';

export {
  exportInvoiceToQbo,
  exportInvoiceToQboWithDb,
} from './integrations/qbo/export-invoice.js';
export type {
  ExportInvoiceToQboInput,
  ExportInvoiceToQboResult,
} from './integrations/qbo/export-invoice.js';

// ─── Slice B3-foundation — Stripe SEAM TO THE KEY BOUNDARY ─────────────────────
// NO real Stripe call anywhere until STRIPE_SECRET_KEY/STRIPE_WEBHOOK_SECRET
// are set (stub-when-unconfigured seam, exactly like the QBO + CAPTCHA seams).
// Migration 0023 staged + human-gated, NOT applied. PCI SAQ-A: NEVER stores
// raw card/bank data — only Stripe's own ids/amounts/status + Stripe-permitted
// last4/brand display fields.
//
// Provider seam: getStripeClient() (integrations/stripe/client.ts) — stub
//   when STRIPE_SECRET_KEY is unset (every call throws StripeNotConfiguredError;
//   callers convert to a typed not_configured refusal), real fetch-based
//   client (NO stripe npm package) otherwise.
// verifyStripeSignature: PURE, unit/property-tested HMAC-SHA256 signature
//   verification (integrations/stripe/webhook-verify.ts) — the ONLY place
//   webhook signatures are computed.
// createInvoicePaymentIntent: billing:manage, staff-initiated in this slice.
//   ACH-FIRST (payment_method_types defaults ['us_bank_account','card']).
//   Idempotent per invoice (a non-terminal-failure record blocks a second
//   PaymentIntent). NEVER settles anything — only a verified webhook does.
// getPaymentStatus: billing:access, READ-ONLY (reads OUR record; does NOT
//   call Stripe — webhooks are the source of truth, ADR-0015).
// handleStripeWebhookEvent: THE ONLY place a webhook is processed. Verifies
//   signature → dedups on stripe_event.event_id (PRIMARY KEY, INSERT-first)
//   → on payment_intent.succeeded, posts ONE 'payment' credit ledger_entry
//   (createdBy=null, SYSTEM) + updates payment_intent_record + ONE audit row,
//   all inside withOrgContext scoped to the org resolved via
//   resolveOrgByStripePaymentIntentId (a sanctioned platform-admin read,
//   mirrors auth/resolve-org.ts's resolveOrgBySlug exactly — org_id is NEVER
//   taken from the unauthenticated webhook payload itself).
// *WithDb forms / explicit `client` params are for test code only (inject a
// pglite client + a fake StripeClient — tests never make a real HTTP call).

export {
  StubStripeClient,
  RealStripeClient,
  getStripeClient,
  __resetStripeClientForTests,
  StripeNotConfiguredError,
  StripeProviderError,
  StripeSignatureVerificationError,
} from './integrations/stripe/client.js';
export type {
  StripeClient,
  StripeCreateCustomerInput,
  StripeCustomerResult,
  StripePaymentMethodType,
  StripeCreatePaymentIntentInput,
  StripePaymentIntentResult,
  StripeRetrievePaymentIntentResult,
  StripeWebhookEvent,
} from './integrations/stripe/client.js';

export { verifyStripeSignature } from './integrations/stripe/webhook-verify.js';
export type {
  VerifyStripeSignatureResult,
  VerifyStripeSignatureOptions,
} from './integrations/stripe/webhook-verify.js';

export { resolveOrgByStripePaymentIntentId } from './integrations/stripe/resolve-payment-intent.js';
export type { ResolvedPaymentIntent } from './integrations/stripe/resolve-payment-intent.js';

export {
  createInvoicePaymentIntent,
  createInvoicePaymentIntentWithDb,
  DEFAULT_PAYMENT_METHOD_TYPES,
} from './integrations/stripe/create-payment-intent.js';
export type {
  CreateInvoicePaymentIntentInput,
  CreateInvoicePaymentIntentResult,
} from './integrations/stripe/create-payment-intent.js';

export {
  getPaymentStatus,
  getPaymentStatusWithDb,
} from './integrations/stripe/get-payment-status.js';
export type {
  GetPaymentStatusInput,
  GetPaymentStatusResult,
  PaymentIntentRecordView,
} from './integrations/stripe/get-payment-status.js';

export { handleStripeWebhookEvent } from './integrations/stripe/handle-webhook-event.js';
export type { HandleStripeWebhookResult } from './integrations/stripe/handle-webhook-event.js';
