/**
 * @aeroops/api — public surface.
 *
 * Exports the auth module (Slice 0.2) and RBAC + dashboard module (Slice 0.3).
 * Additional modules (scheduling, dispatch, etc.) were added in later slices.
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
  // Web login claims (MobileClaims + the session credential fingerprint)
  LoginClaims,
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
// add new member (roster entry — NO auth_credential; a login comes from a
// login link, below). people:access = read;
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

export { updateMember, updateMemberWithDb, roleChangePermission } from './people/update-member.js';
export type { RoleChangeRefusal } from './people/update-member.js';
export type { UpdateMemberInput } from './people/update-member.js';

export { setMemberStatus, setMemberStatusWithDb } from './people/set-member-status.js';
export type { SetMemberStatusInput } from './people/set-member-status.js';

export { addMemberTag, addMemberTagWithDb } from './people/add-member-tag.js';
export type { AddMemberTagInput } from './people/add-member-tag.js';

export { removeMemberTag, removeMemberTagWithDb } from './people/remove-member-tag.js';
export type { RemoveMemberTagInput } from './people/remove-member-tag.js';

export { addMember, addMemberWithDb } from './people/add-member.js';
export type { AddMemberInput } from './people/add-member.js';

// ─── Login links — how a member gets (or resets) a login ─────────────────────
// Stateless signed single-use link (AUTH_SECRET, own salt + purpose, 7 days,
// credential fingerprint). createLoginLink: people:manage + owner-only for
// owner/manager targets; audited. checkLoginLink / acceptLoginLink:
// UNAUTHENTICATED (the token is the auth); accept sets/replaces the
// auth_credential with the signup password policy; audited. NO migration.
export {
  createLoginLink,
  createLoginLinkWithDb,
  checkLoginLink,
  checkLoginLinkWithDb,
  acceptLoginLink,
  acceptLoginLinkWithDb,
  loginLinkPermission,
} from './people/login-link.js';
export type {
  LoginLinkMode,
  LoginLinkRefusal,
  CreateLoginLinkInput,
  CreateLoginLinkResult,
  CheckLoginLinkResult,
  AcceptLoginLinkInput,
  AcceptLoginLinkResult,
  LoginLinkRef,
} from './people/login-link.js';
export {
  signLoginLinkToken,
  verifyLoginLinkToken,
  credentialFingerprint,
  LOGIN_LINK_MAX_AGE_SECONDS,
} from './auth/login-link-token.js';
export type { LoginLinkClaims } from './auth/login-link-token.js';
export { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from './auth/password-policy.js';

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
// openDispatch is additive: new ineligible arm + eligibilityWarnings.
// [VERIFY-3c-A] requiredTag is FREE-TEXT only; no FAA/currency/medical meaning.
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
// are operator line-ops figures, NOT airworthiness/maintenance records.
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
// NOT a regulatory determination.
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
// The public /book/[slug] PAGE render gate — agrees with the submit gate so the
// form is offered only when the org is active AND its booking module is on.
// Anti-enumeration: every not-available reason collapses to available:false.
export {
  resolveBookingPageAvailability,
  resolveBookingPageAvailabilityWithDb,
} from './booking/booking-page-availability.js';
export type { BookingPageAvailability } from './booking/booking-page-availability.js';

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

// ─── Slice B0 — Dispatch meter correction (append-only, migration 0018) ───────
// Effective meter: reads the CLOSED dispatch ticket's original meters + applies
//   the latest dispatch_ticket_correction (if any). READ-ONLY; the FROZEN
//   close path is untouched.
// Correction command: appends one row to dispatch_ticket_correction (INSERT-only).
//   Requires dispatch:create (same authority as closeDispatch). ONE audit row.
// [VERIFY-B0-COMP-1]: meter correction audit-chain (dual-signature) ruling.
// *WithDb forms are for test code only (inject a pglite client).

export {
  getEffectiveMeter,
} from './dispatch/effective-meter.js';
export type {
  GetEffectiveMeterResult,
  EffectiveMeterOk,
} from './dispatch/effective-meter.js';

export {
  correctDispatchMeter,
  correctDispatchMeterWithDb,
} from './dispatch/correct-dispatch-meter.js';
export type {
  CorrectDispatchMeterInput,
  CorrectDispatchMeterResult,
  DispatchCorrectionView,
} from './dispatch/correct-dispatch-meter.js';

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
// read in this path (mirrors resolveOrgBySlug); buildIcsForFeed does every reservation read inside
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
// base-airport coords, booking policies) and returns a
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

// ─── Slice CLUB-MODE — per-org module toggles + operating mode (0047) ─────────
// getOrgFeatures (app:access): the shell/nav/search/route read — which modules
//   exist for this org. setOrgFeatures (org:manage_settings): mode label +
//   partial per-module patch, optional preset application; ONE audit row.
// GRACEFUL ABSENCE: until migration 0047 is applied everything reads as
//   enabled (available:false) — byte-identical to the pre-0047 world.
// "HIDE, DON'T DESTROY": toggles gate nav/search/routes only; module data is
//   never deleted or mutated. NO money, NO FAA/regulatory meaning.
export { getOrgFeatures, getOrgFeaturesWithDb } from './org-features/get-org-features.js';
export type { OrgFeaturesView, GetOrgFeaturesResult } from './org-features/get-org-features.js';
export { setOrgFeatures, setOrgFeaturesWithDb } from './org-features/set-org-features.js';
export type { SetOrgFeaturesInput, SetOrgFeaturesResult } from './org-features/set-org-features.js';

// ─── Slice AVATARS — member profile photos (migration 0048) ───────────────────
// Optional small profile photo per account, stored inline as a size-capped
//   data-URI on app_user (no object-storage dependency). getMyAvatar
//   (app:access, own photo) / getMemberAvatars (people:access, bounded batch)
//   / setMyAvatar (app:access, self) / updateMemberAvatar (people:manage).
// GRACEFUL ABSENCE: until 0048 is applied, reads return null + available:false
//   (initials-only UI) and writes return not_available. STORED, NEVER
//   INTERPRETED — image bytes never enter logs or audit metadata.
export {
  getMyAvatar,
  getMyAvatarWithDb,
  getMemberAvatars,
  getMemberAvatarsWithDb,
  setMyAvatar,
  setMyAvatarWithDb,
  updateMemberAvatar,
  updateMemberAvatarWithDb,
  AVATAR_MAX_CHARS,
} from './people/avatar.js';
export type {
  MemberAvatarView,
  GetMyAvatarResult,
  GetMemberAvatarsResult,
  SetAvatarResult,
} from './people/avatar.js';

// ─── Slice SIGNUP — self-serve org creation (migration 0049) ──────────────────
// createOrgWithOwner: the ONLY self-serve tenant-minting path. Atomically
//   creates org + owner + membership(owner) + credential + terms/privacy
//   acceptance. Unauthenticated (signup); org_id is generated by the INSERT,
//   never from the caller. Clickwrap acceptance is required; recording it is
//   graceful-absent until 0049 is applied. Edge rate-limit + CAPTCHA are a
//   launch predecessor [VERIFY-SIGNUP-SEC-1]. NO money.
export { createOrgWithOwner, createOrgWithOwnerWithDb } from './auth/create-org.js';
export type { CreateOrgWithOwnerInput, CreateOrgWithOwnerResult } from './auth/create-org.js';
