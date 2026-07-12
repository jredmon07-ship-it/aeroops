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
  MOBILE_ACCESS_TOKEN_MAX_AGE_SECONDS,
  // Slice 4M-REVOKE — Mobile refresh-token sessions ([VERIFY-4M-SEC-1])
  resolveMobileSessionByHash,
  issueMobileSession,
  issueMobileSessionWithDb,
  refreshMobileSession,
  refreshMobileSessionWithDb,
  revokeMobileSession,
  revokeMobileSessionWithDb,
  revokeAllMobileSessionsForUser,
  revokeAllMobileSessionsForUserWithDb,
  generateRefreshToken,
  hashRefreshToken,
} from './auth/index.js';

export type {
  AppSession,
  ResolvedOrg,
  VerifiedCredential,
  SessionOrgData,
  // Slice 4M.1 — Mobile claims type
  MobileClaims,
  // Slice 4M-REVOKE — Mobile refresh-token session types
  ResolvedMobileSession,
  IssuedMobileSession,
  IssueMobileSessionOpts,
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

// Line-ops service log (migration 0044) — OPTIONAL oil/fuel uplift + note
// recorded as a best-effort follow-up AFTER check-in. authz dispatch:create
// (same cap as close); ticket must be CLOSED; append-only INSERT + one audit
// row 'dispatch.service_recorded'; the FROZEN close path is UNTOUCHED. The read
// helper returns the latest (effective) service per ticket (dispatch:access).
// OPERATOR line-ops data; NO money; NOT a maintenance/Part-43 determination.
export {
  recordDispatchService,
  recordDispatchServiceWithDb,
  getDispatchServiceForTickets,
  getDispatchServiceForTicketsWithDb,
} from './dispatch/record-dispatch-service.js';
export type {
  RecordDispatchServiceInput,
  RecordDispatchServiceResult,
  DispatchServiceView,
} from './dispatch/record-dispatch-service.js';

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

// ─── Slice P1.5 — Maintenance-due reminders (migration 0029) ──────────────────
// Operator-defined per-aircraft maintenance items, tracked by an HOURS
// threshold (against the aircraft's LAST-RECORDED Hobbs/tach — DISPLAY-ONLY
// read, never recomputed) or a calendar DATE. evaluateMaintenanceDue
// (@aeroops/core, pure) computes ok/due_soon/overdue/unknown — ARITHMETIC on
// operator-entered thresholds, NOT a computed FAA/Part-43/91.409
// airworthiness or inspection-due determination. [VERIFY-P1.5-A]
// Reuses the EXISTING maintenance:access (read) / maintenance:work_order
// (write) caps — no new capability added for this slice.
// NO completion-history table — markMaintenanceItemServiced advances the
// threshold in place + writes one audit_log row (see maintenance-item.ts
// schema-file header for the rationale).
// *WithDb forms are for test code only (inject a pglite client).

export {
  createMaintenanceItem,
  createMaintenanceItemWithDb,
} from './maintenance/create-maintenance-item.js';
export type { CreateMaintenanceItemInput } from './maintenance/create-maintenance-item.js';

export {
  updateMaintenanceItem,
  updateMaintenanceItemWithDb,
} from './maintenance/update-maintenance-item.js';
export type { UpdateMaintenanceItemInput } from './maintenance/update-maintenance-item.js';

export {
  deactivateMaintenanceItem,
  deactivateMaintenanceItemWithDb,
} from './maintenance/deactivate-maintenance-item.js';
export type { DeactivateMaintenanceItemInput } from './maintenance/deactivate-maintenance-item.js';

export {
  markMaintenanceItemServiced,
  markMaintenanceItemServicedWithDb,
} from './maintenance/mark-maintenance-item-serviced.js';
export type { MarkMaintenanceItemServicedInput } from './maintenance/mark-maintenance-item-serviced.js';

export {
  listMaintenanceDue,
  listMaintenanceDueWithDb,
  getMaintenanceDueSummary,
  getMaintenanceDueSummaryWithDb,
} from './maintenance/list-maintenance-due.js';
export type { ListMaintenanceDueInput } from './maintenance/list-maintenance-due.js';

export {
  notifyMaintenanceDue,
  notifyMaintenanceDueWithDb,
} from './maintenance/notify-maintenance-due.js';
export type {
  NotifyMaintenanceDueInput,
  NotifyMaintenanceDueResult,
} from './maintenance/notify-maintenance-due.js';

// Maintenance-due result/IO types.
export type {
  MaintenanceItemView,
  MaintenanceDueView,
  MaintenanceDueSummary,
  CreateMaintenanceItemResult,
  UpdateMaintenanceItemResult,
  DeactivateMaintenanceItemResult,
  MarkMaintenanceItemServicedResult,
} from './maintenance/maintenance-item-types.js';

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
  listAircraftPage,
  listAircraftPageWithDb,
} from './fleet/list-aircraft.js';
export type { ListAircraftOptions } from './fleet/list-aircraft.js';
export type {
  AircraftCursor,
  ListAircraftPageOptions,
  ListAircraftPage,
} from './fleet/types.js';

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

// Location writes (base-airport management). authz fleet:manage; ONE audit row;
// coordinates are operator data, NOT an FAA determination. NO migration needed —
// location already permits org-scoped INSERT/UPDATE (RLS + grants, migration 0000).
export {
  createLocation,
  createLocationWithDb,
  updateLocation,
  updateLocationWithDb,
} from './fleet/location-commands.js';
export type {
  CreateLocationInput,
  UpdateLocationInput,
} from './fleet/location-commands.js';

// Fleet result/IO types.
export type {
  AircraftListRow,
  AircraftDetail,
  UpdateAircraftResult,
  LocationOption,
  CreateLocationResult,
  UpdateLocationResult,
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

export {
  listMembers,
  listMembersWithDb,
  listMembersPage,
  listMembersPageWithDb,
} from './people/list-members.js';
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
  MemberTagChipView,
  MemberTagColor,
  UpcomingMemberReservationRow,
  GetMemberDetailResult,
  UpdateMemberResult,
  SetMemberStatusResult,
  AddMemberTagResult,
  RemoveMemberTagResult,
  AddMemberResult,
  MemberCursor,
  ListMembersPageOptions,
  ListMembersPage,
} from './people/types.js';
// MEMBER_TAG_COLORS: the fixed palette KEY set a member tag may be colored with
// (migration 0041). Opaque presentation keys — the web maps a key to a literal
// class; [VERIFY-6-A] color is a display hint, no regulatory meaning.
export { MEMBER_TAG_COLORS } from './people/types.js';

// ─── Slice FC-P2 — Member expiration reminders (migration 0039) ──────────────
// Operator-entered FREE-TEXT reminder dates on a member (e.g. 'Medical',
// 'Flight review', 'Rental agreement'), surfaced WARN-ONLY on member detail
// and in the check-out dialog's pre-flight checklist. Expirations NEVER block
// dispatch — the FROZEN openDispatch gate is untouched.
// addMemberExpiration / deactivateMemberExpiration: people:manage (audited
// 'people.expiration_added' / 'people.expiration_deactivated').
// listMemberExpirations / listExpiringSoonForOrg: people:access (read-only).
// [VERIFY-FC-P2-A]: Operator-entered reminder dates. Not a medical/currency/
// legal determination — verifying actual validity remains the operator's and
// pilot's responsibility. Dates are 'YYYY-MM-DD' strings end to end.

export {
  addMemberExpiration,
  addMemberExpirationWithDb,
  deactivateMemberExpiration,
  deactivateMemberExpirationWithDb,
  listMemberExpirations,
  listMemberExpirationsWithDb,
  listExpiringSoonForOrg,
  listExpiringSoonForOrgWithDb,
  classifyExpiration,
  addDaysDateOnly,
  isValidDateOnly,
  todayDateOnlyUTC,
  EXPIRATION_DUE_SOON_DAYS,
} from './people/member-expirations.js';
export type {
  MemberExpirationView,
  MemberExpirationOrgRow,
  MemberExpirationStatus,
  AddMemberExpirationInput,
  DeactivateMemberExpirationInput,
  ListMemberExpirationsInput,
  ListExpiringSoonForOrgInput,
  AddMemberExpirationResult,
  DeactivateMemberExpirationResult,
  ListMemberExpirationsResult,
  ListExpiringSoonForOrgResult,
} from './people/member-expirations.js';

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

// getAircraftReport: FC-parity per-tail Aircraft report over the widened range —
// flights + Hobbs-derived hours + total oil (quarts) + total fuel (gallons),
// oil/fuel summed from the latest (effective) dispatch_service_log per ticket.
// reporting:access; RLS-scoped; read-only. [VERIFY-A] hours operational; oil/fuel
// are operator line-ops figures, NOT billing/airworthiness/maintenance records.
export {
  getAircraftReport,
  getAircraftReportWithDb,
} from './reporting/get-aircraft-report.js';
export type {
  GetAircraftReportInput,
  AircraftReportRow,
} from './reporting/get-aircraft-report.js';

// getInstructorUtilization: per-CFI utilization over the range — dispatch hours
// as pilot + 'recorded' lessons given + distinct students taught. ONE query,
// membership(role='cfi') anchored with two LEFT-JOIN subqueries; zero-activity
// CFIs appear (0/0/0). reporting:access; RLS-scoped. Operational/data counts —
// [VERIFY-A] NOT billable or a Part-141/61 determination.
export {
  getInstructorUtilization,
  getInstructorUtilizationWithDb,
} from './reporting/get-instructor-utilization.js';
export type {
  GetInstructorUtilizationInput,
  InstructorUtilizationRow,
} from './reporting/get-instructor-utilization.js';

// getSquawksReport: org-wide squawk list for the reports page, optional status
// filter, tail-number enriched. reporting:access (broader than list-squawks'
// maintenance:access); RLS-scoped; read-only. [VERIFY-M1-A] operator data.
export {
  getSquawksReport,
  getSquawksReportWithDb,
} from './reporting/get-squawks-report.js';
export type {
  GetSquawksReportInput,
  SquawkReportRow,
  SquawksReportResult,
} from './reporting/get-squawks-report.js';

// getMaintenanceRemindersReport: org-wide maintenance-due list for the reports
// page, optional computed-status filter, tail-number enriched. Reuses
// loadMaintenanceDueViews under reporting:access; RLS-scoped; read-only.
// [VERIFY-M1-A] arithmetic on operator thresholds, NOT an airworthiness call.
export {
  getMaintenanceRemindersReport,
  getMaintenanceRemindersReportWithDb,
} from './reporting/get-maintenance-reminders-report.js';
export type {
  GetMaintenanceRemindersReportInput,
  MaintenanceReminderReportRow,
  MaintenanceRemindersReportResult,
} from './reporting/get-maintenance-reminders-report.js';

// getCancellationsReport: org-wide list of CANCELLED reservations over a range,
// enriched with resource/tail, who cancelled, the (optional) stated reason
// (migration 0042), and a lead-time-before-start bucket (<24h / 1-7d / >7d) +
// totals. reporting:access; RLS-scoped; read-only. Operator activity data —
// NOT a billing or regulatory determination.
export {
  getCancellationsReport,
  getCancellationsReportWithDb,
  leadTimeBucketFor,
} from './reporting/get-cancellations-report.js';
export type {
  GetCancellationsReportInput,
  CancellationReportRow,
  CancellationsReportResult,
  CancellationLeadTimeBucket,
} from './reporting/get-cancellations-report.js';

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

// ─── Slice P2-SC1 — Stage-check enforcement (migration 0038, ADDITIVE) ────────
// OPERATOR-SET gate: when course.enforce_stage_checks (opt-in, default OFF =
// existing behavior byte-identical), recordLesson refuses
// { ok:false, reason:'stage_check_required', blockingLessonId } for a lesson
// positioned AFTER a stage-check lesson with no non-voided
// stage_check_passed=true record. Recording the stage check itself is always
// allowed. COMPLIANCE HARD LINE: enforces the OPERATOR's configured course
// structure ONLY — NOT a Part-61/141 stage check of record, NOT an FAA
// milestone/graduation/curriculum determination; stage_check_passed is an
// instructor-STATED outcome, never computed. Both toggles require
// training:manage and write ONE audit row each. Pure gate is property-tested.
export {
  setLessonStageCheck,
  setLessonStageCheckWithDb,
} from './training/set-lesson-stage-check.js';
export type { SetLessonStageCheckInput } from './training/set-lesson-stage-check.js';

export {
  setCourseStageCheckEnforcement,
  setCourseStageCheckEnforcementWithDb,
} from './training/set-course-stage-check-enforcement.js';
export type { SetCourseStageCheckEnforcementInput } from './training/set-course-stage-check-enforcement.js';

export { evaluateStageCheckGate } from './training/stage-check-gate.js';
export type {
  StageCheckGateLesson,
  StageCheckGateRecord,
  StageCheckGateResult,
} from './training/stage-check-gate.js';

// ─── Slice P2-ESIGN — E-signature on lesson records (APPEND-ONLY, migration 0032) ──
// COMPLIANCE HARD LINE [VERIFY-P2-A]: a lesson_signature is an operator/instructor
// ATTESTATION artifact — NOT an FAA-recognized digital/electronic signature, NOT a
// §61.51/§61.65/Part-141 endorsement of record, and computes NO training-completion/
// stage/graduation/currency determination. content_hash is a tamper-evidence digest
// (sha256 of canonicalLessonRecordSnapshot, @aeroops/core) — NOT a cryptographic/PKI
// signature. Voiding APPENDS a tombstone row (voided_by_signature_id self-ref) —
// there is NO UPDATE/DELETE code path (RLS backstop, migration 0032). Both write
// commands require training:manage; getLessonSignatures requires training:access.
export { signLessonRecord, signLessonRecordWithDb } from './training/sign-lesson-record.js';
export type { SignLessonRecordInput } from './training/sign-lesson-record.js';

export {
  voidLessonSignature,
  voidLessonSignatureWithDb,
} from './training/void-lesson-signature.js';
export type { VoidLessonSignatureInput } from './training/void-lesson-signature.js';

export {
  getLessonSignatures,
  getLessonSignaturesWithDb,
} from './training/get-lesson-signatures.js';
export type { GetLessonSignaturesInput } from './training/get-lesson-signatures.js';

// Training result/IO types.
export type {
  CourseListRow,
  CourseDetail,
  EnrollmentListRow,
  EnrollmentDetail,
  LessonProgressRow,
  LessonRecordView,
  MemberEnrollmentRow,
  LessonSignatureView,
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
  SetLessonStageCheckResult,
  SetCourseStageCheckEnforcementResult,
  SignLessonRecordResult,
  VoidLessonSignatureResult,
  GetLessonSignaturesResult,
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

// "Flights ready to invoice" worklist: CLOSED dispatch tickets with no live
// (non-void) invoice. READ-ONLY; billing:manage. Backs the one-click Generate-
// invoice surface on the Billing hub. No dispatch/meter write path touched.
export {
  listInvoiceableDispatch,
  listInvoiceableDispatchWithDb,
} from './billing/list-invoiceable-dispatch.js';
export type { InvoiceableDispatchRow } from './billing/list-invoiceable-dispatch.js';

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

// ─── FC-parity Slice 2 — Credit memo / adjustment (billing corrections) ──────
// issueCreditMemo: billing:manage, audited. Posts ONE 'credit_memo' CREDIT —
//   mirrors recordManualPayment exactly (same shape/guarantees), just a
//   different entry_type. issueAdjustment: billing:manage, audited. Posts ONE
//   'adjustment' entry in EITHER direction — REQUIRES a nonempty memo (an
//   unexplained adjustment is a records-integrity smell). Both entry_type
//   values have been in the ledger_entry_entry_type_check CHECK since
//   migration 0022 (re-widened in 0034) but NOTHING could post them before
//   this — NO migration needed for this slice.
// *WithDb forms are for test code only (inject a pglite client).

export {
  issueCreditMemo,
  issueCreditMemoWithDb,
  issueAdjustment,
  issueAdjustmentWithDb,
} from './billing/issue-ledger-adjustment.js';
export type {
  IssueCreditMemoInput,
  IssueCreditMemoResult,
  IssueAdjustmentInput,
  IssueAdjustmentResult,
} from './billing/issue-ledger-adjustment.js';

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
  StripeCardDeclinedError,
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
  StripeCreateSetupIntentInput,
  StripeSetupIntentResult,
  StripeAttachPaymentMethodInput,
  StripePaymentMethodDisplay,
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

// ─── Slice P0-REV — Revenue engine (self-pay + auto-pay + recurring dues) ─────
// Builds ADDITIVELY on B1 (invoices)/B2 (ledger+balance)/B3-foundation (Stripe
// seam). Migrations 0024 (payment methods + autopay) + 0025 (recurring dues)
// staged + human-gated, NOT applied. STOPS at the Stripe-KEY BOUNDARY — every
// call routes through the stub-when-unconfigured StripeClient seam; typed
// not_configured until keys exist. FROZEN dispatch gate
// (dispatch/open-dispatch.ts) is BYTE-IDENTICAL — untouched by this slice.
// WEBHOOKS REMAIN THE SOLE SETTLEMENT PATH: creating any PaymentIntent
// (staff, self-pay, OR off-session autopay) posts NO ledger entry — only a
// verified payment_intent.succeeded event (handleStripeWebhookEvent,
// unchanged credit logic) ever does.
//
// ensureStripeCustomerTx / createPaymentIntentForInvoiceTx: extracted shared
//   cores (reuse-or-create a stripe_customer; the PI-creation+idempotency
//   logic) — createInvoicePaymentIntent (staff) and payMyInvoice (self-pay
//   portal) both call the SAME core; behavior stays byte-equivalent to the
//   pre-extraction B3-foundation implementation.
// createInvoiceSetupIntent: billing:manage. Begins the save-a-PM flow
//   (SetupIntent client_secret for a Stripe Element). Audited.
// saveMyPaymentMethod (portal, self-scoped to session.userId): the confirm-
//   callback primary path — attaches the PM + records stripe_payment_method,
//   idempotent (ON CONFLICT DO NOTHING) vs the setup_intent.succeeded webhook
//   backstop (handle-webhook-event.ts, additive branch — resolves org via
//   resolveOrgByStripeCustomerId, a sanctioned platform-admin read backed by
//   migration 0024's stripe_customer_select policy addition).
// setMyAutopay (portal, self-scoped): explicit member opt-in. Requires a
//   SELF-OWNED saved PM when enabling — the DB CHECK
//   autopay_enabled_requires_pm (migration 0024) is the structural backstop.
// payMyInvoice (portal, self-scoped): pay one of the caller's OWN finalized
//   invoices — self-scope checked BEFORE the shared PI-creation core; a
//   foreign invoice returns not_found (zero-IDOR).
// getMyBilling (portal, self-scoped): own balance + own invoices + own saved
//   PMs (display only) + own autopay setting, in ONE org context.
//   [VERIFY-B2-PORTAL] resolved.
// triggerAutopayOnFinalize: called by finalizeInvoice (billing/invoice-
//   status-commands.js, additively extended — the finalize UPDATE+ledger-
//   debit+audit tx is BYTE-IDENTICAL) AFTER that tx commits. Off-session
//   PaymentIntent with a DETERMINISTIC `autopay:<invoiceId>` idempotency key
//   — three structural layers make a double-charge impossible (guarded
//   draft→finalized UPDATE fires once; the existing-payment_intent_record
//   guard; Stripe's own Idempotency-Key header). NEVER posts a ledger credit
//   itself. Declined → payment_intent_record 'failed', no credit, invoice
//   still finalized. Unconfigured → 'not_configured', invoice still
//   finalizes normally.
// createDuesSchedule / setDuesScheduleActive: billing:manage. Configure a
//   member's recurring-dues line. amount_cents = INTEGER CENTS.
// generateDuesInvoices: billing:manage, audited ('billing.dues_generated').
//   One DRAFT invoice per active dues_schedule per period, IDEMPOTENT per
//   (schedule, period) via dues_run's UNIQUE (org_id, dues_schedule_id,
//   period_key) — THE structural no-double-bill mechanism. SAFE TO CALL
//   REPEATEDLY. Finalizing a generated invoice flows into
//   triggerAutopayOnFinalize above, unchanged.
// getMemberBillingProfile (staff, billing:access, READ-ONLY): autopay status
//   + saved-PM presence (display only) + active dues schedules, for the
//   staff billing/accounts UI.
// *WithDb forms / explicit `client` params are for test code only (inject a
// pglite client + a fake StripeClient — tests never make a real HTTP call).

export { ensureStripeCustomerTx } from './integrations/stripe/ensure-customer.js';
export type { EnsureStripeCustomerResult } from './integrations/stripe/ensure-customer.js';

export {
  createPaymentIntentForInvoiceTx,
} from './integrations/stripe/create-payment-intent-core.js';
export type { CreatePaymentIntentForInvoiceResult } from './integrations/stripe/create-payment-intent-core.js';

export { resolveOrgByStripeCustomerId } from './integrations/stripe/resolve-payment-customer.js';
export type { ResolvedStripeCustomer } from './integrations/stripe/resolve-payment-customer.js';

export {
  createInvoiceSetupIntent,
  createInvoiceSetupIntentWithDb,
  DEFAULT_SETUP_PAYMENT_METHOD_TYPES,
} from './integrations/stripe/setup-intent-commands.js';
export type {
  CreateInvoiceSetupIntentInput,
  CreateInvoiceSetupIntentResult,
} from './integrations/stripe/setup-intent-commands.js';

export { triggerAutopayOnFinalize } from './integrations/stripe/autopay.js';
export type { AutopayOutcome, AutopayResult } from './integrations/stripe/autopay.js';

export {
  createMySetupIntent,
} from './portal/create-my-setup-intent.js';
export type { CreateMySetupIntentResult } from './portal/create-my-setup-intent.js';

export {
  saveMyPaymentMethod,
  saveMyPaymentMethodWithDb,
} from './portal/save-payment-method.js';
export type {
  SaveMyPaymentMethodInput,
  SaveMyPaymentMethodResult,
  SavedPaymentMethodView,
} from './portal/save-payment-method.js';

export {
  setMyAutopay,
  setMyAutopayWithDb,
} from './portal/set-autopay.js';
export type {
  SetMyAutopayInput,
  SetMyAutopayResult,
  AutopaySettingView,
} from './portal/set-autopay.js';

export {
  payMyInvoice,
  payMyInvoiceWithDb,
} from './portal/pay-invoice.js';
export type {
  PayMyInvoiceInput,
  PayMyInvoiceResult,
} from './portal/pay-invoice.js';

export {
  getMyBilling,
  getMyBillingWithDb,
} from './portal/get-my-billing.js';
export type { MyBillingView } from './portal/get-my-billing.js';

// ─── Fee-passing + pay-full-balance (migration 0045, staged NOT applied) ─────
// FEE-PASSING (default OFF → byte-identical): per-org toggle
// dispatch_config.pass_ach_fee_to_member. When ON, the portal quotes invoice /
// balance payments GROSSED UP by min(round(base × 1%), $15). The created
// PaymentIntent charges the gross + carries {baseCents, feeCents} metadata; the
// webhook ledger credit posts the BASE only (the fee is the platform's — the
// real fee split activates with Stripe Connect later).
// PAY FULL BALANCE: payMyBalance creates ONE PaymentIntent for the magnitude of
// the member's negative balance (kind='balance_payment'); the webhook posts one
// 'payment' credit for the base, naturally zeroing the balance (invoice rows
// untouched). Fee-passing applies here too when ON.
// GRACEFUL ABSENCE: every read/write of the 0045 schema is guarded — the fee
// toggle reports available:false and payMyBalance returns not_available until a
// human applies 0045. getFeePassing/setFeePassing gated by org:manage_settings;
// payMyBalance gated by portal:access (self-scoped to session.userId).
export {
  getFeePassing,
  getFeePassingWithDb,
  setFeePassing,
  setFeePassingWithDb,
} from './billing/fee-passing-setting.js';
export type {
  FeePassingView,
  GetFeePassingResult,
  SetFeePassingInput,
  SetFeePassingResult,
} from './billing/fee-passing-setting.js';

export {
  payMyBalance,
  payMyBalanceWithDb,
} from './portal/pay-balance.js';
export type { PayMyBalanceResult } from './portal/pay-balance.js';

export {
  createDuesSchedule,
  createDuesScheduleWithDb,
  setDuesScheduleActive,
  setDuesScheduleActiveWithDb,
} from './billing/dues-schedule-commands.js';
export type {
  DuesScheduleView,
  CreateDuesScheduleInput,
  CreateDuesScheduleResult,
  SetDuesScheduleActiveInput,
  SetDuesScheduleActiveResult,
} from './billing/dues-schedule-commands.js';

export {
  generateDuesInvoices,
  generateDuesInvoicesWithDb,
} from './billing/generate-dues-invoices.js';
export type {
  GenerateDuesInvoicesInput,
  GenerateDuesInvoicesResult,
  GenerateDuesInvoicesCreated,
  GenerateDuesInvoicesSkipped,
} from './billing/generate-dues-invoices.js';

export {
  getMemberBillingProfile,
  getMemberBillingProfileWithDb,
} from './billing/get-member-billing-profile.js';
export type {
  GetMemberBillingProfileInput,
  GetMemberBillingProfileResult,
  MemberBillingProfile,
  MemberBillingProfileDefaultPaymentMethod,
} from './billing/get-member-billing-profile.js';

// ─── Financial / AR reporting slice — READ-ONLY over existing billing tables ──
// NO new migration, NO schema change. billing:access (owner/manager/accountant)
// FIRST on every read — NOT reporting:access (this is MONEY data; narrower cap).
// Integer cents throughout; NO float in the money path. OPERATIONAL reporting —
// NOT a tax/GAAP/audit determination. See docs/specs/slice-billing-reports.md.
// getAccountsReceivable: per-member outstanding balance aged into 5 buckets
//   (current/1-30/31-60/61-90/90+ days) via @aeroops/core's aggregateAging,
//   plus org totals. A credit/zero balance is excluded, never shown as an AR row.
// getRevenueReport: finalized-invoice totals + collected-payment totals over a
//   rolling UTC range, with the R1.1 day/week bucket breakdown (reuses
//   reporting/internal.ts's resolveReportRange/chooseGranularity/bucketStartUtc/
//   enumerateBuckets, UNCHANGED).
// getMemberStatement: STAFF view (billing:access) — one member's invoices +
//   chronological ledger history with a running balance. Distinct from the
//   member's own portal self-view (portal:access, untouched here).
// *WithDb forms are for test code only (inject a pglite client).

export {
  getAccountsReceivable,
  getAccountsReceivableWithDb,
} from './billing/get-accounts-receivable.js';
export type {
  AccountsReceivableRow,
  AccountsReceivableResult,
} from './billing/get-accounts-receivable.js';

export {
  getRevenueReport,
  getRevenueReportWithDb,
} from './billing/get-revenue-report.js';
export type {
  GetRevenueReportInput,
  RevenueReportBucket,
  RevenueReportResult,
} from './billing/get-revenue-report.js';

export {
  getMemberStatement,
  getMemberStatementWithDb,
} from './billing/get-member-statement.js';
export type {
  GetMemberStatementInput,
  GetMemberStatementResult,
  MemberStatement,
  MemberStatementLedgerRow,
} from './billing/get-member-statement.js';

// getItemsSoldReport: per-product POS sell-through over a rolling UTC range —
// qty sold + gross cents on FINALIZED counter-sale lines (name-snapshot link to
// product_catalog, no FK). taxCents is a documented 0 (0031 models no tax yet,
// [VERIFY-P2-A]). billing:access; integer cents; RLS-scoped; read-only.
export {
  getItemsSoldReport,
  getItemsSoldReportWithDb,
} from './billing/get-items-sold-report.js';
export type {
  GetItemsSoldReportInput,
  ItemsSoldRow,
  ItemsSoldReportResult,
} from './billing/get-items-sold-report.js';

// getPaymentsReport: every 'payment' ledger_entry over a rolling UTC range —
// date, member, amount, reference (paymentId/memo) + period totals.
// billing:access; integer cents; RLS-scoped; read-only.
export {
  getPaymentsReport,
  getPaymentsReportWithDb,
} from './billing/get-payments-report.js';
export type {
  GetPaymentsReportInput,
  PaymentReportRow,
  PaymentsReportResult,
} from './billing/get-payments-report.js';

// getAdjustmentsReport: every 'credit_memo' + 'adjustment' ledger_entry over a
// rolling UTC range — type, direction, amount, memo, who + totals by direction.
// billing:access; integer cents; RLS-scoped; read-only.
export {
  getAdjustmentsReport,
  getAdjustmentsReportWithDb,
} from './billing/get-adjustments-report.js';
export type {
  GetAdjustmentsReportInput,
  AdjustmentReportRow,
  AdjustmentsReportResult,
} from './billing/get-adjustments-report.js';

// getTaxesOwedReport: sales-tax collected over POS activity, bucketed by period.
// The schema models NO tax (0031, [VERIFY-P2-A]) — taxCents is a documented 0
// over the finalized POS taxable base. billing:access; integer cents; read-only.
export {
  getTaxesOwedReport,
  getTaxesOwedReportWithDb,
} from './billing/get-taxes-owed-report.js';
export type {
  GetTaxesOwedReportInput,
  TaxesOwedReportBucket,
  TaxesOwedReportResult,
} from './billing/get-taxes-owed-report.js';

// ════════════════════════════════════════════════════════════════════════════════
// Slice P1.3 — Email notifications
//
// Best-effort, never-throwing (mirrors demo/reset.ts's maybeResetDemoTenant).
// sendNotification is the ONE function every hook calls; it resolves the
// recipient + pref, renders a pure template, calls the provider seam (stub
// when EMAIL_API_KEY/EMAIL_FROM unset — never a real HTTP call), and writes
// exactly one notification_log row. NO SMS/push in this slice. Hooks live at
// the WEB ACTION LAYER (apps/web) — see docs/specs/slice-p1-notifications.md.
// ════════════════════════════════════════════════════════════════════════════════

export {
  getEmailProvider,
  StubEmailProvider,
  RealEmailProvider,
  EmailProviderError,
  __resetEmailProviderForTests,
} from './notifications/email-provider.js';
export type {
  EmailProvider,
  SendEmailInput,
  SendEmailResult,
} from './notifications/email-provider.js';

export { renderNotificationTemplate } from './notifications/templates.js';

export {
  NOTIFICATION_EVENT_TYPES,
  isNotificationEventType,
} from './notifications/email-event-types.js';
export type {
  NotificationEventType,
  NotificationTemplateDataMap,
  RenderedEmail,
  ReservationCreatedData,
  SquawkReportedData,
  AircraftGroundedData,
  InvoiceFinalizedData,
  PaymentFailedData,
  DuesGeneratedData,
  OrgAnnouncementData,
} from './notifications/email-event-types.js';

export {
  sendNotification,
  sendNotificationWithDb,
} from './notifications/send-notification.js';
export type {
  SendNotificationInput,
  SendNotificationResult,
} from './notifications/send-notification.js';

export {
  getMyNotificationPrefs,
  getMyNotificationPrefsWithDb,
  setMyNotificationPref,
  setMyNotificationPrefWithDb,
} from './notifications/prefs.js';
export type {
  NotificationPrefView,
  SetMyNotificationPrefResult,
} from './notifications/prefs.js';

// ════════════════════════════════════════════════════════════════════════════════
// Slice FC-P1 — Member messaging / announcements (FC-parity "Engage with
// Messaging by Email"). NEW member_message table (migration 0036 — STAGED,
// human-gated, NOT applied); event type 'org.announcement' added to
// NOTIFICATION_EVENT_TYPES above. Fans out via the EXISTING sendNotification
// dispatcher — one best-effort email per resolved recipient.
// ════════════════════════════════════════════════════════════════════════════════

export {
  sendMemberMessage,
  sendMemberMessageWithDb,
  previewMemberMessageRecipients,
  previewMemberMessageRecipientsWithDb,
  listMemberMessages,
  listMemberMessagesWithDb,
} from './notifications/send-member-message.js';
export type {
  SendMemberMessageInput,
  SendMemberMessageResult,
  PreviewMemberMessageRecipientsResult,
  MemberMessageView,
} from './notifications/send-member-message.js';

// ════════════════════════════════════════════════════════════════════════════════
// Slice P1.7 — Flight Circle data importer
//
// Operator-provided CSV import of members + aircraft roster data (the
// fast-onboarding path — "migrate off Flight Circle" in an afternoon). ALL
// writes route through the EXISTING addMember (people) / createResource +
// updateAircraft (fleet) paths — never a bespoke INSERT into app_user or
// resource. NO ledger/financial-history import in this slice — see
// docs/specs/slice-p1-fc-import.md.
// ════════════════════════════════════════════════════════════════════════════════

export { previewImport, previewImportWithDb } from './import/preview-import.js';

export { commitImport, commitImportWithDb } from './import/commit-import.js';

export {
  listImportBatches,
  listImportBatchesWithDb,
} from './import/list-import-batches.js';
export type { ListImportBatchesInput } from './import/list-import-batches.js';

export { getImportBatch, getImportBatchWithDb } from './import/get-import-batch.js';
export type { GetImportBatchInput } from './import/get-import-batch.js';

export type {
  ImportKind,
  ImportSource,
  ColumnMapping,
  ImportBatchStatus,
  ImportRowStatus,
  ImportBatchView,
  ImportRowView,
  PreviewImportInput,
  PreviewImportResult,
  CommitImportInput,
  CommitImportRowResult,
  CommitImportResult,
  GetImportBatchResult,
} from './import/types.js';

// ════════════════════════════════════════════════════════════════════════════════
// Slice P1.4 — iCal / subscribable calendar feeds
//
// Read-only .ics subscription feeds for Apple Calendar / Google Calendar /
// Outlook: either a member's OWN reservations (scope='my_reservations',
// self-scoped) or one aircraft's schedule (scope='aircraft'). Served over an
// UNAUTHENTICATED-but-UNGUESSABLE per-feed token URL (a calendar app cannot
// do session auth) — the same capability-URL pattern as the mobile bearer
// token (ADR-0010). resolveFeedByToken is the ONE sanctioned platform-admin
// read in this path (mirrors resolveOrgBySlug / resolveOrgByStripe
// PaymentIntentId); buildIcsForFeed does every reservation read inside
// withOrgContext using the org_id THAT function resolved from calendar_feed,
// never from caller input. NO money; NO FAA/regulatory determination — a
// plain read-only calendar mirror of existing scheduling data.
// ════════════════════════════════════════════════════════════════════════════════

export {
  createCalendarFeed,
  createCalendarFeedWithDb,
} from './calendar/create-calendar-feed.js';
export type {
  CreateCalendarFeedInput,
  CreateCalendarFeedResult,
  CalendarFeedView,
} from './calendar/create-calendar-feed.js';

export {
  listMyCalendarFeeds,
  listMyCalendarFeedsWithDb,
} from './calendar/list-my-calendar-feeds.js';

export {
  revokeCalendarFeed,
  revokeCalendarFeedWithDb,
  regenerateCalendarFeed,
  regenerateCalendarFeedWithDb,
} from './calendar/revoke-calendar-feed.js';
export type {
  RevokeCalendarFeedInput,
  RevokeCalendarFeedResult,
  RegenerateCalendarFeedInput,
  RegenerateCalendarFeedResult,
} from './calendar/revoke-calendar-feed.js';

// resolveFeedByToken / buildIcsForFeed: the public .ics route's ONLY two
// calls (apps/web/app/api/calendar/[token]/route.ts) — see each file's
// header for the platform-admin-read / org-context-read justification.
export { resolveFeedByToken } from './calendar/resolve-feed.js';
export type { ResolvedCalendarFeed } from './calendar/resolve-feed.js';

export { buildIcsForFeed } from './calendar/build-ics-for-feed.js';

// ════════════════════════════════════════════════════════════════════════════
// Slice P1.6 — Document storage
//
// File uploads attached to a MEMBER (app_user) or an AIRCRAFT (resource) via
// pre-signed object-storage URLs — the browser PUTs/GETs directly to
// storage; the Node server only ever signs URLs and stores metadata rows.
// NO file bytes ever pass through Postgres or the app server.
//
// COMPLIANCE (HARD LINE): a document is STORED, NEVER INTERPRETED — no OCR,
// no computed FAA/currency/medical-validity/eligibility/airworthiness
// determination from an uploaded file's contents. category = FREE-TEXT
// operator label only. [VERIFY-P1.6-A]
//
// TENANT ISOLATION: storage_key is ALWAYS server-generated (documents/
// internal.ts generateStorageKey), ALWAYS prefixed `org/<sess.orgId>/...`
// from the session — NEVER client input. One org's signed URL can never be
// minted for a key under a different org's prefix.
// ════════════════════════════════════════════════════════════════════════════

// storage provider seam
export {
  getStorageProvider,
  StubStorageProvider,
  RealStorageProvider,
  __resetStorageProviderForTests,
} from './storage/provider.js';
export type { StorageProvider, StorageSignResult, StorageDeleteResult } from './storage/provider.js';

export { requestUpload, requestUploadWithDb } from './documents/request-upload.js';
export type { RequestUploadInput } from './documents/request-upload.js';

export { confirmUpload, confirmUploadWithDb } from './documents/confirm-upload.js';
export type { ConfirmUploadInput } from './documents/confirm-upload.js';

export { listDocuments, listDocumentsWithDb } from './documents/list-documents.js';
export type { ListDocumentsInput } from './documents/list-documents.js';

export { getDownloadUrl, getDownloadUrlWithDb } from './documents/get-download-url.js';
export type { GetDownloadUrlInput } from './documents/get-download-url.js';

export { deleteDocument, deleteDocumentWithDb } from './documents/delete-document.js';
export type { DeleteDocumentInput } from './documents/delete-document.js';

export type {
  DocumentOwnerType,
  DocumentStatus,
  DocumentView,
  RequestUploadResult,
  ConfirmUploadResult,
  ListDocumentsResult,
  GetDownloadUrlResult,
  DeleteDocumentResult,
} from './documents/types.js';

// Portal self-scoped reads (Slice P1.6 — read-only in the portal this slice;
// upload/delete stay staff-only). SELF-SCOPED to session.userId ONLY.
export { getMyDocuments, getMyDocumentsWithDb } from './portal/get-my-documents.js';

export {
  getMyDocumentDownloadUrl,
  getMyDocumentDownloadUrlWithDb,
} from './portal/get-my-document-download-url.js';
export type { GetMyDocumentDownloadUrlInput } from './portal/get-my-document-download-url.js';

// ════════════════════════════════════════════════════════════════════════════
// Slice P2 — Pilot Logbook (derived, read-only + CSV export; NO migration)
//
// A CONVENIENCE VIEW of the operator's dispatch history — NOT the pilot's
// official/certified §61.51 logbook of record. Makes NO currency/experience/
// §61.51/§61.57 determination (disclaimer verbatim on the web surfaces).
// Reads CLOSED dispatch_ticket rows only (open/voided excluded); flightTime
// is DERIVED via @aeroops/core's deriveFlightTime (display-only, never
// persisted/recomputed on the FROZEN dispatch write paths). Deliberately does
// NOT apply dispatch_ticket_correction — see [VERIFY-P2-LOG-A].
//
// SECURITY INVARIANTS:
//   - getMyPilotLog/exportMyPilotLogCsv: requireCapability('portal:access')
//     FIRST; subject is ALWAYS session.userId (self-scoped, zero IDOR).
//   - getPilotLog/exportPilotLogCsv: requireCapability('people:access')
//     FIRST; cross-org/non-member userId → not_found (never rows).
//   - org_id from session only; RLS is the org backstop.
//   - CSV exports write exactly ONE audit_log row (action
//     'pilot_log.exported'); non-export reads are NOT audited. NO money.
// *WithDb forms are for test code only (inject a pglite client).
// ════════════════════════════════════════════════════════════════════════════

export { getMyPilotLog, getMyPilotLogWithDb } from './logbook/get-my-pilot-log.js';
export type { GetMyPilotLogInput } from './logbook/get-my-pilot-log.js';

export { getPilotLog, getPilotLogWithDb } from './logbook/get-pilot-log.js';
export type { GetPilotLogInput, GetPilotLogResult } from './logbook/get-pilot-log.js';

export {
  exportMyPilotLogCsv,
  exportMyPilotLogCsvWithDb,
} from './logbook/export-my-pilot-log-csv.js';
export type { ExportMyPilotLogCsvInput } from './logbook/export-my-pilot-log-csv.js';

export {
  exportPilotLogCsv,
  exportPilotLogCsvWithDb,
} from './logbook/export-pilot-log-csv.js';
export type {
  ExportPilotLogCsvInput,
  ExportPilotLogCsvResult,
} from './logbook/export-pilot-log-csv.js';

export type { PilotLogEntry, PilotLog, PilotLogCsvResult } from './logbook/types.js';

// ════════════════════════════════════════════════════════════════════════════
// Slice P2-LOG2 — Pilot-logbook depth: flight-condition annotations +
// aircraft category/class (migration 0037 — STAGED, human-gated, NOT applied)
//
// annotateFlight — APPEND one logbook_annotation row (night / instrument /
// cross-country hours + remarks) to a CLOSED dispatch ticket. The effective
// annotation is the LATEST row per ticket (dispatch_ticket_correction's
// latest-wins pattern); rows are immutable (SELECT + INSERT RLS only). The
// FROZEN dispatch close path is untouched. The logbook reads + CSV exports
// LEFT JOIN the latest annotation + resource.category / aircraft_class.
//
// COMPLIANCE HARD LINE: pilot/operator-entered data — NOT an FAA logbook of
// record, NOT a certified §61.51 entry; NO computed §61.51/§61.57 currency
// determination. category/aircraft_class are FREE TEXT identity fields.
//
// SECURITY INVARIANTS:
//   - Staff path: requireCapability('people:access') — annotate any in-org
//     pilot's CLOSED ticket (mirrors the staff logbook reads).
//   - Self path: requireCapability('portal:access') AND the ticket's
//     pilot_user_id must be session.userId (else not_found — anti-enumeration).
//   - pilot_user_id is snapshotted from the ticket — NEVER caller-supplied.
//   - org_id from session only; RLS backstop; ONE audit row
//     'logbook.flight_annotated'. NO money.
// *WithDb form is for test code only (inject a pglite client).
// ════════════════════════════════════════════════════════════════════════════

export { annotateFlight, annotateFlightWithDb } from './logbook/annotate-flight.js';
export type {
  AnnotateFlightInput,
  AnnotateFlightResult,
  LogbookAnnotationView,
} from './logbook/annotate-flight.js';

// ════════════════════════════════════════════════════════════════════════════
// Slice P2 — POS / Counter Sales (product catalog + non-dispatch sale)
//
// Sell non-flight items (headsets, charts, fuel, merch) as an invoice whose
// lines are catalog/ad-hoc items instead of dispatch-derived ones. Rides the
// EXISTING B1 invoice/invoice_line_item write path (via
// insertDraftInvoiceWithLinesTx — NO bespoke invoice INSERT) + the existing
// B2 ledger + P0 payments unchanged: a counter-sale draft invoice finalizes
// through the SAME, untouched finalizeInvoice.
//
// MONEY: INTEGER CENTS ONLY throughout (product_catalog.unit_price_cents CHECK
// > 0; computeCounterSaleLineTotal is an EXACT integer product — no rounding,
// no float step). NO Stripe/card/bank data here — createCounterSale only
// ever creates a DRAFT invoice; money moves later, only via finalizeInvoice's
// existing, unchanged path.
//
// CAPS: billing:manage (owner/manager) for catalog writes + createCounterSale;
// billing:access (+ accountant) for catalog reads. NO new caps.
//
// COMPLIANCE: sku/category are FREE-TEXT operator labels — NOT a tax class.
// This slice computes NO tax. [VERIFY-P2-A]: sales-tax posture deferred.
// See docs/specs/slice-p2-pos.md.
// ════════════════════════════════════════════════════════════════════════════

export {
  createProductCatalogItem,
  createProductCatalogItemWithDb,
  updateProductCatalogItem,
  updateProductCatalogItemWithDb,
  listProductCatalogItems,
  listProductCatalogItemsWithDb,
  deleteProductCatalogItem,
  deleteProductCatalogItemWithDb,
} from './billing/product-catalog-commands.js';
export type {
  ProductCatalogView,
  CreateProductCatalogItemInput,
  CreateProductCatalogItemResult,
  UpdateProductCatalogItemInput,
  UpdateProductCatalogItemResult,
  ListProductCatalogItemsOptions,
  ListProductCatalogItemsResult,
  DeleteProductCatalogItemInput,
  DeleteProductCatalogItemResult,
} from './billing/product-catalog-commands.js';

export { createCounterSale, createCounterSaleWithDb } from './billing/counter-sale.js';
export type {
  CounterSaleLineInput,
  CreateCounterSaleInput,
  CreateCounterSaleResult,
} from './billing/counter-sale.js';

// ════════════════════════════════════════════════════════════════════════════
// Slice W1 — METAR weather (display-only, informational)
//
// getMetarForAircraft: read-only current METAR for an aircraft's home-base
// ICAO (cap: schedule:access — the same base viewing capability the board and
// new-reservation surfaces already require). Resolves the aircraft →
// home-base → ICAO via the RLS-scoped resource/location join (mirrors
// loadTwilightContext exactly); no ICAO configured, a non-aircraft resource,
// a cross-org id, or ANY provider failure all converge on `null` — a graceful
// no-chip empty state, never a 500, never a peek.
//
// getWeatherProvider/AwcWeatherProvider: the free, keyless AWC (Aviation
// Weather Center) fetch-client seam — best-effort, NEVER throws.
//
// COMPLIANCE: weather is advisory/situational ONLY — NEVER a computed go/
// no-go, airworthiness, or dispatch determination (same posture as civil
// twilight / grounding). See docs/specs/slice-weather-metar.md. Must NEVER be
// wired into a gate/block write path — this is a passive display read.
// ════════════════════════════════════════════════════════════════════════════

export {
  getMetarForAircraft,
  getMetarForAircraftWithDb,
} from './weather/get-metar-for-aircraft.js';
export type { GetMetarForAircraftInput } from './weather/get-metar-for-aircraft.js';
// ParsedMetar/FlightCategory are @aeroops/core types — re-exported here so web
// callers of getMetarForAircraft never need a direct @aeroops/core import.
export type { ParsedMetar, FlightCategory } from '@aeroops/core';

export {
  getWeatherProvider,
  AwcWeatherProvider,
  __resetWeatherProviderForTests,
} from './weather/provider.js';
export type { WeatherProvider } from './weather/provider.js';

// getOrgFieldStatus: read-only field status for the org's PRIMARY/home-base
// airport (ops status bar — cap: app:access, every role). Primary location =
// home base of the most active aircraft (RLS-scoped, stable tiebreak). Returns
// station + raw METAR + standard flight category + temp/wind + today's
// sunrise/sunset (pure computeSolarEvents at the base coords). SHORT in-process
// per-station METAR cache; FAIL SOFT — any provider/DB hiccup degrades to
// null fields or { available: false }, never an error to the shell.
// COMPLIANCE: advisory display ONLY — not a weather briefing, never a go/no-go
// or dispatch determination; must NEVER be wired into a gate/block write path.
export {
  getOrgFieldStatus,
  getOrgFieldStatusWithDb,
  parseWindDirDegFromRaw,
  parseTempCFromRaw,
  __resetOrgFieldStatusCacheForTests,
} from './weather/get-org-field-status.js';
export type {
  OrgFieldStatusData,
  OrgFieldStatusResult,
} from './weather/get-org-field-status.js';

// ════════════════════════════════════════════════════════════════════════════
// Slice Onboarding — guided setup checklist (derived read-only, NO migration)
//
// getOnboardingStatus: inspects what the org has configured (aircraft, people,
// base-airport coords, billing rates, booking policies, payments) and returns a
// typed checklist that scales from a 2-plane club to a large academy —
// essentials (aircraft + people) vs optional depth. Cap: org:manage_settings
// (owner/manager — setup is an admin task). One RLS-scoped COUNT per step;
// tenant-isolated; no external calls. Powers the /setup page + dashboard banner.
// *WithDb form is for test code only (inject a pglite client).
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// Slice B4 — Block-time / prepaid packages (NO Stripe, NO money-boundary crossing)
//
// "Block time" (THE-BIBLE glossary) = a prepaid, discounted hour bundle a
// member buys up front and draws down as they fly. This slice records
// OPERATOR BILLING DATA on the EXISTING B2 ledger — exactly like
// recordManualPayment: a block sale posts ONE 'block_purchase' credit
// ledger_entry (migration 0034 additively widens ledger_entry.entry_type to
// allow it), which RAISES the member's derived balance (computeBalance);
// the EXISTING invoice-finalize debit draws it down automatically. NO
// Stripe, NO card/bank data, NO money moved by anything in this slice.
//
// block_package (MUTABLE master data, byte-identical RLS shape to
//   product_catalog): create/update/deactivate/list, cap billing:manage for
//   writes, billing:access for list. Effective discounted rate (price_cents
//   / hours) is DISPLAY ONLY (computeEffectiveRateCentsPerHour, @aeroops/core)
//   — never stored.
// sellBlockToMember (cap billing:manage): ATOMICALLY resolves a package sale
//   or an ad-hoc hours+amountCents sale → INSERTs ONE APPEND-ONLY
//   block_purchase row → posts ONE 'block_purchase' ledger credit → ONE
//   audit row, all in the SAME tx (rollback-on-any-failure).
// getMemberBlockSummary (staff, billing:access) / getMyBlockSummary (portal
//   self-view, portal:access): purchase totals (pure, property-tested
//   aggregateBlockPurchases, @aeroops/core) + prepaidBalanceCents =
//   max(0, derived ledger balance) + purchase history. Share the SAME reader
//   (block-time-internal.ts, not barrel-exported) so the two views can never
//   disagree.
//
// MONEY: INTEGER CENTS ONLY throughout (price_cents/amount_cents CHECK > 0).
// hours is numeric(10,1) — a QUANTITY, NOT money.
//
// COMPLIANCE: operator billing records, NOT tax/GAAP/FAA guidance. NO
// airworthiness/currency determination. [DEFERRED — v1, see
// docs/specs/slice-b4-block-time.md]: hours-based per-flight discounted-rate
// drawdown, block expiry/refund, family/shared blocks, selling a block
// through the Stripe rail (money-boundary, founder-gated).
// ════════════════════════════════════════════════════════════════════════════

export {
  createBlockPackage,
  createBlockPackageWithDb,
  updateBlockPackage,
  updateBlockPackageWithDb,
  deactivateBlockPackage,
  deactivateBlockPackageWithDb,
  listBlockPackages,
  listBlockPackagesWithDb,
} from './billing/block-package-commands.js';
export type {
  BlockPackageView,
  CreateBlockPackageInput,
  CreateBlockPackageResult,
  UpdateBlockPackageInput,
  UpdateBlockPackageResult,
  DeactivateBlockPackageInput,
  DeactivateBlockPackageResult,
  ListBlockPackagesOptions,
  ListBlockPackagesResult,
} from './billing/block-package-commands.js';

export { sellBlockToMember, sellBlockToMemberWithDb } from './billing/sell-block.js';
export type {
  BlockPurchaseView,
  SellBlockToMemberInput,
  SellBlockToMemberResult,
} from './billing/sell-block.js';

export {
  getMemberBlockSummary,
  getMemberBlockSummaryWithDb,
} from './billing/get-member-block-summary.js';
export type {
  MemberBlockSummary,
  GetMemberBlockSummaryInput,
  GetMemberBlockSummaryResult,
} from './billing/get-member-block-summary.js';

export {
  getMyBlockSummary,
  getMyBlockSummaryWithDb,
} from './portal/get-my-block-summary.js';
export type { MyBlockSummary } from './portal/get-my-block-summary.js';

// ════════════════════════════════════════════════════════════════════════════
// Slice Onboarding — guided setup checklist (derived read-only, NO migration)
//
// getOnboardingStatus: inspects what the org has configured (aircraft, people,
// base-airport coords, billing rates, booking policies, payments) and returns a
// typed checklist that scales from a 2-plane club to a large academy —
// essentials (aircraft + people) vs optional depth. Cap: org:manage_settings
// (owner/manager — setup is an admin task). One RLS-scoped COUNT per step;
// tenant-isolated; no external calls. Powers the /setup page + dashboard banner.
// *WithDb form is for test code only (inject a pglite client).
// ════════════════════════════════════════════════════════════════════════════

export {
  getOnboardingStatus,
  getOnboardingStatusWithDb,
} from './onboarding/get-onboarding-status.js';
export type {
  OnboardingStatus,
  OnboardingStep,
  OnboardingStepKey,
} from './onboarding/get-onboarding-status.js';
