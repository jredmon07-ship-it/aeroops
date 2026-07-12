/**
 * fleet/actions.ts — Server actions for the fleet module (Slice 5.3).
 *
 * Pattern mirrors maintenance/actions.ts:
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
 */
'use server';

import { serializeDate } from '@/lib/serialize-date';

import { auth } from '@/auth';
import { revalidatePath } from 'next/cache';
import {
  listAircraft,
  listAircraftPage,
  getAircraftDetail,
  updateAircraft,
  listLocations,
  createLocation,
  updateLocation,
} from '@aeroops/api';
import type {
  AircraftListRow,
  AircraftCursor,
  AircraftDetail,
  UpdateAircraftInput,
  CreateLocationInput,
  UpdateLocationInput,
  LocationOption,
  WorkOrderView,
} from '@aeroops/api';

// ─── Serialized types (Dates → string) ───────────────────────────────────────

/**
 * Serialized SquawkView — Dates replaced with ISO strings for client transfer.
 */
export interface SerializedSquawkView {
  id: string;
  resourceId: string;
  dispatchTicketId: string | null;
  title: string;
  description: string | null;
  severity: string;
  status: string;
  reportedBy: string;
  reportedAt: string;
  resolutionNotes: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
}

/**
 * Serialized DispatchTicketView — Dates replaced with ISO strings.
 */
export interface SerializedDispatchTicketView {
  id: string;
  reservationId: string;
  resourceId: string;
  pilotUserId: string;
  status: string;
  hobbsOut: number;
  tachOut: number;
  hobbsIn: number | null;
  tachIn: number | null;
  flightTimeHours: number | null;
  notes: string | null;
  openedBy: string;
  openedAt: string;
  closedBy: string | null;
  closedAt: string | null;
}

/**
 * Serialized GroundingStatusView — Dates replaced with ISO strings.
 */
export interface SerializedGroundingStatusView {
  grounded: boolean;
  reason: string | null;
  since: string | null;
  groundedBy: string | null;
  eventId: string | null;
}

/**
 * Serialized UpcomingReservationRow — Dates replaced with ISO strings.
 */
export interface SerializedUpcomingReservationRow {
  id: string;
  startAt: string;
  endAt: string;
  seriesId: string | null;
}

/**
 * Serialized WorkOrderView — Dates replaced with ISO strings.
 * Used in fleet/[id] open work orders card (Slice M1.3 [VERIFY-M1-E]).
 */
export interface SerializedWorkOrderView {
  id: string;
  orgId: string;
  resourceId: string;
  squawkId: string | null;
  title: string;
  description: string | null;
  status: 'open' | 'in_progress' | 'completed' | 'cancelled';
  workPerformed: string | null;
  openedBy: string;
  openedAt: string;
  signedOffBy: string | null;
  signedOffAt: string | null;
  signOffNotes: string | null;
  cancelledReason: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Serialized AircraftDetail — all Dates replaced with ISO strings.
 */
export interface SerializedAircraftDetail {
  id: string;
  tailNumber: string;
  displayName: string;
  make: string | null;
  model: string | null;
  year: number | null;
  serialNumber: string | null;
  /** FREE TEXT operator-entered category (e.g. 'Airplane') — not a certification determination. */
  category: string | null;
  /** FREE TEXT operator-entered class (e.g. 'ASEL') — not a certification determination. */
  aircraftClass: string | null;
  active: boolean;
  hasHobbs: boolean;
  hasTach: boolean;
  homeBase: { id: string; name: string; icao: string | null } | null;
  grounding: SerializedGroundingStatusView;
  openSquawkCount: number;
  recentSquawks: SerializedSquawkView[];
  recentDispatch: SerializedDispatchTicketView[];
  currentHobbs: number | null;
  currentTach: number | null;
  currentMetersAsOf: string | null;
  upcomingReservations: SerializedUpcomingReservationRow[];
  /** Open work orders (status in open/in_progress, ≤10, newest-first) [VERIFY-M1-E]. */
  openWorkOrders: SerializedWorkOrderView[];
  openWorkOrderCount: number;
}

// ─── Error shapes ─────────────────────────────────────────────────────────────

import { mapAuthError, isValidationError } from '@/lib/action-errors-result';
import type { AuthErrorResult, ValidationErrorResult, ServerErrorResult } from '@/lib/action-errors-result';

export type { AuthErrorResult, ValidationErrorResult, ServerErrorResult };

// ─── Date serialization helpers ───────────────────────────────────────────────
function serializeAircraftDetail(detail: AircraftDetail): SerializedAircraftDetail {
  return {
    id: detail.id,
    tailNumber: detail.tailNumber,
    displayName: detail.displayName,
    make: detail.make,
    model: detail.model,
    year: detail.year,
    serialNumber: detail.serialNumber,
    category: detail.category,
    aircraftClass: detail.aircraftClass,
    active: detail.active,
    hasHobbs: detail.hasHobbs,
    hasTach: detail.hasTach,
    homeBase: detail.homeBase ?? null,
    grounding: {
      grounded: detail.grounding.grounded,
      reason: detail.grounding.reason,
      since: serializeDate(detail.grounding.since),
      groundedBy: detail.grounding.groundedBy,
      eventId: detail.grounding.eventId,
    },
    openSquawkCount: detail.openSquawkCount,
    recentSquawks: detail.recentSquawks.map((s) => ({
      id: s.id,
      resourceId: s.resourceId,
      dispatchTicketId: s.dispatchTicketId,
      title: s.title,
      description: s.description,
      severity: s.severity,
      status: s.status,
      reportedBy: s.reportedBy,
      reportedAt: serializeDate(s.reportedAt) ?? '',
      resolutionNotes: s.resolutionNotes,
      resolvedBy: s.resolvedBy,
      resolvedAt: serializeDate(s.resolvedAt),
    })),
    recentDispatch: detail.recentDispatch.map((t) => ({
      id: t.id,
      reservationId: t.reservationId,
      resourceId: t.resourceId,
      pilotUserId: t.pilotUserId,
      status: t.status,
      hobbsOut: t.hobbsOut,
      tachOut: t.tachOut,
      hobbsIn: t.hobbsIn,
      tachIn: t.tachIn,
      flightTimeHours: t.flightTimeHours,
      notes: t.notes,
      openedBy: t.openedBy,
      openedAt: serializeDate(t.openedAt) ?? '',
      closedBy: t.closedBy,
      closedAt: serializeDate(t.closedAt),
    })),
    currentHobbs: detail.currentHobbs,
    currentTach: detail.currentTach,
    currentMetersAsOf: serializeDate(detail.currentMetersAsOf),
    upcomingReservations: detail.upcomingReservations.map((r) => ({
      id: r.id,
      startAt: serializeDate(r.startAt) ?? '',
      endAt: serializeDate(r.endAt) ?? '',
      seriesId: r.seriesId,
    })),
    // Slice M1.3 [VERIFY-M1-E]: open work orders surface on fleet detail.
    openWorkOrders: (detail.openWorkOrders ?? []).map((wo: WorkOrderView) => ({
      id: wo.id,
      orgId: wo.orgId,
      resourceId: wo.resourceId,
      squawkId: wo.squawkId,
      title: wo.title,
      description: wo.description,
      status: wo.status,
      workPerformed: wo.workPerformed,
      openedBy: wo.openedBy,
      openedAt: serializeDate(wo.openedAt) ?? '',
      signedOffBy: wo.signedOffBy,
      signedOffAt: serializeDate(wo.signedOffAt),
      signOffNotes: wo.signOffNotes,
      cancelledReason: wo.cancelledReason,
      cancelledAt: serializeDate(wo.cancelledAt),
      createdAt: serializeDate(wo.createdAt) ?? '',
      updatedAt: serializeDate(wo.updatedAt) ?? '',
    })),
    openWorkOrderCount: detail.openWorkOrderCount ?? 0,
  };
}

// ─── listAircraftAction ───────────────────────────────────────────────────────

export type ListAircraftActionResult =
  | { ok: true; aircraft: AircraftListRow[] }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function listAircraftAction(input?: {
  includeInactive?: boolean;
}): Promise<ListAircraftActionResult> {
  const session = await auth();
  try {
    const aircraft = await listAircraft(session, input ?? {});
    return { ok: true, aircraft };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: err.message };
    }
    return { error: 'server' };
  }
}

// ─── listAircraftPageAction (keyset pagination) ───────────────────────────────
// AircraftCursor is JSON-safe (two strings) — no date serialization needed.

export type ListAircraftPageActionResult =
  | { ok: true; aircraft: AircraftListRow[]; nextCursor: AircraftCursor | null }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function listAircraftPageAction(input?: {
  includeInactive?: boolean;
  limit?: number;
  cursor?: AircraftCursor;
}): Promise<ListAircraftPageActionResult> {
  const session = await auth();
  try {
    const page = await listAircraftPage(session, input ?? {});
    return { ok: true, aircraft: page.rows, nextCursor: page.nextCursor ?? null };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: err.message };
    }
    return { error: 'server' };
  }
}

// ─── getAircraftDetailAction ──────────────────────────────────────────────────

export type GetAircraftDetailActionResult =
  | { ok: true; aircraft: SerializedAircraftDetail }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getAircraftDetailAction(input: {
  resourceId: string;
}): Promise<GetAircraftDetailActionResult> {
  const session = await auth();
  try {
    const result = await getAircraftDetail(session, input);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, aircraft: serializeAircraftDetail(result.aircraft) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: err.message };
    }
    return { error: 'server' };
  }
}

// ─── updateAircraftAction ─────────────────────────────────────────────────────

export type UpdateAircraftActionResult =
  | { ok: true; aircraft: SerializedAircraftDetail }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'invalid_home_base' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function updateAircraftAction(
  input: UpdateAircraftInput,
): Promise<UpdateAircraftActionResult> {
  const session = await auth();
  try {
    const result = await updateAircraft(session, input);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, aircraft: serializeAircraftDetail(result.aircraft) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: err.message };
    }
    return { error: 'server' };
  }
}

// ─── listLocationsAction ──────────────────────────────────────────────────────

export type ListLocationsActionResult =
  | { ok: true; locations: LocationOption[] }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function listLocationsAction(): Promise<ListLocationsActionResult> {
  const session = await auth();
  try {
    const locations = await listLocations(session);
    return { ok: true, locations };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: err.message };
    }
    return { error: 'server' };
  }
}

// ─── createLocationAction ─────────────────────────────────────────────────────
// authz fleet:manage (enforced inside @aeroops/api). LocationOption is JSON-safe
// (all primitives) so no date serialization is needed.

export type CreateLocationActionResult =
  | { ok: true; location: LocationOption }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function createLocationAction(
  input: CreateLocationInput,
  slug: string,
): Promise<CreateLocationActionResult> {
  const session = await auth();
  try {
    const result = await createLocation(session, input);
    revalidatePath(`/o/${slug}/fleet/locations`);
    return { ok: true, location: result.location };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: err.message };
    }
    return { error: 'server' };
  }
}

// ─── updateLocationAction ─────────────────────────────────────────────────────

export type UpdateLocationActionResult =
  | { ok: true; location: LocationOption }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function updateLocationAction(
  input: UpdateLocationInput,
  slug: string,
): Promise<UpdateLocationActionResult> {
  const session = await auth();
  try {
    const result = await updateLocation(session, input);
    if (!result.ok) return { ok: false, reason: result.reason };
    revalidatePath(`/o/${slug}/fleet/locations`);
    return { ok: true, location: result.location };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: err.message };
    }
    return { error: 'server' };
  }
}
