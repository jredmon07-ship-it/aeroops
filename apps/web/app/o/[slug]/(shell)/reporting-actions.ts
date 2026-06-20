/**
 * reporting-actions.ts — Server actions for the Slice-7 reporting / ops dashboard.
 *
 * Pattern mirrors fleet/actions.ts and maintenance/actions.ts:
 *   1. await auth() → session.
 *   2. Call @aeroops/api fn (requireCapability inside the fn).
 *   3. Map ForbiddenError / UnauthenticatedError → { error: 'forbidden'|'unauthenticated' }.
 *   4. Map ValidationError (code === 'VALIDATION') → { error: 'validation', message }.
 *
 * Dates are serialized to ISO strings at the action boundary so RSC → client
 * components receive plain JSON (Dates are NOT JSON-serializable).
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 * RLS + org_id scoping are enforced inside the API functions.
 */
'use server';

import { auth } from '@/auth';
import {
  getOrgDashboardMetrics,
  getAircraftUtilization,
  listReservations,
  listAircraft,
  listSquawks,
  ForbiddenError,
  UnauthenticatedError,
} from '@aeroops/api';
import type {
  OrgDashboardMetrics,
  AircraftUtilizationRow,
  ReservationRow,
  AircraftListRow,
  SquawkView,
} from '@aeroops/api';

// ─── Error shapes (same pattern as fleet/actions.ts) ─────────────────────────

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

// ─── Serialized types (Dates → ISO strings) ───────────────────────────────────

/** OrgDashboardMetrics with Date objects replaced by ISO strings. */
export interface SerializedOrgDashboardMetrics {
  range: { key: string; from: string; to: string };
  totalFlights: number;
  totalFlightHours: number;
  reservationsInRange: number;
  openSquawkCount: number;
  groundedAircraftCount: number;
  activeAircraftCount: number;
  activeMemberCount: number;
  /** Point-in-time: work_order rows with status IN ('open','in_progress'). */
  openWorkOrderCount: number;
  /** Point-in-time: enrollment rows with status='active'. */
  activeEnrollmentCount: number;
}

function serializeMetrics(m: OrgDashboardMetrics): SerializedOrgDashboardMetrics {
  return {
    range: {
      key: m.range.key,
      from: m.range.from instanceof Date ? m.range.from.toISOString() : String(m.range.from),
      to: m.range.to instanceof Date ? m.range.to.toISOString() : String(m.range.to),
    },
    totalFlights: m.totalFlights,
    totalFlightHours: m.totalFlightHours,
    reservationsInRange: m.reservationsInRange,
    openSquawkCount: m.openSquawkCount,
    groundedAircraftCount: m.groundedAircraftCount,
    activeAircraftCount: m.activeAircraftCount,
    activeMemberCount: m.activeMemberCount,
    openWorkOrderCount: m.openWorkOrderCount,
    activeEnrollmentCount: m.activeEnrollmentCount,
  };
}

/** Minimal serialized reservation for the "today's flights" at-a-glance. */
export interface SerializedReservationRow {
  id: string;
  startAt: string;
  endAt: string;
  status: string;
  notes: string | null;
  createdBy: string;
  resourceIds: string[];
  seriesId: string | null;
}

function serializeReservation(r: ReservationRow): SerializedReservationRow {
  return {
    id: r.id,
    startAt: r.startAt instanceof Date ? r.startAt.toISOString() : String(r.startAt),
    endAt: r.endAt instanceof Date ? r.endAt.toISOString() : String(r.endAt),
    status: r.status,
    notes: r.notes,
    createdBy: r.createdBy,
    resourceIds: r.resourceIds,
    seriesId: r.seriesId,
  };
}

/** Minimal serialized squawk for the open-squawks at-a-glance. */
export interface SerializedSquawkView {
  id: string;
  resourceId: string;
  title: string;
  severity: string;
  status: string;
  reportedAt: string;
}

function serializeSquawk(s: SquawkView): SerializedSquawkView {
  return {
    id: s.id,
    resourceId: s.resourceId,
    title: s.title,
    severity: s.severity,
    status: s.status,
    reportedAt: s.reportedAt instanceof Date ? s.reportedAt.toISOString() : String(s.reportedAt),
  };
}

// ─── getDashboardMetricsAction ────────────────────────────────────────────────

export type GetDashboardMetricsActionResult =
  | { ok: true; metrics: SerializedOrgDashboardMetrics }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getDashboardMetricsAction(input?: {
  range?: string;
}): Promise<GetDashboardMetricsActionResult> {
  const session = await auth();
  try {
    const metrics = await getOrgDashboardMetrics(session, { range: input?.range ?? '30d' });
    return { ok: true, metrics: serializeMetrics(metrics) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: err.message };
    }
    return { error: 'server' };
  }
}

// ─── getAircraftUtilizationAction ─────────────────────────────────────────────

export type GetAircraftUtilizationActionResult =
  | { ok: true; rows: AircraftUtilizationRow[] }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getAircraftUtilizationAction(input?: {
  range?: string;
}): Promise<GetAircraftUtilizationActionResult> {
  const session = await auth();
  try {
    const rows = await getAircraftUtilization(session, { range: input?.range ?? '30d' });
    return { ok: true, rows };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: err.message };
    }
    return { error: 'server' };
  }
}

// ─── getTodaysFlightsAction ───────────────────────────────────────────────────

export type GetTodaysFlightsActionResult =
  | { ok: true; reservations: SerializedReservationRow[]; tzNote: string }
  | AuthErrorResult
  | ServerErrorResult;

export async function getTodaysFlightsAction(): Promise<GetTodaysFlightsActionResult> {
  const session = await auth();
  // [VERIFY-7-TZ]: UTC-day fallback with label. Rolling metrics are tz-neutral.
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  try {
    const reservations = await listReservations(session, { from: todayStart, to: todayEnd });
    return {
      ok: true,
      reservations: reservations.map(serializeReservation),
      tzNote: 'UTC',
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── getGroundedAircraftAction ────────────────────────────────────────────────

export type GetGroundedAircraftActionResult =
  | { ok: true; aircraft: AircraftListRow[] }
  | AuthErrorResult
  | ServerErrorResult;

export async function getGroundedAircraftAction(): Promise<GetGroundedAircraftActionResult> {
  const session = await auth();
  try {
    const all = await listAircraft(session, {});
    const grounded = all.filter((a) => a.grounded);
    return { ok: true, aircraft: grounded };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── getOpenSquawksAction ─────────────────────────────────────────────────────

export type GetOpenSquawksActionResult =
  | { ok: true; squawks: SerializedSquawkView[] }
  | AuthErrorResult
  | ServerErrorResult;

export async function getOpenSquawksAction(): Promise<GetOpenSquawksActionResult> {
  const session = await auth();
  try {
    const squawks = await listSquawks(session, { status: 'open', limit: 10 });
    return { ok: true, squawks: squawks.map(serializeSquawk) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}
