/**
 * booking/actions.ts — Server actions for the booking-request triage inbox
 * (Slice PB1.2).
 *
 * Pattern mirrors people/actions.ts and maintenance/work-orders/actions.ts:
 *   1. await auth() → session.
 *   2. Call @aeroops/api fn (requireCapability inside the fn).
 *   3. Map ForbiddenError / UnauthenticatedError → { error: 'forbidden'|'unauthenticated' }.
 *   4. Map ValidationError (code === 'VALIDATION') → { error: 'validation', message }.
 *   5. Pass through ok:false arms as-is (operational refusals are values, not errors).
 *
 * Dates are serialized to ISO strings at the action boundary so RSC → client
 * components receive plain JSON (Dates are NOT JSON-serializable).
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 * RLS + org_id scoping are enforced inside the API functions.
 *
 * COMPLIANCE [VERIFY-PB1-COMP-1]: booking requests hold minimum lead data
 * (name/email/phone/dates) volunteered by the requester. Retention/purge
 * posture is a launch predecessor per ADR-0013.
 */
'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import {
  listBookingRequests,
  updateBookingRequestStatus,
  ForbiddenError,
  UnauthenticatedError,
} from '@aeroops/api';
import type {
  BookingRequestRow,
  ListBookingRequestsOptions,
  ListBookingRequestsResult,
  UpdateBookingRequestStatusInput,
  UpdateBookingRequestStatusResult,
} from '@aeroops/api';

// ─── Serialized types (Dates → string) ────────────────────────────────────────

/**
 * SerializedBookingRequestRow — BookingRequestRow with Dates as ISO strings.
 * Safe to pass from RSC actions to client components.
 */
export interface SerializedBookingRequestRow {
  id: string;
  status: 'new' | 'contacted' | 'converted' | 'declined';
  requesterName: string;
  requesterEmail: string;
  requesterPhone: string | null;
  requestedStart: string;
  requestedEnd: string | null;
  aircraftTypePref: string | null;
  message: string | null;
  handledBy: string | null;
  handledAt: string | null;
  triageNotes: string | null;
  createdAt: string;
}

export interface SerializedListBookingRequestsResult {
  rows: SerializedBookingRequestRow[];
  counts: {
    new: number;
    contacted: number;
    converted: number;
    declined: number;
  };
}

// ─── Error shapes ──────────────────────────────────────────────────────────────

export type AuthErrorResult =
  | { error: 'forbidden' }
  | { error: 'unauthenticated' };

export type ValidationErrorResult = {
  error: 'validation';
  message: string;
};

export type ServerErrorResult = { error: 'server'; message?: string };

function mapAuthError(err: unknown): AuthErrorResult | null {
  if (err instanceof ForbiddenError) return { error: 'forbidden' };
  if (err instanceof UnauthenticatedError) return { error: 'unauthenticated' };
  return null;
}

function isValidationError(err: unknown): err is { message: string; code: string } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'VALIDATION'
  );
}

// ─── Date serialization helpers ────────────────────────────────────────────────

function serializeDate(d: Date | null | undefined): string | null {
  if (!d) return null;
  try {
    return d instanceof Date ? d.toISOString() : new Date(d as unknown as string).toISOString();
  } catch {
    return null;
  }
}

function serializeRow(r: BookingRequestRow): SerializedBookingRequestRow {
  return {
    id: r.id,
    status: r.status,
    requesterName: r.requesterName,
    requesterEmail: r.requesterEmail,
    requesterPhone: r.requesterPhone,
    requestedStart: serializeDate(r.requestedStart) ?? '',
    requestedEnd: serializeDate(r.requestedEnd),
    aircraftTypePref: r.aircraftTypePref,
    message: r.message,
    handledBy: r.handledBy,
    handledAt: serializeDate(r.handledAt),
    triageNotes: r.triageNotes,
    createdAt: serializeDate(r.createdAt) ?? '',
  };
}

// ─── listBookingRequestsAction ─────────────────────────────────────────────────

export type ListBookingRequestsActionResult =
  | ({ ok: true } & SerializedListBookingRequestsResult)
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function listBookingRequestsAction(
  opts?: ListBookingRequestsOptions,
): Promise<ListBookingRequestsActionResult> {
  const session = await auth();
  try {
    const result: ListBookingRequestsResult = await listBookingRequests(session, opts);
    return {
      ok: true,
      rows: result.rows.map(serializeRow),
      counts: result.counts,
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── updateBookingRequestStatusAction ─────────────────────────────────────────

export type UpdateBookingRequestStatusActionResult =
  | { ok: true; id: string; status: string }
  | { ok: false; reason: 'not_found' | 'invalid_transition' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function updateBookingRequestStatusAction(
  input: UpdateBookingRequestStatusInput,
  slug: string,
): Promise<UpdateBookingRequestStatusActionResult> {
  const session = await auth();
  try {
    const result: UpdateBookingRequestStatusResult = await updateBookingRequestStatus(
      session,
      input,
    );
    if (!result.ok) return { ok: false, reason: result.reason };
    // Revalidate the booking inbox so the list refreshes after a status change.
    revalidatePath(`/o/${slug}/booking`);
    return { ok: true, id: result.id, status: result.status };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}
