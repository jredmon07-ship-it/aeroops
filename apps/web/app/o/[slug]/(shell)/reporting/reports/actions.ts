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
 * [VERIFY-R1-TZ] Every range read gets the viewer's zone (getViewerTimeZone):
 *   "last N days" is that zone's N calendar days from local midnight, the
 *   trends bucket by its local days / Mondays, and each serialized bucket
 *   carries the `day` it covers (lib/report-buckets.ts) for labels and CSVs.
 */
'use server';

import { actionAuth as auth } from '@/lib/action-auth';
import { getViewerTimeZone } from '@/lib/viewer-time-zone';
import { dayInZone } from '@/lib/schedule-day';
import { bucketDay } from '@/lib/report-buckets';
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
  /** The zone the window and buckets are in (present when one was passed). */
  timeZone?: string;
}

function serializeRange(r: ReportRange): SerializedReportRange {
  return {
    key: r.key,
    from: r.from instanceof Date ? r.from.toISOString() : String(r.from),
    to: r.to instanceof Date ? r.to.toISOString() : String(r.to),
    ...(r.timeZone !== undefined ? { timeZone: r.timeZone } : {}),
  };
}

/** A bucket start as an ISO string + the calendar day it covers in `timeZone`. */
function serializeBucketStart(
  bucketStart: Date | string,
  timeZone: string | undefined,
): { bucketStart: string; day: string } {
  const iso = bucketStart instanceof Date ? bucketStart.toISOString() : String(bucketStart);
  return { bucketStart: iso, day: bucketDay(iso, timeZone) };
}

export interface SerializedUtilizationBucket {
  bucketStart: string;
  /** The day the bucket covers ("YYYY-MM-DD", the viewer's): label + CSV by this. */
  day: string;
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
      ...serializeBucketStart(b.bucketStart, r.range.timeZone),
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
  /** The day the bucket covers ("YYYY-MM-DD", the viewer's): label + CSV by this. */
  day: string;
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
      ...serializeBucketStart(b.bucketStart, r.range.timeZone),
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
  /** null when the caller passed includeTraining: false (Training module off). */
  trainingThroughput: SerializedTrainingThroughput | null;
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
  /**
   * false when the org has the Training module off (Slice CLUB-MODE): the
   * training read is skipped and trainingThroughput comes back null.
   * Defaults to true.
   */
  includeTraining?: boolean;
}): Promise<GetAllReportsActionResult> {
  const session = await auth();
  const range = input?.range ?? '30d';
  const includeTraining = input?.includeTraining ?? true;

  try {
    // The viewer's zone: date reminders are due against their calendar day,
    // not UTC's, and every range read counts their days ("last 30 days" from
    // their local midnight; trend buckets on their local days), so all the
    // sections cover one window.
    const timeZone = await getViewerTimeZone();
    const today = dayInZone(new Date(), timeZone);
    const rangeInput = { range, timeZone };
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
        getUtilizationTrend(session, rangeInput),
        getHoursByTail(session, rangeInput),
        getAircraftReport(session, rangeInput),
        getReservationsVsFlightsTrend(session, rangeInput),
        includeTraining ? getTrainingThroughput(session, rangeInput) : null,
        getMaintenanceTrend(session, rangeInput),
        getInstructorUtilization(session, rangeInput),
        getSquawksReport(session, {}),
        getMaintenanceRemindersReport(session, { today }),
        getCancellationsReport(session, rangeInput),
      ]);

    return {
      ok: true,
      data: {
        utilizationTrend: serializeUtilizationTrend(utilizationTrend),
        hoursByTail,
        aircraftReport,
        reservationsVsFlights: serializeReservationsVsFlightsTrend(reservationsVsFlights),
        trainingThroughput: trainingThroughput ? serializeTrainingThroughput(trainingThroughput) : null,
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
