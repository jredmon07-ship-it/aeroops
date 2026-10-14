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

import { actionAuth as auth } from '@/lib/action-auth';
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
  previewTwilight,
  rescheduleReservation,
  openDispatch,
  closeDispatch,
  recordDispatchService,
  voidDispatch,
  getDispatchForReservation,
  listDispatchPilots,
  getGroundingStatus,
  getOpenSquawkCounts,
  listMemberExpirations,
  previewAvailability,
  sendNotification,
  getMetarForAircraft,
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
  PreviewTwilightResult,
  PreviewAvailabilityResult,
  RescheduleResult,
  OpenDispatchResult,
  CloseDispatchResult,
  RecordDispatchServiceResult,
  VoidDispatchResult,
  DispatchTicketView,
  MemberExpirationStatus,
  ParsedMetar,
} from '@aeroops/api';

// ─── Error shapes ─────────────────────────────────────────────────────────────

import { mapAuthError, isValidationError } from '@/lib/action-errors-result';
import type { AuthErrorResult, ValidationErrorResult, ServerErrorResult } from '@/lib/action-errors-result';

export type { AuthErrorResult, ValidationErrorResult, ServerErrorResult };

// Strip the "[scheduling]" / "[resource]" prefix from ValidationError messages.
function stripPrefix(msg: string): string {
  return msg.replace(/^\[[\w:]+\]\s*/, '');
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
    const result = await createReservation(session, input);
    // Best-effort notification (Slice P1.3) — fires AFTER the reservation is
    // already committed. sendNotification never throws; the .catch here is
    // defense-in-depth so a notification hiccup can never surface as a
    // create-reservation failure.
    if (result.ok && session) {
      await sendNotification(session, {
        toUserId: session.userId,
        eventType: 'reservation.created',
        templateData: {
          startAt: result.reservation.startAt,
          endAt: result.reservation.endAt,
          resourceIds: result.reservation.resourceIds,
        },
      }).catch(() => {});
    }
    return result;
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
  | ValidationErrorResult
  | ServerErrorResult;

export async function cancelReservationAction(input: {
  reservationId: string;
  /** Optional free-text cancellation reason (migration 0042). */
  reason?: string;
}): Promise<CancelReservationActionResult> {
  const session = await auth();
  try {
    return await cancelReservation(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
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
  | ValidationErrorResult
  | ServerErrorResult;

export async function cancelSeriesAction(input: {
  seriesId: string;
  /** Optional free-text cancellation reason (migration 0042). */
  reason?: string;
}): Promise<CancelSeriesActionResult> {
  const session = await auth();
  try {
    return await cancelSeries(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
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

// ─── getDispatchPreflightAction ───────────────────────────────────────────────

/**
 * DispatchPreflightExpirationRow — one operator-entered expiration reminder
 * for the selected pilot, with its display status. [VERIFY-FC-P2-A]: status
 * is date arithmetic on an operator-entered reminder — NOT a medical/
 * currency/legal validity determination.
 */
export interface DispatchPreflightExpirationRow {
  id: string;
  label: string;
  /** Calendar date 'YYYY-MM-DD'. */
  expiresOn: string;
  status: MemberExpirationStatus;
}

/**
 * DispatchPreflight — read-only status snapshot rendered as a checklist in
 * the check-out ("Confirm dispatch") dialog BEFORE the user hits Dispatch.
 *
 * Every facet is null when its read was unavailable (missing capability or a
 * transient failure) — the dialog hides that row gracefully. WARN-ONLY:
 * nothing here blocks the dispatch; the FROZEN openDispatch gate (grounded →
 * ineligible) still runs unchanged when the user submits.
 */
export interface DispatchPreflight {
  /** Aircraft grounding status (operator-set grounding record). */
  grounding: { grounded: boolean; reason: string | null } | null;
  /**
   * Pilot expiration reminders. [VERIFY-FC-P2-A]: operator-entered reminder
   * dates only — not a medical/currency/legal determination.
   */
  expirations: {
    items: DispatchPreflightExpirationRow[];
    expiredCount: number;
    dueSoonCount: number;
  } | null;
  /** Open squawk count on the aircraft. */
  openSquawkCount: number | null;
}

export type GetDispatchPreflightActionResult =
  | { ok: true; preflight: DispatchPreflight }
  | AuthErrorResult
  | ServerErrorResult;

/**
 * getDispatchPreflightAction — assemble the pre-flight checklist for the
 * check-out dialog in ONE round trip. READ-ONLY composition of EXISTING
 * scoped reads (grounding, squawk counts, member expirations) —
 * no new query surface, no writes, no gate changes.
 *
 * Facet-level failures (e.g. a role without maintenance:access hitting
 * getGroundingStatus's Forbidden) degrade that facet to null instead of
 * failing the whole action — the dialog hides the row.
 */
export async function getDispatchPreflightAction(input: {
  resourceId: string;
  pilotUserId: string;
}): Promise<GetDispatchPreflightActionResult> {
  const session = await auth();
  if (!session) return { error: 'unauthenticated' };

  const preflight: DispatchPreflight = {
    grounding: null,
    expirations: null,
    openSquawkCount: null,
  };

  // Grounding (maintenance:access) — reuses the existing grounding read.
  try {
    const statusMap = await getGroundingStatus(session, { resourceIds: [input.resourceId] });
    const s = statusMap.get(input.resourceId);
    if (s) preflight.grounding = { grounded: s.grounded, reason: s.reason };
  } catch {
    // Missing cap / transient failure → row hidden.
  }

  // Open squawk count (maintenance:access).
  try {
    const counts = await getOpenSquawkCounts(session, { resourceIds: [input.resourceId] });
    preflight.openSquawkCount = counts.get(input.resourceId) ?? 0;
  } catch {
    // Row hidden.
  }

  // Pilot expirations (people:access). [VERIFY-FC-P2-A]: warn-only reminders.
  try {
    const r = await listMemberExpirations(session, { memberUserId: input.pilotUserId });
    if (r.ok) {
      const items = r.expirations.map((e) => ({
        id: e.id,
        label: e.label,
        expiresOn: e.expiresOn,
        status: e.status,
      }));
      preflight.expirations = {
        items,
        expiredCount: items.filter((e) => e.status === 'expired').length,
        dueSoonCount: items.filter((e) => e.status === 'due_soon').length,
      };
    }
  } catch {
    // Row hidden.
  }

  return { ok: true, preflight };
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

// ─── recordDispatchServiceAction ──────────────────────────────────────────────

export type RecordDispatchServiceActionResult =
  | RecordDispatchServiceResult
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

/**
 * recordDispatchServiceAction — append an OPTIONAL line-ops service event
 * (oil/fuel uplift + note) to a CLOSED dispatch ticket.
 *
 * This is a SEPARATE best-effort follow-up to check-in — the FROZEN closeDispatch
 * call is unchanged; the check-in dialog calls this after close succeeds and
 * surfaces its own toast. A failure here NEVER un-closes the ticket.
 *
 * Capability gate enforced server-side by recordDispatchService (dispatch:create).
 */
export async function recordDispatchServiceAction(input: {
  dispatchTicketId: string;
  oilAddedQuarts?: number;
  fuelAddedGallons?: number;
  note?: string;
}): Promise<RecordDispatchServiceActionResult> {
  const session = await auth();
  try {
    return await recordDispatchService(session, input);
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

// ─── previewTwilightAction ────────────────────────────────────────────────────
// Advisory civil-twilight preview (Slice 4a). Writes nothing; no audit row.
// Authz: schedule:create_reservation (same gate as the create it previews).
// Returns serializable data: boundaryUtcMs is already a number (no Date objects).

export type PreviewTwilightActionResult =
  | PreviewTwilightResult
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

/**
 * previewTwilightAction — read-only civil-twilight advisory preview.
 *
 * Maps:
 *   ForbiddenError       → { error: 'forbidden' }
 *   UnauthenticatedError → { error: 'unauthenticated' }
 *   ValidationError      → { error: 'validation', message }
 *   PreviewTwilightResult → passed through as-is (perResource array).
 *     SolarEvents times (sunriseUtcMs etc.) are numbers — already serializable.
 *
 * Capability gate enforced server-side by previewTwilight.
 */
export async function previewTwilightAction(input: {
  startAt: Date;
  endAt: Date;
  resourceIds: string[];
}): Promise<PreviewTwilightActionResult> {
  const session = await auth();
  try {
    return await previewTwilight(session, input);
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── previewAvailabilityAction ────────────────────────────────────────────────
// Advisory operating-hours preview (Slice AV1.3). Writes nothing; no audit row.
// Authz: schedule:create_reservation (same gate as the create it previews).
// Returns serializable data: AvailabilityHit.startUtcMs/endUtcMs are numbers.
// Independent of the availabilityConstraintEnabled flag (always shows when windows set).

export type PreviewAvailabilityActionResult =
  | PreviewAvailabilityResult
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

/**
 * previewAvailabilityAction — read-only operating-hours advisory preview.
 *
 * Maps:
 *   ForbiddenError           -> { error: 'forbidden' }
 *   UnauthenticatedError     -> { error: 'unauthenticated' }
 *   ValidationError          -> { error: 'validation', message }
 *   PreviewAvailabilityResult -> passed through as-is (perResource array).
 *     AvailabilityHit fields are numbers -- already serializable.
 *
 * [VERIFY-AV1-A]: operator operating-hours rule, NOT an FAA duty-time
 * or Part-117/135/121 determination. Capability gate enforced server-side.
 */
export async function previewAvailabilityAction(input: {
  startAt: Date;
  endAt: Date;
  resourceIds: string[];
}): Promise<PreviewAvailabilityActionResult> {
  const session = await auth();
  try {
    return await previewAvailability(session, input);
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

// ─── getMetarForAircraftAction ────────────────────────────────────────────────
// Slice W1 — METAR weather (display-only, informational). Read-only; writes
// nothing, no audit row. Authz: schedule:access (enforced server-side by
// getMetarForAircraft — same base viewing capability as the board / this
// form). NEVER a go/no-go, airworthiness, or dispatch determination — the
// pilot in command decides. See docs/specs/slice-weather-metar.md.
//
// Result is `ParsedMetar | null` — null covers EVERY graceful-empty case
// uniformly (no ICAO configured, non-aircraft resource, cross-org id, or a
// weather-provider outage) so the chip's empty state is a single code path.

export type GetMetarForAircraftActionResult =
  | { ok: true; weather: ParsedMetar | null }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

/**
 * getMetarForAircraftAction — read-only current METAR for an aircraft's
 * home-base airport.
 *
 * Maps:
 *   ForbiddenError       → { error: 'forbidden' }
 *   UnauthenticatedError → { error: 'unauthenticated' }
 *   ValidationError      → { error: 'validation', message }
 *   otherwise            → { ok: true, weather } (weather may be null)
 */
export async function getMetarForAircraftAction(input: {
  resourceId: string;
}): Promise<GetMetarForAircraftActionResult> {
  const session = await auth();
  try {
    const weather = await getMetarForAircraft(session, input);
    return { ok: true, weather };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}
