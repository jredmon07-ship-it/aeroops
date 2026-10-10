/**
 * reporting/reports/page.tsx — Operational Reports page (Slice R1.2, RSC).
 *
 * Route: /o/[slug]/reporting/reports
 * Capability: reporting:access (owner/manager/dispatcher/cfi/accountant).
 *   — NO redirect on denied (shell is app:access); renders permission-denied panel.
 *   — Real gate is enforced inside the API fns (requireCapability).
 *
 * Layout (top → bottom):
 *   A. Heading "Operational reports" + range selector (?range= links, OUTSIDE Suspense)
 *   B. Fleet utilization over time (stat strip + bucket bar-rows + hours footnote)
 *   C. Hours by tail (utilization-table: Tail# → /fleet/[id], Flights, Hours, bar)
 *   D. Reservations & flights trend (two-series bucket rows)
 *   E. Training throughput (compact stat group + operator-count caption)
 *   F. Maintenance trend (stat group; grounded>0 → text-danger; caption)
 *
 * States:
 *   Loading           — ReportsSkeleton (Suspense boundary, aria-busy)
 *   Populated         — full layout
 *   Empty org         — faded-0 stats + nudge link to Resources
 *   Range-no-data     — faded-0 bucket metrics + "try a wider range" note
 *   Error             — destructive Alert + Retry preserving ?range=
 *   Permission-denied — tasteful "not available" panel; NO redirect
 *
 * BOUNDARY: imports ONLY from '@aeroops/api'. Never '@aeroops/db'.
 *
 * [VERIFY-A]   Hours = Hobbs-derived operational utilization; NOT airworthiness.
 * [VERIFY-T1-B] Training counts = operator state; NOT Part-141 or FAA determination.
 * [VERIFY-M1-A] Maintenance counts = operator data; NOT Part-43/airworthiness/RTS.
 * [VERIFY-R1-TZ] UTC bucketing throughout.
 */

import * as React from 'react';
import { Suspense } from 'react';
import Link from 'next/link';
import { AlertCircle, GraduationCap, Wrench, ClipboardList, CalendarX2 } from 'lucide-react';
import { auth } from '@/auth';
import { hasCapability, getOrgFeatures } from '@aeroops/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { getAllReportsAction } from './actions';
import type { AllReportsResult } from './actions';
import {
  resolveReportRangeKey,
  reportRangeLabelFull,
  formatBucketLabel,
  clampReportBarWidth,
} from './_components/report-utils';
import type { ReportRangeKey } from './_components/report-utils';
import { PageHeader } from '@/components/ui/page-header';
import { BarTrend } from '@/components/ui/chart';
import { SectionHeader } from '@/components/ui/section-header';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { ExportCsvButton } from '@/components/ui/export-csv-button';
import { csvDate, csvFilename } from '@/lib/csv-format';

// ─── Hours footnote (verbatim per spec) ──────────────────────────────────────

const HOURS_FOOTNOTE =
  'Utilization hours derived from recorded Hobbs at check-in. Operational figure only — not an airworthiness statement.';

const OPERATOR_COUNT_CAPTION =
  'Operator counts — not a Part-141, airworthiness, or regulatory determination.';

// Lead-time-before-start bucket labels (cancellations report).
const LEAD_TIME_LABELS: Record<'lt24h' | 'd1_7' | 'gt7d', string> = {
  lt24h: '<24h',
  d1_7: '1–7d',
  gt7d: '>7d',
};

// ─── Permission-denied panel (reuses dashboard design) ───────────────────────

function PermissionDeniedPanel() {
  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-6 py-10 text-center space-y-2">
      <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
        Reporting isn&apos;t available for your role.
      </p>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Contact your administrator if you need access.
      </p>
    </div>
  );
}

// ─── Module-disabled panel (Slice CLUB-MODE) ──────────────────────────────────

function ModuleDisabledPanel() {
  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-6 py-10 text-center space-y-2">
      <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
        Reports are turned off for this organization.
      </p>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        An owner or manager can turn them back on in Org settings.
      </p>
    </div>
  );
}

// ─── Range selector (OUTSIDE Suspense; always interactive) ───────────────────

const RANGE_OPTIONS: Array<{ key: ReportRangeKey; label: string }> = [
  { key: '7d',   label: '7d' },
  { key: '30d',  label: '30d' },
  { key: '90d',  label: '90d' },
  { key: '180d', label: '180d' },
  { key: '365d', label: '365d' },
];

interface RangeSelectorProps {
  slug: string;
  current: ReportRangeKey;
}

function RangeSelector({ slug, current }: RangeSelectorProps) {
  return (
    <nav aria-label="Report range" className="flex items-center rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
      {RANGE_OPTIONS.map(({ key, label }) => {
        const isActive = current === key;
        return (
          <Link
            key={key}
            href={`/o/${slug}/reporting/reports?range=${key}`}
            aria-current={isActive ? 'page' : undefined}
            className={[
              'px-3 py-1.5 text-xs font-medium transition-colors',
              isActive
                ? 'bg-brand-ink text-white'
                : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
            ].join(' ')}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function ReportsSkeleton() {
  return (
    <div
      className="space-y-8 animate-pulse"
      aria-busy="true"
      aria-label="Loading operational reports"
    >
      {/* Section B skeleton — utilization trend stat strip + bar rows */}
      <div>
        <Skeleton className="h-3 w-48 mb-3" />
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs p-4 space-y-4">
          {/* Stat strip */}
          <div className="grid grid-cols-3 gap-4 pb-4 border-b border-slate-100 dark:border-slate-800">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-2.5 w-16" />
                <Skeleton className="h-7 w-12" />
              </div>
            ))}
          </div>
          {/* Bucket rows */}
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-2.5 w-12 shrink-0" />
              <Skeleton className="h-2.5 w-8 shrink-0" />
              <Skeleton className="h-2.5 w-10 shrink-0" />
              <div className="flex-1">
                <Skeleton className="h-2 rounded-full" style={{ width: `${30 + i * 12}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Section C skeleton — hours by tail */}
      <div>
        <Skeleton className="h-3 w-36 mb-3" />
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden">
          <div className="h-10 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 border-b border-slate-100 dark:border-slate-800 flex items-center px-4 gap-8">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-8" />
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-1.5 w-24 rounded-full" />
            </div>
          ))}
        </div>
      </div>

      {/* Section D skeleton — reservations vs flights */}
      <div>
        <Skeleton className="h-3 w-52 mb-3" />
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs p-4 space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-2.5 w-12 shrink-0" />
              <Skeleton className="h-2.5 w-8 shrink-0" />
              <div className="flex-1 space-y-1">
                <Skeleton className="h-1.5 rounded-full" style={{ width: `${40 + i * 10}%` }} />
                <Skeleton className="h-1.5 rounded-full" style={{ width: `${25 + i * 8}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Sections E + F skeleton — compact stat groups */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
        {[0, 1].map((i) => (
          <div key={i}>
            <Skeleton className="h-3 w-36 mb-3" />
            <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs p-4 space-y-3">
              {[0, 1, 2, 3].map((j) => (
                <div key={j} className="flex items-center justify-between">
                  <Skeleton className="h-2.5 w-32" />
                  <Skeleton className="h-5 w-10" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Stat number cell (fades when zero) ──────────────────────────────────────

function StatNum({
  value,
  suffix = '',
  danger = false,
}: {
  value: number;
  suffix?: string;
  danger?: boolean;
}) {
  const isZero = value === 0;
  return (
    <span
      className={[
        'nums text-2xl font-bold leading-none',
        danger && !isZero
          ? 'text-danger'
          : isZero
          ? 'text-slate-300'
          : 'text-slate-900 dark:text-slate-100',
      ].join(' ')}
    >
      {value}
      {suffix && (
        <span className="text-base font-normal text-slate-400 dark:text-slate-500 ml-0.5">{suffix}</span>
      )}
    </span>
  );
}

// ─── Compact stat row ─────────────────────────────────────────────────────────

function StatRow({
  label,
  value,
  note,
  danger = false,
}: {
  label: string;
  value: number;
  note?: string;
  danger?: boolean;
}) {
  const isZero = value === 0;
  return (
    <div className="flex items-center justify-between gap-2 py-1.5 border-b border-slate-100 dark:border-slate-800 last:border-0">
      <span className="text-sm text-slate-600 dark:text-slate-300">{label}</span>
      <div className="flex items-center gap-2 shrink-0">
        {note && (
          <span className="text-xs text-slate-400 dark:text-slate-500">{note}</span>
        )}
        <span
          className={[
            'nums text-sm font-bold tabular-nums',
            danger && !isZero
              ? 'text-danger'
              : isZero
              ? 'text-slate-300'
              : 'text-slate-900 dark:text-slate-100',
          ].join(' ')}
        >
          {value}
        </span>
      </div>
    </div>
  );
}

// ─── Reports content (B+C+D+E+F) — async RSC ─────────────────────────────────

interface ReportsContentProps {
  slug: string;
  range: ReportRangeKey;
}

async function ReportsContent({ slug, range }: ReportsContentProps) {
  const result = await getAllReportsAction({ range });

  // Error state
  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load report data. Please try again.</span>
          <Link
            href={`/o/${slug}/reporting/reports?range=${range}`}
            className="text-sm underline underline-offset-2 hover:no-underline"
          >
            Retry
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  const { data } = result as { ok: true; data: AllReportsResult };
  const {
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
  } = data;

  const hasInstructorActivity = instructorUtilization.some(
    (r) => r.flightHours > 0 || r.flightCount > 0 || r.lessonsGiven > 0 || r.distinctStudents > 0,
  );

  const rangeLbl = reportRangeLabelFull(range);
  const gran = utilizationTrend.granularity;

  // Detect empty-org: no tail rows AND no flights at all
  const isEmptyOrg = hoursByTail.length === 0 && utilizationTrend.totalFlights === 0;

  // Bar scale computations
  const maxBucketHours = utilizationTrend.buckets.reduce(
    (acc, b) => Math.max(acc, b.flightHours),
    0,
  );
  const maxTailHours =
    hoursByTail.length > 0 ? Math.max(...hoursByTail.map((r) => r.flightHours)) : 0;
  const maxResCreated = reservationsVsFlights.buckets.reduce(
    (acc, b) => Math.max(acc, b.reservationsCreated, b.flightsClosed),
    0,
  );

  const hasUtilizationData = utilizationTrend.totalFlights > 0 || utilizationTrend.totalFlightHours > 0;
  const hasResvData =
    reservationsVsFlights.totalReservationsCreated > 0 ||
    reservationsVsFlights.totalFlightsClosed > 0;
  const hasTrainingData =
    trainingThroughput.enrollmentsCreatedInRange > 0 ||
    trainingThroughput.enrollmentsCompletedInRange > 0 ||
    trainingThroughput.lessonsRecordedInRange > 0;
  const hasMaintenanceData =
    maintenanceTrend.squawksOpenedInRange > 0 ||
    maintenanceTrend.squawksResolvedInRange > 0 ||
    maintenanceTrend.workOrdersOpenedInRange > 0 ||
    maintenanceTrend.workOrdersCompletedInRange > 0;

  // ── CSV grids (header row + data rows) for each section's Export button ──────
  const utilizationCsv: string[][] = [
    ['Period', 'Flights', 'Hours'],
    ...utilizationTrend.buckets.map((b) => [
      csvDate(b.bucketStart),
      String(b.flightCount),
      b.flightHours.toFixed(1),
    ]),
  ];
  const hoursByTailCsv: string[][] = [
    ['Tail #', 'Flights', 'Hours'],
    ...hoursByTail.map((r) => [r.tailNumber, String(r.flightCount), r.flightHours.toFixed(1)]),
  ];
  const aircraftReportCsv: string[][] = [
    ['Tail #', 'Flights', 'Hours', 'Oil Added (qt)', 'Fuel Added (gal)'],
    ...aircraftReport.map((r) => [
      r.tailNumber,
      String(r.flightCount),
      r.flightHours.toFixed(1),
      r.oilAddedQuarts.toFixed(1),
      r.fuelAddedGallons.toFixed(1),
    ]),
  ];
  const reservationsCsv: string[][] = [
    ['Period', 'Reservations created', 'Flights closed'],
    ...reservationsVsFlights.buckets.map((b) => [
      csvDate(b.bucketStart),
      String(b.reservationsCreated),
      String(b.flightsClosed),
    ]),
  ];
  const trainingCsv: string[][] = [
    ['Metric', 'Value'],
    ['Enrollments created', String(trainingThroughput.enrollmentsCreatedInRange)],
    ['Enrollments completed', String(trainingThroughput.enrollmentsCompletedInRange)],
    ['Lessons recorded', String(trainingThroughput.lessonsRecordedInRange)],
    ['Active enrollments now', String(trainingThroughput.activeEnrollmentCount)],
  ];
  const maintenanceTrendCsv: string[][] = [
    ['Metric', 'Value'],
    ['Squawks opened', String(maintenanceTrend.squawksOpenedInRange)],
    ['Squawks resolved', String(maintenanceTrend.squawksResolvedInRange)],
    ['Work orders opened', String(maintenanceTrend.workOrdersOpenedInRange)],
    ['Work orders completed', String(maintenanceTrend.workOrdersCompletedInRange)],
    ['Open squawks now', String(maintenanceTrend.openSquawkCount)],
    ['Grounded aircraft now', String(maintenanceTrend.groundedAircraftCount)],
  ];
  const instructorCsv: string[][] = [
    ['Instructor', 'Flights', 'Hours', 'Lessons', 'Students'],
    ...instructorUtilization.map((r) => [
      r.instructorName,
      String(r.flightCount),
      r.flightHours.toFixed(1),
      String(r.lessonsGiven),
      String(r.distinctStudents),
    ]),
  ];
  const squawksCsv: string[][] = [
    ['Tail #', 'Title', 'Severity', 'Status', 'Reported', 'Description'],
    ...squawks.rows.map((r) => [
      r.tailNumber,
      r.title,
      r.severity,
      r.status,
      csvDate(r.reportedAt),
      r.description ?? '',
    ]),
  ];
  const cancellationsCsv: string[][] = [
    ['Cancelled', 'Resource', 'Cancelled by', 'Reason', 'Reservation start', 'Lead time'],
    ...cancellations.rows.map((r) => [
      csvDate(r.cancelledAt),
      r.resourceLabel,
      r.cancelledByName,
      r.reason ?? '—',
      csvDate(r.startAt),
      LEAD_TIME_LABELS[r.leadTimeBucket],
    ]),
  ];
  const remindersCsv: string[][] = [
    ['Tail #', 'Item', 'Status', 'Due', 'Remaining', 'Current Hobbs', 'Current Tach'],
    ...maintenanceReminders.rows.map((r) => [
      r.tailNumber,
      r.title,
      r.status,
      r.dueDate ?? (r.dueValueHours != null ? `${r.dueValueHours.toFixed(1)}h` : ''),
      r.remainingHours != null
        ? `${r.remainingHours.toFixed(1)}h`
        : r.remainingDays != null
          ? `${r.remainingDays}d`
          : '',
      r.currentHobbs != null ? r.currentHobbs.toFixed(1) : '',
      r.currentTach != null ? r.currentTach.toFixed(1) : '',
    ]),
  ];

  const dueStatusVariant = (s: string) =>
    s === 'overdue' ? 'danger' : s === 'due_soon' ? 'warning' : s === 'unknown' ? 'neutral' : 'success';
  const squawkStatusVariant = (s: string) =>
    s === 'open' ? 'warning' : s === 'deferred' ? 'info' : 'neutral';
  const severityVariant = (s: string) =>
    s === 'grounding' ? 'danger' : s === 'high' ? 'danger' : s === 'medium' ? 'warning' : 'neutral';

  return (
    <div className="space-y-8">

      {/* ── B. Fleet utilization over time ───────────────────────────────── */}
      <section aria-label={`Fleet utilization over time — last ${rangeLbl}`}>
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-[0.625rem] uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500">
            Fleet utilization over time — last {rangeLbl}
          </p>
          <ExportCsvButton rows={utilizationCsv} filename={csvFilename('utilization-trend')} />
        </div>
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
          {/* Stat strip */}
          <div className="grid grid-cols-3 divide-x divide-slate-100 dark:divide-slate-800 border-b border-slate-100 dark:border-slate-800">
            <div className="px-5 py-4">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Total flights
              </p>
              <StatNum value={utilizationTrend.totalFlights} />
              <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                {utilizationTrend.totalFlights === 0 ? 'none in period' : 'completed dispatches'}
              </p>
            </div>
            <div className="px-5 py-4">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Total hours *
              </p>
              <p
                className={[
                  'nums mt-1 text-2xl font-bold leading-none',
                  utilizationTrend.totalFlightHours === 0 ? 'text-slate-300' : 'text-slate-900 dark:text-slate-100',
                ].join(' ')}
              >
                {utilizationTrend.totalFlightHours.toFixed(1)}
              </p>
              <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">utilization hrs</p>
            </div>
            <div className="px-5 py-4">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Avg hrs / flight *
              </p>
              <p
                className={[
                  'nums mt-1 text-2xl font-bold leading-none',
                  utilizationTrend.avgHoursPerFlight === 0 ? 'text-slate-300' : 'text-slate-900 dark:text-slate-100',
                ].join(' ')}
              >
                {utilizationTrend.avgHoursPerFlight.toFixed(1)}
              </p>
              <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                {utilizationTrend.totalFlights === 0 ? '—' : 'per closed dispatch'}
              </p>
            </div>
          </div>

          {/* Column chart (visual) + bucket bar-rows (detail) */}
          <div className="p-4">
            {utilizationTrend.buckets.length > 0 && (
              <BarTrend
                className="mb-5"
                categories={utilizationTrend.buckets.map((b) => formatBucketLabel(b.bucketStart, gran))}
                series={[
                  {
                    label: 'Flight hours',
                    color: 'hsl(var(--color-brand))',
                    values: utilizationTrend.buckets.map((b) => b.flightHours),
                  },
                ]}
                valueLabel={(v) => `${v.toFixed(1)}h`}
                ariaLabel={`Flight hours per ${gran}: ${utilizationTrend.totalFlightHours.toFixed(1)} hours total across ${utilizationTrend.totalFlights} flights.`}
                emptyLabel="No flights in the selected period."
              />
            )}
            {utilizationTrend.buckets.length === 0 ? (
              <p className="text-center text-sm text-slate-400 dark:text-slate-500 py-4">
                No bucket data available.
              </p>
            ) : (
              <div className="space-y-2">
                {utilizationTrend.buckets.map((bucket, i) => {
                  const barWidth = clampReportBarWidth(bucket.flightHours, maxBucketHours);
                  const label = formatBucketLabel(bucket.bucketStart, gran);
                  return (
                    <div key={i} className="flex items-center gap-3 text-xs">
                      <span className="nums text-slate-500 dark:text-slate-400 w-14 shrink-0 tabular-nums">
                        {label}
                      </span>
                      <span
                        className={[
                          'nums w-8 shrink-0 text-right tabular-nums',
                          bucket.flightCount === 0 ? 'text-slate-300' : 'text-slate-700 dark:text-slate-300',
                        ].join(' ')}
                        aria-label={`${bucket.flightCount} flights`}
                      >
                        {bucket.flightCount}
                      </span>
                      <span
                        className={[
                          'nums w-12 shrink-0 text-right tabular-nums',
                          bucket.flightHours === 0 ? 'text-slate-300' : 'text-slate-700 dark:text-slate-300',
                        ].join(' ')}
                        aria-label={`${bucket.flightHours.toFixed(1)} hours`}
                      >
                        {bucket.flightHours.toFixed(1)}h
                      </span>
                      <div
                        className="flex-1 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800"
                        aria-hidden="true"
                      >
                        <div
                          className="h-1.5 rounded-full bg-brand"
                          style={{ width: `${barWidth}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Range-no-data note */}
            {!hasUtilizationData && !isEmptyOrg && (
              <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
                No flights in the selected period. Try a wider range.
              </p>
            )}

            {/* Empty-org nudge */}
            {isEmptyOrg && (
              <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
                No aircraft yet.{' '}
                <Link
                  href={`/o/${slug}/schedule/resources`}
                  className="text-brand underline underline-offset-2 hover:text-brand-ink"
                >
                  Add aircraft in Resources.
                </Link>
              </p>
            )}
          </div>
        </div>
        {/* Hours footnote — verbatim [VERIFY-A] */}
        <p className="mt-1.5 text-[0.6875rem] text-slate-400 dark:text-slate-500">
          * {HOURS_FOOTNOTE}
        </p>
      </section>

      {/* ── C. Hours by tail ──────────────────────────────────────────────── */}
      <section aria-label={`Hours by tail — last ${rangeLbl}`}>
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-[0.625rem] uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500">
            Hours by tail — last {rangeLbl}
          </p>
          <ExportCsvButton rows={hoursByTailCsv} filename={csvFilename('hours-by-tail')} disabled={hoursByTail.length === 0} />
        </div>
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-x-auto">
          <table
            className="w-full text-sm"
            aria-label={`Hours by tail last ${rangeLbl}`}
          >
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
                <th
                  scope="col"
                  className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400"
                >
                  Tail #
                </th>
                <th
                  scope="col"
                  className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400"
                >
                  Flights
                </th>
                <th
                  scope="col"
                  className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400"
                >
                  Hours *
                </th>
                <th
                  scope="col"
                  className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400 w-28"
                >
                  Utilization
                </th>
              </tr>
            </thead>
            <tbody>
              {hoursByTail.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500"
                  >
                    No active aircraft.{' '}
                    <Link
                      href={`/o/${slug}/schedule/resources`}
                      className="text-brand underline underline-offset-2 hover:text-brand-ink"
                    >
                      Add aircraft in Resources admin.
                    </Link>
                  </td>
                </tr>
              ) : (
                hoursByTail.map((row) => {
                  const barWidth = clampReportBarWidth(row.flightHours, maxTailHours);
                  return (
                    <tr
                      key={row.resourceId}
                      className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/o/${slug}/fleet/${row.resourceId}`}
                          className="nums font-bold text-slate-900 dark:text-slate-100 hover:text-brand underline-offset-2 hover:underline"
                          aria-label={`View details for ${row.tailNumber}`}
                        >
                          {row.tailNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span
                          className={[
                            'nums tabular-nums',
                            row.flightCount === 0 ? 'text-slate-300' : 'text-slate-700 dark:text-slate-300',
                          ].join(' ')}
                        >
                          {row.flightCount}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span
                          className={[
                            'nums tabular-nums',
                            row.flightHours === 0 ? 'text-slate-300' : 'text-slate-700 dark:text-slate-300',
                          ].join(' ')}
                        >
                          {row.flightHours.toFixed(1)}h
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div
                          className="w-24 h-1.5 rounded-full bg-slate-100 dark:bg-slate-800"
                          aria-hidden="true"
                        >
                          <div
                            className="h-1.5 rounded-full bg-brand"
                            style={{ width: `${barWidth}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-1.5 text-[0.6875rem] text-slate-400 dark:text-slate-500">
          * {HOURS_FOOTNOTE}
        </p>
      </section>

      {/* ── C2. Aircraft report (FC-parity: flights/hours/oil/fuel) ───────── */}
      <section aria-label={`Aircraft report — last ${rangeLbl}`}>
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-[0.625rem] uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500">
            Aircraft report — last {rangeLbl}
          </p>
          <ExportCsvButton
            rows={aircraftReportCsv}
            filename={csvFilename('aircraft-report')}
            disabled={aircraftReport.length === 0}
          />
        </div>
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-x-auto">
          <table className="w-full text-sm" aria-label={`Aircraft report last ${rangeLbl}`}>
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
                <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Tail #
                </th>
                <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Flights
                </th>
                <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Hours *
                </th>
                <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Oil added
                </th>
                <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Fuel added
                </th>
              </tr>
            </thead>
            <tbody>
              {aircraftReport.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-sm text-slate-400 dark:text-slate-500">
                    No active aircraft.{' '}
                    <Link
                      href={`/o/${slug}/schedule/resources`}
                      className="text-brand underline underline-offset-2 hover:text-brand-ink"
                    >
                      Add aircraft in Resources admin.
                    </Link>
                  </td>
                </tr>
              ) : (
                aircraftReport.map((row) => (
                  <tr
                    key={row.resourceId}
                    className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/o/${slug}/fleet/${row.resourceId}`}
                        className="nums font-bold text-slate-900 dark:text-slate-100 hover:text-brand underline-offset-2 hover:underline"
                        aria-label={`View details for ${row.tailNumber}`}
                      >
                        {row.tailNumber}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={['nums tabular-nums', row.flightCount === 0 ? 'text-slate-300' : 'text-slate-700 dark:text-slate-300'].join(' ')}>
                        {row.flightCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={['nums tabular-nums', row.flightHours === 0 ? 'text-slate-300' : 'text-slate-700 dark:text-slate-300'].join(' ')}>
                        {row.flightHours.toFixed(1)}h
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={['nums tabular-nums', row.oilAddedQuarts === 0 ? 'text-slate-300' : 'text-slate-700 dark:text-slate-300'].join(' ')}>
                        {row.oilAddedQuarts.toFixed(1)} qt
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={['nums tabular-nums', row.fuelAddedGallons === 0 ? 'text-slate-300' : 'text-slate-700 dark:text-slate-300'].join(' ')}>
                        {row.fuelAddedGallons.toFixed(1)} gal
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-1.5 text-[0.6875rem] text-slate-400 dark:text-slate-500">
          * {HOURS_FOOTNOTE} Oil &amp; fuel are operator line-ops uplift figures recorded at check-in — not a maintenance or airworthiness record.
        </p>
      </section>

      {/* ── D. Reservations & flights trend ──────────────────────────────── */}
      <section aria-label={`Reservations and flights trend — last ${rangeLbl}`}>
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-[0.625rem] uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500">
            Reservations &amp; flights trend — last {rangeLbl}
          </p>
          <ExportCsvButton rows={reservationsCsv} filename={csvFilename('reservations-vs-flights')} />
        </div>
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
          {/* Totals strip */}
          <div className="grid grid-cols-2 divide-x divide-slate-100 dark:divide-slate-800 border-b border-slate-100 dark:border-slate-800">
            <div className="px-5 py-3">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Reservations created
              </p>
              <StatNum value={reservationsVsFlights.totalReservationsCreated} />
              <p className="mt-0.5 text-[0.6875rem] text-slate-400 dark:text-slate-500">
                all statuses incl. cancelled
              </p>
            </div>
            <div className="px-5 py-3">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Flights completed
              </p>
              <StatNum value={reservationsVsFlights.totalFlightsClosed} />
              <p className="mt-0.5 text-[0.6875rem] text-slate-400 dark:text-slate-500">closed dispatches</p>
            </div>
          </div>

          {/* Bucket rows — two series */}
          <div className="p-4">
            {/* Legend */}
            <div className="flex items-center gap-4 mb-3">
              <div className="flex items-center gap-1.5">
                <div className="h-1.5 w-4 rounded-full bg-brand" aria-hidden="true" />
                <span className="text-xs text-slate-500 dark:text-slate-400">Reservations</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-1.5 w-4 rounded-full bg-success" aria-hidden="true" />
                <span className="text-xs text-slate-500 dark:text-slate-400">Flights closed</span>
              </div>
            </div>

            {reservationsVsFlights.buckets.length > 0 && (
              <BarTrend
                className="mb-5"
                showLegend={false}
                categories={reservationsVsFlights.buckets.map((b) => formatBucketLabel(b.bucketStart, gran))}
                series={[
                  {
                    label: 'Reservations',
                    color: 'hsl(var(--color-brand))',
                    values: reservationsVsFlights.buckets.map((b) => b.reservationsCreated),
                  },
                  {
                    label: 'Flights closed',
                    color: 'hsl(var(--color-success))',
                    values: reservationsVsFlights.buckets.map((b) => b.flightsClosed),
                  },
                ]}
                ariaLabel={`Reservations created versus flights closed per ${gran}: ${reservationsVsFlights.totalReservationsCreated} reservations, ${reservationsVsFlights.totalFlightsClosed} flights.`}
                emptyLabel="No activity in the selected period."
              />
            )}
            {reservationsVsFlights.buckets.length === 0 ? (
              <p className="text-center text-sm text-slate-400 dark:text-slate-500 py-4">
                No bucket data available.
              </p>
            ) : (
              <div className="space-y-3">
                {reservationsVsFlights.buckets.map((bucket, i) => {
                  const resvBar = clampReportBarWidth(bucket.reservationsCreated, maxResCreated);
                  const flightBar = clampReportBarWidth(bucket.flightsClosed, maxResCreated);
                  const label = formatBucketLabel(bucket.bucketStart, gran);
                  return (
                    <div key={i} className="flex items-start gap-3 text-xs">
                      <span className="nums text-slate-500 dark:text-slate-400 w-14 shrink-0 tabular-nums pt-0.5">
                        {label}
                      </span>
                      <div className="w-10 shrink-0 text-right space-y-1">
                        <span
                          className={[
                            'nums block tabular-nums',
                            bucket.reservationsCreated === 0 ? 'text-slate-300' : 'text-slate-700 dark:text-slate-300',
                          ].join(' ')}
                        >
                          {bucket.reservationsCreated}
                        </span>
                        <span
                          className={[
                            'nums block tabular-nums',
                            bucket.flightsClosed === 0 ? 'text-slate-300' : 'text-slate-500 dark:text-slate-400',
                          ].join(' ')}
                        >
                          {bucket.flightsClosed}
                        </span>
                      </div>
                      <div className="flex-1 space-y-1" aria-hidden="true">
                        <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800">
                          <div
                            className="h-1.5 rounded-full bg-brand"
                            style={{ width: `${resvBar}%` }}
                          />
                        </div>
                        <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800">
                          <div
                            className="h-1.5 rounded-full bg-success"
                            style={{ width: `${flightBar}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {!hasResvData && !isEmptyOrg && (
              <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
                No activity in the selected period. Try a wider range.
              </p>
            )}
          </div>
        </div>
      </section>

      {/* ── E + F compact stat groups (side by side on sm+) ──────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">

        {/* E. Training throughput */}
        <section aria-label={`Training throughput — last ${rangeLbl}`}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-[0.625rem] uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500">
              Training throughput — last {rangeLbl}
            </p>
            <ExportCsvButton rows={trainingCsv} filename={csvFilename('training-throughput')} />
          </div>
          <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs px-4 py-3">
            <StatRow
              label="Enrollments created"
              value={trainingThroughput.enrollmentsCreatedInRange}
            />
            <StatRow
              label="Enrollments completed"
              value={trainingThroughput.enrollmentsCompletedInRange}
            />
            <StatRow
              label="Lessons recorded"
              value={trainingThroughput.lessonsRecordedInRange}
            />
            <StatRow
              label="Active enrollments now"
              value={trainingThroughput.activeEnrollmentCount}
              note="snapshot"
            />
          </div>
          {!hasTrainingData && !isEmptyOrg && (
            <p className="mt-1.5 text-xs text-slate-400 dark:text-slate-500">
              No training activity in period. Try a wider range.
            </p>
          )}
          <p className="mt-1.5 text-[0.6875rem] text-slate-400 dark:text-slate-500">
            {OPERATOR_COUNT_CAPTION}
          </p>
        </section>

        {/* F. Maintenance trend */}
        <section aria-label={`Maintenance trend — last ${rangeLbl}`}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-[0.625rem] uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500">
              Maintenance trend — last {rangeLbl}
            </p>
            <ExportCsvButton rows={maintenanceTrendCsv} filename={csvFilename('maintenance-trend')} />
          </div>
          <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs px-4 py-3">
            <StatRow
              label="Squawks opened"
              value={maintenanceTrend.squawksOpenedInRange}
            />
            <StatRow
              label="Squawks resolved"
              value={maintenanceTrend.squawksResolvedInRange}
            />
            <StatRow
              label="Work orders opened"
              value={maintenanceTrend.workOrdersOpenedInRange}
            />
            <StatRow
              label="Work orders completed"
              value={maintenanceTrend.workOrdersCompletedInRange}
            />
            <StatRow
              label="Open squawks now"
              value={maintenanceTrend.openSquawkCount}
              note="snapshot"
            />
            <StatRow
              label="Grounded aircraft now"
              value={maintenanceTrend.groundedAircraftCount}
              note="snapshot"
              danger
            />
          </div>
          {!hasMaintenanceData && !isEmptyOrg && (
            <p className="mt-1.5 text-xs text-slate-400 dark:text-slate-500">
              No maintenance activity in period. Try a wider range.
            </p>
          )}
          <p className="mt-1.5 text-[0.6875rem] text-slate-400 dark:text-slate-500">
            {OPERATOR_COUNT_CAPTION}
          </p>
        </section>
      </div>

      {/* ── G. Instructor utilization ─────────────────────────────────────── */}
      <section aria-label={`Instructor utilization — last ${rangeLbl}`}>
        <div className="mb-1.5 flex items-end justify-between gap-3">
          <SectionHeader eyebrow={`Instructor utilization — last ${rangeLbl}`} className="mb-0" />
          <ExportCsvButton rows={instructorCsv} filename={csvFilename('instructor-utilization')} disabled={instructorUtilization.length === 0} />
        </div>
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-x-auto">
          {instructorUtilization.length === 0 ? (
            <EmptyState
              icon={GraduationCap}
              title="No instructors yet."
              body={
                <>
                  Members with the CFI role appear here with their flight and
                  lesson activity.
                </>
              }
              className="py-10"
            />
          ) : (
            <table
              className="w-full text-sm"
              aria-label={`Instructor utilization last ${rangeLbl}`}
            >
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Instructor
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Flights
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Hours *
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Lessons
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                    Students
                  </th>
                </tr>
              </thead>
              <tbody>
                {instructorUtilization.map((row) => (
                  <tr
                    key={row.instructorUserId}
                    className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/o/${slug}/people/${row.instructorUserId}`}
                        className="font-medium text-slate-900 dark:text-slate-100 hover:text-brand underline-offset-2 hover:underline"
                      >
                        {row.instructorName}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={['nums tabular-nums', row.flightCount === 0 ? 'text-slate-300' : 'text-slate-700 dark:text-slate-300'].join(' ')}>
                        {row.flightCount}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={['nums tabular-nums', row.flightHours === 0 ? 'text-slate-300' : 'text-slate-700 dark:text-slate-300'].join(' ')}>
                        {row.flightHours.toFixed(1)}h
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={['nums tabular-nums', row.lessonsGiven === 0 ? 'text-slate-300' : 'text-slate-700 dark:text-slate-300'].join(' ')}>
                        {row.lessonsGiven}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={['nums tabular-nums', row.distinctStudents === 0 ? 'text-slate-300' : 'text-slate-700 dark:text-slate-300'].join(' ')}>
                        {row.distinctStudents}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {instructorUtilization.length > 0 && !hasInstructorActivity && !isEmptyOrg && (
          <p className="mt-1.5 text-xs text-slate-400 dark:text-slate-500">
            No instructor activity in the selected period. Try a wider range.
          </p>
        )}
        <p className="mt-1.5 text-[0.6875rem] text-slate-400 dark:text-slate-500">
          * {HOURS_FOOTNOTE} {OPERATOR_COUNT_CAPTION}
        </p>
      </section>

      {/* ── H. Squawks (org-wide) ─────────────────────────────────────────── */}
      <section aria-label="Squawks — org-wide">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="inline-flex items-center gap-1.5 text-[0.625rem] uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500">
            <Wrench className="h-3 w-3" aria-hidden="true" />
            Squawks — {squawks.openCount} open · {squawks.deferredCount} deferred · {squawks.resolvedCount} resolved
          </p>
          <ExportCsvButton rows={squawksCsv} filename={csvFilename('squawks')} disabled={squawks.rows.length === 0} />
        </div>
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-x-auto">
          {squawks.rows.length === 0 ? (
            <EmptyState
              icon={Wrench}
              title="No squawks recorded."
              body="Reported discrepancies across the fleet appear here."
              className="py-10"
            />
          ) : (
            <table className="w-full text-sm" aria-label="Squawks org-wide">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Tail #</th>
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Squawk</th>
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Severity</th>
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Status</th>
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Reported</th>
                </tr>
              </thead>
              <tbody>
                {squawks.rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                    <td className="px-4 py-3 nums font-bold text-slate-900 dark:text-slate-100">{r.tailNumber}</td>
                    <td className="px-4 py-3 text-slate-700 dark:text-slate-300">{r.title}</td>
                    <td className="px-4 py-3">
                      <StatusBadge variant={severityVariant(r.severity)}>{r.severity}</StatusBadge>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge variant={squawkStatusVariant(r.status)}>{r.status}</StatusBadge>
                    </td>
                    <td className="px-4 py-3 nums text-slate-500 dark:text-slate-400 text-xs">
                      {new Date(r.reportedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className="mt-1.5 text-[0.6875rem] text-slate-400 dark:text-slate-500">{OPERATOR_COUNT_CAPTION}</p>
      </section>

      {/* ── I. Maintenance reminders (org-wide) ───────────────────────────── */}
      <section aria-label="Maintenance reminders — org-wide">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="inline-flex items-center gap-1.5 text-[0.625rem] uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500">
            <ClipboardList className="h-3 w-3" aria-hidden="true" />
            Maintenance reminders — {maintenanceReminders.overdueCount} overdue · {maintenanceReminders.dueSoonCount} due soon
          </p>
          <ExportCsvButton rows={remindersCsv} filename={csvFilename('maintenance-reminders')} disabled={maintenanceReminders.rows.length === 0} />
        </div>
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-x-auto">
          {maintenanceReminders.rows.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No maintenance items tracked."
              body="Operator-defined inspection and service reminders across the fleet appear here."
              className="py-10"
            />
          ) : (
            <table className="w-full text-sm" aria-label="Maintenance reminders org-wide">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Tail #</th>
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Item</th>
                  <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Status</th>
                  <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Due</th>
                  <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Remaining</th>
                </tr>
              </thead>
              <tbody>
                {maintenanceReminders.rows.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                    <td className="px-4 py-3 nums font-bold text-slate-900 dark:text-slate-100">{r.tailNumber}</td>
                    <td className="px-4 py-3 text-slate-700 dark:text-slate-300">{r.title}</td>
                    <td className="px-4 py-3">
                      <StatusBadge variant={dueStatusVariant(r.status)}>{r.status.replace('_', ' ')}</StatusBadge>
                    </td>
                    <td className="px-4 py-3 text-right nums text-slate-600 dark:text-slate-300 text-xs">
                      {r.dueDate ?? (r.dueValueHours != null ? `${r.dueValueHours.toFixed(1)}h` : <span className="text-slate-300">—</span>)}
                    </td>
                    <td className="px-4 py-3 text-right nums text-slate-600 dark:text-slate-300 text-xs">
                      {r.remainingHours != null
                        ? `${r.remainingHours.toFixed(1)}h`
                        : r.remainingDays != null
                          ? `${r.remainingDays}d`
                          : <span className="text-slate-300">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className="mt-1.5 text-[0.6875rem] text-slate-400 dark:text-slate-500">
          Arithmetic on operator-entered thresholds vs last-recorded meters — {OPERATOR_COUNT_CAPTION}
        </p>
      </section>

      {/* ── J. Cancellations ──────────────────────────────────────────────── */}
      <section aria-label={`Cancellations — last ${rangeLbl}`}>
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="inline-flex items-center gap-1.5 text-[0.625rem] uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500">
            <CalendarX2 className="h-3 w-3" aria-hidden="true" />
            Cancellations — last {rangeLbl}
          </p>
          <ExportCsvButton
            rows={cancellationsCsv}
            filename={csvFilename('cancellations')}
            disabled={cancellations.rows.length === 0}
          />
        </div>
        {/* Lead-time totals strip */}
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
          <div className="grid grid-cols-4 divide-x divide-slate-100 dark:divide-slate-800 border-b border-slate-100 dark:border-slate-800">
            <div className="px-5 py-3">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Total
              </p>
              <StatNum value={cancellations.totalCount} />
            </div>
            <div className="px-5 py-3">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                &lt;24h notice
              </p>
              <StatNum value={cancellations.lt24hCount} danger />
            </div>
            <div className="px-5 py-3">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                1–7d notice
              </p>
              <StatNum value={cancellations.d1_7Count} />
            </div>
            <div className="px-5 py-3">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                &gt;7d notice
              </p>
              <StatNum value={cancellations.gt7dCount} />
            </div>
          </div>
          <div className="overflow-x-auto">
            {cancellations.rows.length === 0 ? (
              <EmptyState
                icon={CalendarX2}
                title="No cancellations in the selected period."
                body="Cancelled reservations across the org appear here with who cancelled and why."
                className="py-10"
              />
            ) : (
              <table className="w-full text-sm" aria-label={`Cancellations last ${rangeLbl}`}>
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
                    <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Cancelled</th>
                    <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Resource</th>
                    <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Cancelled by</th>
                    <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Reason</th>
                    <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Lead time</th>
                  </tr>
                </thead>
                <tbody>
                  {cancellations.rows.map((r) => (
                    <tr key={r.reservationId} className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                      <td className="px-4 py-3 nums text-slate-500 dark:text-slate-400 text-xs whitespace-nowrap">
                        {new Date(r.cancelledAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                      </td>
                      <td className="px-4 py-3 nums font-medium text-slate-900 dark:text-slate-100">{r.resourceLabel}</td>
                      <td className="px-4 py-3 text-slate-700 dark:text-slate-300">{r.cancelledByName}</td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                        {r.reason ?? <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <StatusBadge variant={r.leadTimeBucket === 'lt24h' ? 'danger' : r.leadTimeBucket === 'd1_7' ? 'warning' : 'neutral'}>
                          {LEAD_TIME_LABELS[r.leadTimeBucket]}
                        </StatusBadge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <p className="mt-1.5 text-[0.6875rem] text-slate-400 dark:text-slate-500">
          Lead time = notice before the scheduled start (start − cancelled). {OPERATOR_COUNT_CAPTION}
        </p>
      </section>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface ReportsPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ range?: string }>;
}

export default async function ReportsPage({
  params,
  searchParams,
}: ReportsPageProps) {
  const { slug } = await params;
  const sp = await searchParams;
  const rawRange = sp.range;

  const session = await auth();

  // Validate + normalize the ?range= param. Accepts the 5 R1 keys → fallback 30d.
  const range = resolveReportRangeKey(rawRange);

  // UI-only capability check — gate is enforced server-side in the action.
  // NO redirect: shell is app:access; the reports section is reporting:access.
  const canViewReporting = session ? hasCapability(session, 'reporting:access') : false;

  // ── Module gate (Slice CLUB-MODE) — panel pattern, no redirect. Only checked
  // once role access is confirmed; fail-soft to enabled on read failure.
  let reportsModuleEnabled = true;
  if (canViewReporting) {
    try {
      const orgFeatures = await getOrgFeatures(session);
      reportsModuleEnabled = orgFeatures.features.reports;
    } catch {
      reportsModuleEnabled = true;
    }
  }
  const canViewReports = canViewReporting && reportsModuleEnabled;

  return (
    <div className="space-y-6">
      {/* ── A. Heading row — OUTSIDE Suspense (always instant) ─────────── */}
      <PageHeader
        title="Operational reports"
        subtitle="Aggregated activity for the selected period."
        actions={canViewReports && <RangeSelector slug={slug} current={range} />}
      />

      {/* ── B–F: ONE Suspense boundary ───────────────────────────────────── */}
      {!canViewReporting ? (
        <PermissionDeniedPanel />
      ) : !reportsModuleEnabled ? (
        <ModuleDisabledPanel />
      ) : (
        <Suspense fallback={<ReportsSkeleton />}>
          <ReportsContent slug={slug} range={range} />
        </Suspense>
      )}
    </div>
  );
}
