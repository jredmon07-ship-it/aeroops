/**
 * schedule/actions.ts — Server actions for the scheduling module.
 *
 * Each action:
 *   1. Calls auth() to obtain the session.
 *   2. Delegates to the @aeroops/api fn (which calls requireCapability internally).
 *   3. Maps ForbiddenError / UnauthenticatedError to { error: 'forbidden' | 'unauthenticated' }.
 *   4. Maps thrown ValidationError to { error: 'validation', message: string }.
 *   5. Passes through ok:false conflict results as-is (conflicts are returned values,
 *      not errors — ADR-0004).
 *
 * BOUNDARY: this file imports only from @aeroops/api — never @aeroops/db.
 * RLS + org_id scoping are enforced inside the API functions.
 */
'use server';

import { auth } from '@/auth';
import {
  listReservations,
  createReservation,
  cancelReservation,
  checkConflicts,
  listResources,
  createResource,
  deactivateResource,
  listOrgMembers,
  getBookingPolicy,
  upsertBookingPolicy,
  clearBookingPolicy,
  listBlackouts,
  createBlackout,
  deleteBlackout,
  createSeries,
  cancelSeries,
  listSeriesOccurrences,
  previewSeries,
  rescheduleReservation,
  openDispatch,
  closeDispatch,
  voidDispatch,
  getDispatchForReservation,
  listDispatchPilots,
  ForbiddenError,
  UnauthenticatedError,
} from '@aeroops/api';
import type {
  ReservationRow,
  CreateReservationResult,
  CancelResult,
  CheckConflictsResult,
  ResourceRow,
  OrgMemberRow,
  DispatchPilotRow,
  BookingPolicyView,
  UpsertBookingPolicyResult,
  ClearBookingPolicyResult,
  BlackoutView,
  CreateBlackoutResult,
  DeleteBlackoutResult,
  CreateSeriesResult,
  CancelSeriesResult,
  ListSeriesOccurrencesResponse,
  PreviewSeriesResult,
  RescheduleResult,
  OpenDispatchResult,
  CloseDispatchResult,
  VoidDispatchResult,
  DispatchTicketView,
} from '@aeroops/api';

// ─── Error shapes ─────────────────────────────────────────────────────────────

export type AuthErrorResult =
  | { error: 'forbidden' }
  | { error: 'unauthenticated' };

export type ValidationErrorResult = {
  error: 'validation';
  message: string;
};

export type ServerErrorResult = { error: 'server'; message?: string };

// Strip the "[scheduling]" / "[resource]" prefix from ValidationError messages.
function stripPrefix(msg: string): string {
  return msg.replace(/^\[[\w:]+\]\s*/, '');
}

function mapAuthError(err: unknown): AuthErrorResult | null {
  if (err instanceof ForbiddenError) return { error: 'forbidden' };
  if (err instanceof UnauthenticatedError) return { error: 'unauthenticated' };
  return null;
}

// ValidationError is not exported from @aeroops/api, so detect by .code property.
function isValidationError(err: unknown): err is { message: string; code: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'VALIDATION'
  );
}

// ─── listReservationsAction ───────────────────────────────────────────────────

export type ListReservationsActionResult =
  | { ok: true; reservations: ReservationRow[] }
  | AuthErrorResult
  | ServerErrorResult;

export async function listReservationsAction(input: {
  from: Date;
  to: Date;
  includeCancelled?: boolean;
}): Promise<ListReservationsActionResult> {
  const session = await auth();
  try {
    const reservations = await listReservations(session, input);
    return { ok: true, reservations };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── createReservationAction ──────────────────────────────────────────────────

export type CreateReservationActionResult =
  | CreateReservationResult
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function createReservationAction(input: {
  startAt: Date;
  endAt: Date;
  resourceIds: string[];
  notes?: string;
}): Promise<CreateReservationActionResult> {
  const session = await auth();
  try {
    return await createReservation(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── cancelReservationAction ──────────────────────────────────────────────────

export type CancelReservationActionResult =
  | CancelResult
  | AuthErrorResult
  | ServerErrorResult;

export async function cancelReservationAction(input: {
  reservationId: string;
}): Promise<CancelReservationActionResult> {
  const session = await auth();
  try {
    return await cancelReservation(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── checkConflictsAction ─────────────────────────────────────────────────────

export type CheckConflictsActionResult =
  | CheckConflictsResult
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function checkConflictsAction(input: {
  startAt: Date;
  endAt: Date;
  resourceIds: string[];
}): Promise<CheckConflictsActionResult> {
  const session = await auth();
  try {
    return await checkConflicts(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── listResourcesAction ──────────────────────────────────────────────────────

export type ListResourcesActionResult =
  | { ok: true; resources: ResourceRow[] }
  | AuthErrorResult
  | ServerErrorResult;

export async function listResourcesAction(opts?: {
  includeInactive?: boolean;
}): Promise<ListResourcesActionResult> {
  const session = await auth();
  try {
    const resources = await listResources(session, opts);
    return { ok: true, resources };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── createResourceAction ─────────────────────────────────────────────────────

export type CreateResourceActionResult =
  | { ok: true; resource: ResourceRow }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function createResourceAction(input: {
  kind: 'aircraft' | 'instructor';
  displayName: string;
  tailNumber?: string;
  instructorUserId?: string;
}): Promise<CreateResourceActionResult> {
  const session = await auth();
  try {
    const created = await createResource(session, input);
    return {
      ok: true,
      resource: {
        id: created.id,
        kind: created.kind,
        displayName: created.displayName,
        tailNumber: created.tailNumber,
        instructorUserId: created.instructorUserId,
        active: created.active,
      },
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── deactivateResourceAction ─────────────────────────────────────────────────

export type DeactivateResourceActionResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ServerErrorResult;

export async function deactivateResourceAction(input: {
  resourceId: string;
}): Promise<DeactivateResourceActionResult> {
  const session = await auth();
  try {
    return await deactivateResource(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── listOrgMembersAction ─────────────────────────────────────────────────────

export type ListOrgMembersActionResult =
  | { ok: true; members: OrgMemberRow[] }
  | AuthErrorResult
  | ServerErrorResult;

export async function listOrgMembersAction(opts?: {
  role?: Array<'owner' | 'manager' | 'dispatcher' | 'cfi' | 'mechanic' | 'renter' | 'student' | 'accountant'>;
}): Promise<ListOrgMembersActionResult> {
  const session = await auth();
  try {
    const members = await listOrgMembers(session, opts);
    return { ok: true, members };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── listDispatchPilotsAction ─────────────────────────────────────────────────
// Pilot picker for the dispatch check-out dialog, gated on dispatch:access so
// CFIs (who lack schedule:manage_resources) can populate it.

export type ListDispatchPilotsActionResult =
  | { ok: true; pilots: DispatchPilotRow[] }
  | AuthErrorResult
  | ServerErrorResult;

export async function listDispatchPilotsAction(): Promise<ListDispatchPilotsActionResult> {
  const session = await auth();
  try {
    const pilots = await listDispatchPilots(session);
    return { ok: true, pilots };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── getBookingPolicyAction ───────────────────────────────────────────────────

export type GetBookingPolicyActionResult =
  | { ok: true; policy: BookingPolicyView | null }
  | AuthErrorResult
  | ServerErrorResult;

export async function getBookingPolicyAction(input: {
  resourceId: string;
}): Promise<GetBookingPolicyActionResult> {
  const session = await auth();
  try {
    const policy = await getBookingPolicy(session, input);
    return { ok: true, policy };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── upsertBookingPolicyAction ────────────────────────────────────────────────

export type UpsertBookingPolicyActionResult =
  | UpsertBookingPolicyResult
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function upsertBookingPolicyAction(input: {
  resourceId: string;
  maxDurationMinutes?: number | null;
  maxAdvanceDays?: number | null;
  minAdvanceMinutes?: number | null;
}): Promise<UpsertBookingPolicyActionResult> {
  const session = await auth();
  try {
    return await upsertBookingPolicy(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── clearBookingPolicyAction ─────────────────────────────────────────────────

export type ClearBookingPolicyActionResult =
  | ClearBookingPolicyResult
  | AuthErrorResult
  | ServerErrorResult;

export async function clearBookingPolicyAction(input: {
  resourceId: string;
}): Promise<ClearBookingPolicyActionResult> {
  const session = await auth();
  try {
    return await clearBookingPolicy(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── listBlackoutsAction ──────────────────────────────────────────────────────

export type ListBlackoutsActionResult =
  | { ok: true; blackouts: BlackoutView[] }
  | AuthErrorResult
  | ServerErrorResult;

export async function listBlackoutsAction(input: {
  resourceId: string;
}): Promise<ListBlackoutsActionResult> {
  const session = await auth();
  try {
    const blackouts = await listBlackouts(session, input);
    return { ok: true, blackouts };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── createBlackoutAction ─────────────────────────────────────────────────────

export type CreateBlackoutActionResult =
  | CreateBlackoutResult
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function createBlackoutAction(input: {
  resourceId: string;
  startAt: Date;
  endAt: Date;
  reason?: string;
}): Promise<CreateBlackoutActionResult> {
  const session = await auth();
  try {
    return await createBlackout(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── deleteBlackoutAction ─────────────────────────────────────────────────────

export type DeleteBlackoutActionResult =
  | DeleteBlackoutResult
  | AuthErrorResult
  | ServerErrorResult;

export async function deleteBlackoutAction(input: {
  blackoutId: string;
}): Promise<DeleteBlackoutActionResult> {
  const session = await auth();
  try {
    return await deleteBlackout(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── createSeriesAction ───────────────────────────────────────────────────────

export type CreateSeriesActionResult =
  | CreateSeriesResult
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function createSeriesAction(
  input: unknown,
): Promise<CreateSeriesActionResult> {
  const session = await auth();
  try {
    return await createSeries(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── previewSeriesAction ──────────────────────────────────────────────────────

export type PreviewSeriesActionResult =
  | PreviewSeriesResult
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function previewSeriesAction(
  input: unknown,
): Promise<PreviewSeriesActionResult> {
  const session = await auth();
  try {
    return await previewSeries(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── cancelSeriesAction ───────────────────────────────────────────────────────

export type CancelSeriesActionResult =
  | CancelSeriesResult
  | AuthErrorResult
  | ServerErrorResult;

export async function cancelSeriesAction(input: {
  seriesId: string;
}): Promise<CancelSeriesActionResult> {
  const session = await auth();
  try {
    return await cancelSeries(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── listSeriesOccurrencesAction ──────────────────────────────────────────────

export type ListSeriesOccurrencesActionResult =
  | ListSeriesOccurrencesResponse
  | AuthErrorResult
  | ServerErrorResult;

export async function listSeriesOccurrencesAction(input: {
  seriesId: string;
}): Promise<ListSeriesOccurrencesActionResult> {
  const session = await auth();
  try {
    return await listSeriesOccurrences(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── openDispatchAction ───────────────────────────────────────────────────────

export type OpenDispatchActionResult =
  | OpenDispatchResult
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

/**
 * openDispatchAction — check out an aircraft (open a dispatch ticket).
 *
 * Maps:
 *   ForbiddenError       → { error: 'forbidden' }
 *   UnauthenticatedError → { error: 'unauthenticated' }
 *   ValidationError      → { error: 'validation', message } (prefix stripped)
 *   OpenDispatchResult   → passed through as-is (ok:true / ok:false arms)
 *
 * Capability gate enforced server-side by openDispatch (dispatch:create).
 * canDispatch on the client is UI hide/show only.
 */
export async function openDispatchAction(input: {
  reservationId: string;
  resourceId: string;
  pilotUserId: string;
  hobbsOut: number;
  tachOut: number;
  notes?: string;
}): Promise<OpenDispatchActionResult> {
  const session = await auth();
  try {
    return await openDispatch(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── closeDispatchAction ──────────────────────────────────────────────────────

export type CloseDispatchActionResult =
  | CloseDispatchResult
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

/**
 * closeDispatchAction — check in an aircraft (close a dispatch ticket).
 *
 * Maps:
 *   ForbiddenError        → { error: 'forbidden' }
 *   UnauthenticatedError  → { error: 'unauthenticated' }
 *   ValidationError       → { error: 'validation', message } (prefix stripped;
 *                           includes "Hobbs in must be >= Hobbs out" guard)
 *   CloseDispatchResult   → passed through as-is
 *
 * Capability gate enforced server-side by closeDispatch (dispatch:create).
 */
export async function closeDispatchAction(input: {
  ticketId: string;
  hobbsIn: number;
  tachIn: number;
}): Promise<CloseDispatchActionResult> {
  const session = await auth();
  try {
    return await closeDispatch(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── voidDispatchAction ───────────────────────────────────────────────────────

export type VoidDispatchActionResult =
  | VoidDispatchResult
  | AuthErrorResult
  | ServerErrorResult;

/**
 * voidDispatchAction — void a mistaken check-out (open → voided).
 *
 * Maps:
 *   ForbiddenError       → { error: 'forbidden' }
 *   UnauthenticatedError → { error: 'unauthenticated' }
 *   VoidDispatchResult   → passed through as-is
 *
 * Capability gate enforced server-side by voidDispatch (dispatch:create).
 * Requires an explicit confirm step in the UI (destructive action).
 */
export async function voidDispatchAction(input: {
  ticketId: string;
  reason: string;
}): Promise<VoidDispatchActionResult> {
  const session = await auth();
  try {
    return await voidDispatch(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── getDispatchForReservationAction ─────────────────────────────────────────

export type GetDispatchForReservationActionResult =
  | { ok: true; tickets: Array<[string, DispatchTicketView | null]> }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

/**
 * getDispatchForReservationAction — fetch the latest non-voided dispatch ticket
 * for each reservation on the board.
 *
 * Returns a serializable representation (array of [reservationId, ticket|null]
 * pairs) so the RSC page can pass it through as JSON to the client component.
 * The caller reconstructs a Map<string, DispatchTicketView|null> if needed.
 *
 * Maps:
 *   ForbiddenError       → { error: 'forbidden' }
 *   UnauthenticatedError → { error: 'unauthenticated' }
 *   ValidationError      → { error: 'validation', message }
 *
 * Capability gate enforced server-side by getDispatchForReservation
 * (dispatch:access — owner/manager/dispatcher/cfi).
 */
export async function getDispatchForReservationAction(input: {
  reservationIds: string[];
}): Promise<GetDispatchForReservationActionResult> {
  const session = await auth();
  try {
    const map = await getDispatchForReservation(session, input);
    return { ok: true, tickets: [...map.entries()] };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── rescheduleAction ─────────────────────────────────────────────────────────

export type RescheduleActionResult =
  | RescheduleResult
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

/**
 * rescheduleAction — move a reservation to a new window and/or resource set.
 *
 * Maps:
 *   ForbiddenError       → { error: 'forbidden' }
 *   UnauthenticatedError → { error: 'unauthenticated' }
 *   ValidationError      → { error: 'validation', message } (prefix stripped)
 *   RescheduleResult     → passed through as-is (including ok:false arms)
 *
 * The capability gate is enforced server-side by rescheduleReservation
 * (requireCapability('schedule:create_reservation')). The client's canDrag prop
 * is UI-only.
 */
export async function rescheduleAction(input: {
  reservationId: string;
  newStartAt: Date;
  newEndAt: Date;
  newResourceIds?: string[];
}): Promise<RescheduleActionResult> {
  const session = await auth();
  try {
    return await rescheduleReservation(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}
