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
 * [VERIFY-A]   Hours = Hobbs-derived operational utilization; NOT billing/airworthiness.
 * [VERIFY-T1-B] Training counts = operator state; NOT Part-141 or FAA determination.
 * [VERIFY-M1-A] Maintenance counts = operator data; NOT Part-43/airworthiness/RTS.
 * [VERIFY-R1-TZ] UTC bucketing throughout.
 */

import * as React from 'react';
import { Suspense } from 'react';
import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { hasCapability } from '@aeroops/api';
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

// ─── Hours footnote (verbatim per spec) ──────────────────────────────────────

const HOURS_FOOTNOTE =
  'Utilization hours derived from recorded Hobbs at check-in. Operational figure only — not a billing or airworthiness statement.';

const OPERATOR_COUNT_CAPTION =
  'Operator counts — not a Part-141, airworthiness, or regulatory determination.';

// ─── Permission-denied panel (reuses dashboard design) ───────────────────────

function PermissionDeniedPanel() {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-6 py-10 text-center space-y-2">
      <p className="text-sm font-medium text-slate-700">
        Reporting isn&apos;t available for your role.
      </p>
      <p className="text-sm text-slate-500">
        Contact your administrator if you need access.
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
    <nav aria-label="Report range" className="flex items-center rounded-md border border-slate-200 overflow-hidden">
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
                : 'text-slate-600 hover:bg-slate-50',
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
        <div className="rounded-md border border-slate-200 bg-white shadow-xs p-4 space-y-4">
          {/* Stat strip */}
          <div className="grid grid-cols-3 gap-4 pb-4 border-b border-slate-100">
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
        <div className="rounded-md border border-slate-200 bg-white shadow-xs overflow-hidden">
          <div className="h-10 bg-slate-50 border-b border-slate-200" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 border-b border-slate-100 flex items-center px-4 gap-8">
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
        <div className="rounded-md border border-slate-200 bg-white shadow-xs p-4 space-y-3">
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
            <div className="rounded-md border border-slate-200 bg-white shadow-xs p-4 space-y-3">
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
          : 'text-slate-900',
      ].join(' ')}
    >
      {value}
      {suffix && (
        <span className="text-base font-normal text-slate-400 ml-0.5">{suffix}</span>
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
    <div className="flex items-center justify-between gap-2 py-1.5 border-b border-slate-100 last:border-0">
      <span className="text-sm text-slate-600">{label}</span>
      <div className="flex items-center gap-2 shrink-0">
        {note && (
          <span className="text-xs text-slate-400">{note}</span>
        )}
        <span
          className={[
            'nums text-sm font-bold tabular-nums',
            danger && !isZero
              ? 'text-danger'
              : isZero
              ? 'text-slate-300'
              : 'text-slate-900',
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
  const { utilizationTrend, hoursByTail, reservationsVsFlights, trainingThroughput, maintenanceTrend } = data;

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

  return (
    <div className="space-y-8">

      {/* ── B. Fleet utilization over time ───────────────────────────────── */}
      <section aria-label={`Fleet utilization over time — last ${rangeLbl}`}>
        <p className="mb-2 text-[0.625rem] uppercase tracking-[0.1em] text-slate-400">
          Fleet utilization over time — last {rangeLbl}
        </p>
        <div className="rounded-md border border-slate-200 bg-white shadow-xs">
          {/* Stat strip */}
          <div className="grid grid-cols-3 divide-x divide-slate-100 border-b border-slate-100">
            <div className="px-5 py-4">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500">
                Total flights
              </p>
              <StatNum value={utilizationTrend.totalFlights} />
              <p className="mt-1 text-xs text-slate-400">
                {utilizationTrend.totalFlights === 0 ? 'none in period' : 'completed dispatches'}
              </p>
            </div>
            <div className="px-5 py-4">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500">
                Total hours *
              </p>
              <p
                className={[
                  'nums mt-1 text-2xl font-bold leading-none',
                  utilizationTrend.totalFlightHours === 0 ? 'text-slate-300' : 'text-slate-900',
                ].join(' ')}
              >
                {utilizationTrend.totalFlightHours.toFixed(1)}
              </p>
              <p className="mt-1 text-xs text-slate-400">utilization hrs</p>
            </div>
            <div className="px-5 py-4">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500">
                Avg hrs / flight *
              </p>
              <p
                className={[
                  'nums mt-1 text-2xl font-bold leading-none',
                  utilizationTrend.avgHoursPerFlight === 0 ? 'text-slate-300' : 'text-slate-900',
                ].join(' ')}
              >
                {utilizationTrend.avgHoursPerFlight.toFixed(1)}
              </p>
              <p className="mt-1 text-xs text-slate-400">
                {utilizationTrend.totalFlights === 0 ? '—' : 'per closed dispatch'}
              </p>
            </div>
          </div>

          {/* Bucket bar-rows */}
          <div className="p-4">
            {utilizationTrend.buckets.length === 0 ? (
              <p className="text-center text-sm text-slate-400 py-4">
                No bucket data available.
              </p>
            ) : (
              <div className="space-y-2">
                {utilizationTrend.buckets.map((bucket, i) => {
                  const barWidth = clampReportBarWidth(bucket.flightHours, maxBucketHours);
                  const label = formatBucketLabel(bucket.bucketStart, gran);
                  return (
                    <div key={i} className="flex items-center gap-3 text-xs">
                      <span className="nums text-slate-500 w-14 shrink-0 tabular-nums">
                        {label}
                      </span>
                      <span
                        className={[
                          'nums w-8 shrink-0 text-right tabular-nums',
                          bucket.flightCount === 0 ? 'text-slate-300' : 'text-slate-700',
                        ].join(' ')}
                        aria-label={`${bucket.flightCount} flights`}
                      >
                        {bucket.flightCount}
                      </span>
                      <span
                        className={[
                          'nums w-12 shrink-0 text-right tabular-nums',
                          bucket.flightHours === 0 ? 'text-slate-300' : 'text-slate-700',
                        ].join(' ')}
                        aria-label={`${bucket.flightHours.toFixed(1)} hours`}
                      >
                        {bucket.flightHours.toFixed(1)}h
                      </span>
                      <div
                        className="flex-1 h-1.5 rounded-full bg-slate-100"
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
              <p className="mt-3 text-xs text-slate-400">
                No flights in the selected period. Try a wider range.
              </p>
            )}

            {/* Empty-org nudge */}
            {isEmptyOrg && (
              <p className="mt-3 text-xs text-slate-400">
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
        <p className="mt-1.5 text-[0.6875rem] text-slate-400">
          * {HOURS_FOOTNOTE}
        </p>
      </section>

      {/* ── C. Hours by tail ──────────────────────────────────────────────── */}
      <section aria-label={`Hours by tail — last ${rangeLbl}`}>
        <p className="mb-2 text-[0.625rem] uppercase tracking-[0.1em] text-slate-400">
          Hours by tail — last {rangeLbl}
        </p>
        <div className="rounded-md border border-slate-200 bg-white shadow-xs overflow-hidden">
          <table
            className="w-full text-sm"
            aria-label={`Hours by tail last ${rangeLbl}`}
          >
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th
                  scope="col"
                  className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500"
                >
                  Tail #
                </th>
                <th
                  scope="col"
                  className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500"
                >
                  Flights
                </th>
                <th
                  scope="col"
                  className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500"
                >
                  Hours *
                </th>
                <th
                  scope="col"
                  className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 w-28"
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
                    className="px-4 py-10 text-center text-sm text-slate-400"
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
                      className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/o/${slug}/fleet/${row.resourceId}`}
                          className="nums font-bold text-slate-900 hover:text-brand underline-offset-2 hover:underline"
                          aria-label={`View details for ${row.tailNumber}`}
                        >
                          {row.tailNumber}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span
                          className={[
                            'nums tabular-nums',
                            row.flightCount === 0 ? 'text-slate-300' : 'text-slate-700',
                          ].join(' ')}
                        >
                          {row.flightCount}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span
                          className={[
                            'nums tabular-nums',
                            row.flightHours === 0 ? 'text-slate-300' : 'text-slate-700',
                          ].join(' ')}
                        >
                          {row.flightHours.toFixed(1)}h
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div
                          className="w-24 h-1.5 rounded-full bg-slate-100"
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
        <p className="mt-1.5 text-[0.6875rem] text-slate-400">
          * {HOURS_FOOTNOTE}
        </p>
      </section>

      {/* ── D. Reservations & flights trend ──────────────────────────────── */}
      <section aria-label={`Reservations and flights trend — last ${rangeLbl}`}>
        <p className="mb-2 text-[0.625rem] uppercase tracking-[0.1em] text-slate-400">
          Reservations &amp; flights trend — last {rangeLbl}
        </p>
        <div className="rounded-md border border-slate-200 bg-white shadow-xs">
          {/* Totals strip */}
          <div className="grid grid-cols-2 divide-x divide-slate-100 border-b border-slate-100">
            <div className="px-5 py-3">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500">
                Reservations created
              </p>
              <StatNum value={reservationsVsFlights.totalReservationsCreated} />
              <p className="mt-0.5 text-[0.6875rem] text-slate-400">
                all statuses incl. cancelled
              </p>
            </div>
            <div className="px-5 py-3">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500">
                Flights completed
              </p>
              <StatNum value={reservationsVsFlights.totalFlightsClosed} />
              <p className="mt-0.5 text-[0.6875rem] text-slate-400">closed dispatches</p>
            </div>
          </div>

          {/* Bucket rows — two series */}
          <div className="p-4">
            {/* Legend */}
            <div className="flex items-center gap-4 mb-3">
              <div className="flex items-center gap-1.5">
                <div className="h-1.5 w-4 rounded-full bg-brand" aria-hidden="true" />
                <span className="text-xs text-slate-500">Reservations</span>
              </div>
              <div className="flex items-center gap-1.5">
                <div className="h-1.5 w-4 rounded-full bg-slate-400" aria-hidden="true" />
                <span className="text-xs text-slate-500">Flights closed</span>
              </div>
            </div>

            {reservationsVsFlights.buckets.length === 0 ? (
              <p className="text-center text-sm text-slate-400 py-4">
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
                      <span className="nums text-slate-500 w-14 shrink-0 tabular-nums pt-0.5">
                        {label}
                      </span>
                      <div className="w-10 shrink-0 text-right space-y-1">
                        <span
                          className={[
                            'nums block tabular-nums',
                            bucket.reservationsCreated === 0 ? 'text-slate-300' : 'text-slate-700',
                          ].join(' ')}
                        >
                          {bucket.reservationsCreated}
                        </span>
                        <span
                          className={[
                            'nums block tabular-nums',
                            bucket.flightsClosed === 0 ? 'text-slate-300' : 'text-slate-500',
                          ].join(' ')}
                        >
                          {bucket.flightsClosed}
                        </span>
                      </div>
                      <div className="flex-1 space-y-1" aria-hidden="true">
                        <div className="h-1.5 rounded-full bg-slate-100">
                          <div
                            className="h-1.5 rounded-full bg-brand"
                            style={{ width: `${resvBar}%` }}
                          />
                        </div>
                        <div className="h-1.5 rounded-full bg-slate-100">
                          <div
                            className="h-1.5 rounded-full bg-slate-400"
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
              <p className="mt-3 text-xs text-slate-400">
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
          <p className="mb-2 text-[0.625rem] uppercase tracking-[0.1em] text-slate-400">
            Training throughput — last {rangeLbl}
          </p>
          <div className="rounded-md border border-slate-200 bg-white shadow-xs px-4 py-3">
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
            <p className="mt-1.5 text-xs text-slate-400">
              No training activity in period. Try a wider range.
            </p>
          )}
          <p className="mt-1.5 text-[0.6875rem] text-slate-400">
            {OPERATOR_COUNT_CAPTION}
          </p>
        </section>

        {/* F. Maintenance trend */}
        <section aria-label={`Maintenance trend — last ${rangeLbl}`}>
          <p className="mb-2 text-[0.625rem] uppercase tracking-[0.1em] text-slate-400">
            Maintenance trend — last {rangeLbl}
          </p>
          <div className="rounded-md border border-slate-200 bg-white shadow-xs px-4 py-3">
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
            <p className="mt-1.5 text-xs text-slate-400">
              No maintenance activity in period. Try a wider range.
            </p>
          )}
          <p className="mt-1.5 text-[0.6875rem] text-slate-400">
            {OPERATOR_COUNT_CAPTION}
          </p>
        </section>
      </div>
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

  return (
    <div className="space-y-6">
      {/* ── A. Heading row — OUTSIDE Suspense (always instant) ─────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tightish text-slate-900">
            Operational reports
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Aggregated activity for the selected period.
          </p>
        </div>
        {canViewReporting && (
          <RangeSelector slug={slug} current={range} />
        )}
      </div>

      {/* ── B–F: ONE Suspense boundary ───────────────────────────────────── */}
      {canViewReporting ? (
        <Suspense fallback={<ReportsSkeleton />}>
          <ReportsContent slug={slug} range={range} />
        </Suspense>
      ) : (
        <PermissionDeniedPanel />
      )}
    </div>
  );
}
