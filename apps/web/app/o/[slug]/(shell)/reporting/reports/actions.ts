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
 * [VERIFY-A]   Hours = Hobbs-derived operational utilization; NOT airworthiness.
 * [VERIFY-T1-B] Training counts = operator state; NOT Part-141 or FAA determination.
 * [VERIFY-M1-A] Maintenance counts = operator data; NOT Part-43/airworthiness/RTS.
 * [VERIFY-R1-TZ] UTC bucketing; display layer handles formatting.
 */
'use server';

import { auth } from '@/auth';
import {
  getUtilizationTrend,
  getHoursByTail,
  getAircraftReport,
  getReservationsVsFlightsTrend,
  getTrainingThroughput,
  getMaintenanceTrend,
  getInstructorUtilization,
  getSquawksReport,
  getMaintenanceRemindersReport,
  getCancellationsReport,
} from '@aeroops/api';
import type {
  AircraftUtilizationRow,
  AircraftReportRow,
  InstructorUtilizationRow,
  UtilizationTrendResult,
  ReservationsVsFlightsTrendResult,
  TrainingThroughputResult,
  MaintenanceTrendResult,
  ReportRange,
  SquawkReportRow,
  MaintenanceReminderReportRow,
  CancellationReportRow,
  CancellationsReportResult,
  CancellationLeadTimeBucket,
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

// ─── Squawks report (org-wide, tail-enriched) ────────────────────────────────

export interface SerializedSquawkReportRow {
  id: string;
  tailNumber: string;
  title: string;
  description: string | null;
  severity: string;
  status: string;
  reportedAt: string;
  resolvedAt: string | null;
}

export interface SerializedSquawksReport {
  rows: SerializedSquawkReportRow[];
  openCount: number;
  deferredCount: number;
  resolvedCount: number;
}

function serializeSquawkRow(r: SquawkReportRow): SerializedSquawkReportRow {
  return {
    id: r.id,
    tailNumber: r.tailNumber,
    title: r.title,
    description: r.description,
    severity: r.severity,
    status: r.status,
    reportedAt: r.reportedAt instanceof Date ? r.reportedAt.toISOString() : String(r.reportedAt),
    resolvedAt: r.resolvedAt ? (r.resolvedAt instanceof Date ? r.resolvedAt.toISOString() : String(r.resolvedAt)) : null,
  };
}

// ─── Maintenance reminders report (org-wide, tail-enriched) ───────────────────

export interface SerializedMaintenanceReminderRow {
  id: string;
  tailNumber: string;
  title: string;
  status: string;
  trackBy: string;
  meterBasis: string | null;
  dueValueHours: number | null;
  dueDate: string | null;
  remainingHours: number | null;
  remainingDays: number | null;
  currentHobbs: number | null;
  currentTach: number | null;
}

export interface SerializedMaintenanceRemindersReport {
  rows: SerializedMaintenanceReminderRow[];
  overdueCount: number;
  dueSoonCount: number;
  okCount: number;
  unknownCount: number;
}

function serializeMaintenanceReminderRow(r: MaintenanceReminderReportRow): SerializedMaintenanceReminderRow {
  return {
    id: r.id,
    tailNumber: r.tailNumber,
    title: r.title,
    status: r.status,
    trackBy: r.trackBy,
    meterBasis: r.meterBasis,
    dueValueHours: r.dueValueHours,
    dueDate: r.dueDate,
    remainingHours: r.remainingHours ?? null,
    remainingDays: r.remainingDays ?? null,
    currentHobbs: r.currentHobbs,
    currentTach: r.currentTach,
  };
}

// ─── Cancellations report (org-wide, over the range) ─────────────────────────

export interface SerializedCancellationRow {
  reservationId: string;
  cancelledAt: string;
  startAt: string;
  resourceLabel: string;
  cancelledByName: string;
  reason: string | null;
  leadTimeBucket: CancellationLeadTimeBucket;
}

export interface SerializedCancellationsReport {
  range: SerializedReportRange;
  rows: SerializedCancellationRow[];
  totalCount: number;
  lt24hCount: number;
  d1_7Count: number;
  gt7dCount: number;
}

function serializeCancellationRow(r: CancellationReportRow): SerializedCancellationRow {
  return {
    reservationId: r.reservationId,
    cancelledAt: r.cancelledAt instanceof Date ? r.cancelledAt.toISOString() : String(r.cancelledAt),
    startAt: r.startAt instanceof Date ? r.startAt.toISOString() : String(r.startAt),
    resourceLabel: r.resourceLabel,
    cancelledByName: r.cancelledByName,
    reason: r.reason,
    leadTimeBucket: r.leadTimeBucket,
  };
}

function serializeCancellationsReport(r: CancellationsReportResult): SerializedCancellationsReport {
  return {
    range: serializeRange(r.range),
    rows: r.rows.map(serializeCancellationRow),
    totalCount: r.totalCount,
    lt24hCount: r.lt24hCount,
    d1_7Count: r.d1_7Count,
    gt7dCount: r.gt7dCount,
  };
}

// ─── All-reports combined action (Promise.all parallel fetch) ────────────────

export interface AllReportsResult {
  utilizationTrend: SerializedUtilizationTrend;
  hoursByTail: AircraftUtilizationRow[];
  /** FC-parity Aircraft report — per-tail flights/hours/oil/fuel. Plain numbers. */
  aircraftReport: AircraftReportRow[];
  reservationsVsFlights: SerializedReservationsVsFlightsTrend;
  trainingThroughput: SerializedTrainingThroughput;
  maintenanceTrend: SerializedMaintenanceTrend;
  /** Per-CFI utilization — plain numbers/strings, no Dates to serialize. */
  instructorUtilization: InstructorUtilizationRow[];
  squawks: SerializedSquawksReport;
  maintenanceReminders: SerializedMaintenanceRemindersReport;
  cancellations: SerializedCancellationsReport;
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
    const [
      utilizationTrend,
      hoursByTail,
      aircraftReport,
      reservationsVsFlights,
      trainingThroughput,
      maintenanceTrend,
      instructorUtilization,
      squawks,
      maintenanceReminders,
      cancellations,
    ] =
      await Promise.all([
        getUtilizationTrend(session, { range }),
        getHoursByTail(session, { range }),
        getAircraftReport(session, { range }),
        getReservationsVsFlightsTrend(session, { range }),
        getTrainingThroughput(session, { range }),
        getMaintenanceTrend(session, { range }),
        getInstructorUtilization(session, { range }),
        getSquawksReport(session, {}),
        getMaintenanceRemindersReport(session, {}),
        getCancellationsReport(session, { range }),
      ]);

    return {
      ok: true,
      data: {
        utilizationTrend: serializeUtilizationTrend(utilizationTrend),
        hoursByTail,
        aircraftReport,
        reservationsVsFlights: serializeReservationsVsFlightsTrend(reservationsVsFlights),
        trainingThroughput: serializeTrainingThroughput(trainingThroughput),
        maintenanceTrend: serializeMaintenanceTrend(maintenanceTrend),
        instructorUtilization,
        squawks: {
          rows: squawks.rows.map(serializeSquawkRow),
          openCount: squawks.openCount,
          deferredCount: squawks.deferredCount,
          resolvedCount: squawks.resolvedCount,
        },
        maintenanceReminders: {
          rows: maintenanceReminders.rows.map(serializeMaintenanceReminderRow),
          overdueCount: maintenanceReminders.overdueCount,
          dueSoonCount: maintenanceReminders.dueSoonCount,
          okCount: maintenanceReminders.okCount,
          unknownCount: maintenanceReminders.unknownCount,
        },
        cancellations: serializeCancellationsReport(cancellations),
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
