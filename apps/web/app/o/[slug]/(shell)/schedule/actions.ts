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
  BookingPolicyView,
  UpsertBookingPolicyResult,
  ClearBookingPolicyResult,
  BlackoutView,
  CreateBlackoutResult,
  DeleteBlackoutResult,
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
