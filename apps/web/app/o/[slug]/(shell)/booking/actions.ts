/**
 * booking/actions.ts — Server actions for the booking-request triage inbox
 * (Slice PB1.2 + PB2.2).
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
 *
 * COMPLIANCE [VERIFY-PB2-COMP-1]: convertBookingRequestAction parses ISO→Date at
 * the action boundary; serializes the returned reservation Dates→ISO back to the
 * client. No money/Stripe/price. Twilight disclaimer is verbatim (not §61.57).
 */
'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import {
  listBookingRequests,
  updateBookingRequestStatus,
  convertBookingRequest,
  ForbiddenError,
  UnauthenticatedError,
} from '@aeroops/api';
import type {
  BookingRequestRow,
  ListBookingRequestsOptions,
  ListBookingRequestsResult,
  UpdateBookingRequestStatusInput,
  UpdateBookingRequestStatusResult,
  ConvertBookingRequestResult,
  CreatedReservation,
  ConflictHit,
  PolicyViolationView,
  TwilightHit,
  AvailabilityHit,
} from '@aeroops/api';

// GroundingHit is not barrel-exported from @aeroops/api (it lives in
// scheduling/types.ts re-exported from @aeroops/core). Use the structural
// inline type matching the core shape for the action boundary.
type GroundingHit = { resourceId: string; reason: string | null };

// ─── Serialized types (Dates → string) ────────────────────────────────────────

/**
 * SerializedBookingRequestRow — BookingRequestRow with Dates as ISO strings.
 * Safe to pass from RSC actions to client components.
 *
 * PB2.2: `convertedReservationId` added (read-only additive; null for
 * non-converted rows). Drives the Converted-tab "View reservation" link.
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
  /** PB2.2: reservation id this request was converted into, or null. */
  convertedReservationId: string | null;
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
    convertedReservationId: r.convertedReservationId,
    createdAt: serializeDate(r.createdAt) ?? '',
  };
}

/**
 * Serialized CreatedReservation — Dates replaced with ISO strings for
 * client transfer. Only the fields the convert-dialog needs are included.
 */
export interface SerializedCreatedReservation {
  id: string;
  orgId: string;
  startAt: string;
  endAt: string;
  status: 'booked';
  notes: string | null;
  createdBy: string;
  resourceIds: string[];
}

function serializeCreatedReservation(r: CreatedReservation): SerializedCreatedReservation {
  return {
    id: r.id,
    orgId: r.orgId,
    startAt: r.startAt instanceof Date ? r.startAt.toISOString() : new Date(r.startAt as unknown as string).toISOString(),
    endAt: r.endAt instanceof Date ? r.endAt.toISOString() : new Date(r.endAt as unknown as string).toISOString(),
    status: r.status,
    notes: r.notes,
    createdBy: r.createdBy,
    resourceIds: r.resourceIds,
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

// ─── convertBookingRequestAction (PB2.2) ───────────────────────────────────────

/**
 * SerializedConvertResult — the serialized result of convertBookingRequestAction.
 * Dates are ISO strings; refusal payloads are passed through verbatim (ConflictHit
 * start/end are Dates on the wire from the API; they are kept as-is here since
 * they are read-only display values used only while the dialog is open).
 *
 * [VERIFY-PB2-COMP-1]: No money. Twilight disclaimer verbatim in the dialog.
 */
export type SerializedConvertResult =
  | {
      ok: true;
      id: string;
      status: 'converted';
      reservationId: string;
      reservation: SerializedCreatedReservation;
      groundingWarnings?: GroundingHit[];
      twilightWarnings?: TwilightHit[];
      availabilityWarnings?: AvailabilityHit[];
    }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_convertible' }
  | { ok: false; reason: 'conflict'; conflicts: ConflictHit[] }
  | { ok: false; reason: 'policy'; violations: PolicyViolationView[] }
  | { ok: false; reason: 'conflict_and_policy'; conflicts: ConflictHit[]; violations: PolicyViolationView[] }
  | { ok: false; reason: 'twilight'; twilight: TwilightHit[] }
  | { ok: false; reason: 'availability'; availability: AvailabilityHit[] }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

/**
 * ConvertBookingRequestActionInput — the raw form values from the client.
 * Dates come as ISO strings from `<input type="datetime-local">` or equivalent;
 * they are parsed to Date objects at the action boundary before calling the API.
 */
export interface ConvertBookingRequestActionInput {
  /** The booking_request id to convert. */
  id: string;
  /** The resource (aircraft) id to book. */
  resourceId: string;
  /** ISO string for the reservation start (e.g. "2026-06-25T10:00"). */
  startAt: string;
  /** ISO string for the reservation end (e.g. "2026-06-25T12:00"). */
  endAt: string;
}

/**
 * convertBookingRequestAction — atomically convert a booking_request into
 * a real reservation via the FROZEN gatedCreateOccurrence.
 *
 * Client sends ISO strings for startAt/endAt; this action parses them to
 * Date objects at the action boundary (spec: "parse ISO→Date at the action
 * clock boundary"). On success the reservation Dates are serialized back to
 * ISO strings for the client. On refusal the ok:false arms are returned
 * verbatim. Auth/validation errors are mapped to tagged error results.
 *
 * REQUIRES: booking:triage AND schedule:create_reservation (enforced inside
 * convertBookingRequest — the UI button is cosmetically gated on both caps).
 *
 * NO money. NO new endpoint — reuses listAircraft (fleet:access) for the picker.
 *
 * @param input  - { id, resourceId, startAt (ISO), endAt (ISO) }
 * @param slug   - Org slug for revalidatePath on success.
 * @returns SerializedConvertResult
 */
export async function convertBookingRequestAction(
  input: ConvertBookingRequestActionInput,
  slug: string,
): Promise<SerializedConvertResult> {
  const session = await auth();

  // Parse ISO strings → Date at the action boundary.
  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);

  // Validate the parsed dates before calling the API to give a clear error.
  if (isNaN(startAt.getTime())) {
    return { error: 'validation', message: 'Invalid start date/time.' };
  }
  if (isNaN(endAt.getTime())) {
    return { error: 'validation', message: 'Invalid end date/time.' };
  }

  try {
    const result: ConvertBookingRequestResult = await convertBookingRequest(session, {
      id: input.id,
      resourceId: input.resourceId,
      startAt,
      endAt,
    });

    if (!result.ok) {
      // Pass all ok:false arms through verbatim.
      return result;
    }

    // ok:true — revalidate and serialize Dates → ISO.
    revalidatePath(`/o/${slug}/booking`);
    return {
      ok: true,
      id: result.id,
      status: result.status,
      reservationId: result.reservationId,
      reservation: serializeCreatedReservation(result.reservation),
      ...(result.groundingWarnings ? { groundingWarnings: result.groundingWarnings } : {}),
      ...(result.twilightWarnings ? { twilightWarnings: result.twilightWarnings } : {}),
      ...(result.availabilityWarnings ? { availabilityWarnings: result.availabilityWarnings } : {}),
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}
