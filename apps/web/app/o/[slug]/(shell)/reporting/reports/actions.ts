/**
 * reporting/reports/actions.ts — Server actions for Slice R1.2 operational reports.
 *
 * Pattern mirrors reporting-actions.ts (Slice 7):
 *   1. await auth() → session.
 *   2. Call @aeroops/api fn (requireCapability is enforced inside the fn).
 *   3. Map ForbiddenError / UnauthenticatedError → { error: 'forbidden'|'unauthenticated' }.
 *   4. Map ValidationError (code === 'VALIDATION') → { error: 'validation', message }.
 *
 * Dates are serialized to ISO strings at the action boundary so RSC → client
 * components receive plain JSON (Dates are NOT JSON-serializable).
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 * RLS + org_id scoping are enforced inside the API functions (session only).
 *
 * [VERIFY-A]   Hours = Hobbs-derived operational utilization; NOT billing/airworthiness.
 * [VERIFY-T1-B] Training counts = operator state; NOT Part-141 or FAA determination.
 * [VERIFY-M1-A] Maintenance counts = operator data; NOT Part-43/airworthiness/RTS.
 * [VERIFY-R1-TZ] UTC bucketing; display layer handles formatting.
 */
'use server';

import { auth } from '@/auth';
import {
  getUtilizationTrend,
  getHoursByTail,
  getReservationsVsFlightsTrend,
  getTrainingThroughput,
  getMaintenanceTrend,
} from '@aeroops/api';
import type {
  AircraftUtilizationRow,
  UtilizationTrendResult,
  ReservationsVsFlightsTrendResult,
  TrainingThroughputResult,
  MaintenanceTrendResult,
  ReportRange,
} from '@aeroops/api';

// ─── Error shapes ──────────────────────────────────────────────────────────────

import { mapAuthError, isValidationError } from '@/lib/action-errors-result';
import type { AuthErrorResult, ValidationErrorResult, ServerErrorResult } from '@/lib/action-errors-result';

export type { AuthErrorResult, ValidationErrorResult, ServerErrorResult };

// ─── Serialized types (Dates → ISO strings) ───────────────────────────────────

export interface SerializedReportRange {
  key: string;
  from: string;
  to: string;
}

function serializeRange(r: ReportRange): SerializedReportRange {
  return {
    key: r.key,
    from: r.from instanceof Date ? r.from.toISOString() : String(r.from),
    to: r.to instanceof Date ? r.to.toISOString() : String(r.to),
  };
}

export interface SerializedUtilizationBucket {
  bucketStart: string;
  flightCount: number;
  flightHours: number;
}

export interface SerializedUtilizationTrend {
  range: SerializedReportRange;
  granularity: string;
  buckets: SerializedUtilizationBucket[];
  totalFlights: number;
  totalFlightHours: number;
  avgHoursPerFlight: number;
}

function serializeUtilizationTrend(r: UtilizationTrendResult): SerializedUtilizationTrend {
  return {
    range: serializeRange(r.range),
    granularity: r.granularity,
    buckets: r.buckets.map((b) => ({
      bucketStart: b.bucketStart instanceof Date
        ? b.bucketStart.toISOString()
        : String(b.bucketStart),
      flightCount: b.flightCount,
      flightHours: b.flightHours,
    })),
    totalFlights: r.totalFlights,
    totalFlightHours: r.totalFlightHours,
    avgHoursPerFlight: r.avgHoursPerFlight,
  };
}

export interface SerializedReservationsVsFlightsBucket {
  bucketStart: string;
  reservationsCreated: number;
  flightsClosed: number;
}

export interface SerializedReservationsVsFlightsTrend {
  range: SerializedReportRange;
  granularity: string;
  buckets: SerializedReservationsVsFlightsBucket[];
  totalReservationsCreated: number;
  totalFlightsClosed: number;
}

function serializeReservationsVsFlightsTrend(
  r: ReservationsVsFlightsTrendResult,
): SerializedReservationsVsFlightsTrend {
  return {
    range: serializeRange(r.range),
    granularity: r.granularity,
    buckets: r.buckets.map((b) => ({
      bucketStart: b.bucketStart instanceof Date
        ? b.bucketStart.toISOString()
        : String(b.bucketStart),
      reservationsCreated: b.reservationsCreated,
      flightsClosed: b.flightsClosed,
    })),
    totalReservationsCreated: r.totalReservationsCreated,
    totalFlightsClosed: r.totalFlightsClosed,
  };
}

export interface SerializedTrainingThroughput {
  range: SerializedReportRange;
  enrollmentsCreatedInRange: number;
  enrollmentsCompletedInRange: number;
  lessonsRecordedInRange: number;
  activeEnrollmentCount: number;
}

function serializeTrainingThroughput(r: TrainingThroughputResult): SerializedTrainingThroughput {
  return {
    range: serializeRange(r.range),
    enrollmentsCreatedInRange: r.enrollmentsCreatedInRange,
    enrollmentsCompletedInRange: r.enrollmentsCompletedInRange,
    lessonsRecordedInRange: r.lessonsRecordedInRange,
    activeEnrollmentCount: r.activeEnrollmentCount,
  };
}

export interface SerializedMaintenanceTrend {
  range: SerializedReportRange;
  squawksOpenedInRange: number;
  squawksResolvedInRange: number;
  workOrdersOpenedInRange: number;
  workOrdersCompletedInRange: number;
  openSquawkCount: number;
  groundedAircraftCount: number;
}

function serializeMaintenanceTrend(r: MaintenanceTrendResult): SerializedMaintenanceTrend {
  return {
    range: serializeRange(r.range),
    squawksOpenedInRange: r.squawksOpenedInRange,
    squawksResolvedInRange: r.squawksResolvedInRange,
    workOrdersOpenedInRange: r.workOrdersOpenedInRange,
    workOrdersCompletedInRange: r.workOrdersCompletedInRange,
    openSquawkCount: r.openSquawkCount,
    groundedAircraftCount: r.groundedAircraftCount,
  };
}

// ─── All-reports combined action (Promise.all parallel fetch) ────────────────

export interface AllReportsResult {
  utilizationTrend: SerializedUtilizationTrend;
  hoursByTail: AircraftUtilizationRow[];
  reservationsVsFlights: SerializedReservationsVsFlightsTrend;
  trainingThroughput: SerializedTrainingThroughput;
  maintenanceTrend: SerializedMaintenanceTrend;
}

export type GetAllReportsActionResult =
  | { ok: true; data: AllReportsResult }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getAllReportsAction(input?: {
  range?: string;
}): Promise<GetAllReportsActionResult> {
  const session = await auth();
  const range = input?.range ?? '30d';

  try {
    const [utilizationTrend, hoursByTail, reservationsVsFlights, trainingThroughput, maintenanceTrend] =
      await Promise.all([
        getUtilizationTrend(session, { range }),
        getHoursByTail(session, { range }),
        getReservationsVsFlightsTrend(session, { range }),
        getTrainingThroughput(session, { range }),
        getMaintenanceTrend(session, { range }),
      ]);

    return {
      ok: true,
      data: {
        utilizationTrend: serializeUtilizationTrend(utilizationTrend),
        hoursByTail,
        reservationsVsFlights: serializeReservationsVsFlightsTrend(reservationsVsFlights),
        trainingThroughput: serializeTrainingThroughput(trainingThroughput),
        maintenanceTrend: serializeMaintenanceTrend(maintenanceTrend),
      },
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: err.message };
    }
    return { error: 'server' };
  }
}
