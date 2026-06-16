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
} from './auth/index.js';

export type {
  AppSession,
  ResolvedOrg,
  VerifiedCredential,
  SessionOrgData,
} from './auth/index.js';

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
} from './dispatch/list-dispatch.js';
export type { GetDispatchForReservationInput } from './dispatch/list-dispatch.js';

// Dispatch result/IO types (consumed by apps/web board actions + UI).
export type {
  DispatchTicketView,
  OpenDispatchResult,
  CloseDispatchResult,
  VoidDispatchResult,
} from './dispatch/types.js';
