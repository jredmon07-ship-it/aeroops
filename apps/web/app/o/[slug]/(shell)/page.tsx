/**
 * app/o/[slug]/(shell)/page.tsx — Ops Dashboard (Slice 7.2).
 *
 * REPLACES the Phase-0 placeholder. Route stays at /o/[slug]; nav unchanged.
 *
 * Layout (top → bottom inside existing shell max-w-screen-xl):
 *   A. Heading row — org name + "Operations overview" subline; range selector
 *      (server-driven ?range= links: 7d/30d/90d, default 30d). OUTSIDE Suspense.
 *   B. Snapshot strip — "As of now"; one white panel / hairline divide-x;
 *      4 tiles (grounded, squawks, active aircraft, active members).
 *   C. KPI row — "Last N days"; grid-cols-3 range cards (flights, hours, reservations).
 *   D. Utilization table — "Fleet utilization — last N days"; Tail#/Flights/Hours/bar/Status.
 *   E. At-a-glance cards — today's flights / grounded / open squawks.
 *
 * States:
 *   Loading           — DashboardSkeleton (Suspense boundary, aria-busy)
 *   Populated         — full layout as above
 *   Empty brand-new   — 0s + "Getting started" nudge strip (activeAircraft=0 AND activeMember=0)
 *   Range-no-data     — snapshots live; range metrics faded-0
 *   Error             — destructive Alert + Retry (B–E replaced; A stays)
 *   Permission-denied — heading A + tasteful "not available" panel; NO redirect
 *
 * AUTHZ: Dashboard is app:access (nav-level). The METRICS SECTION is independently
 *   gated by hasCapability(session, 'reporting:access') — no redirect on denied,
 *   because the dashboard shell itself is accessible.
 *
 * BOUNDARY: imports ONLY from '@aeroops/api'. Never '@aeroops/db'.
 * [VERIFY-7-TZ]: "today's flights" uses UTC-day fallback; labelled accordingly.
 * [VERIFY-A]: Hours shown are OPERATIONAL utilization (Hobbs-derived). NOT billable.
 */

import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { hasCapability, getDashboardSummary, getOnboardingStatus, getOrgFeatures } from '@aeroops/api';
import { ALL_MODULES_ENABLED } from '@aeroops/core';
import type { OrgFeatureFlags } from '@aeroops/core';
import { landingPathFor, NAV_ITEMS } from '@/lib/nav';
import { SetupBanner } from './setup-banner';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { BarTrend, Sparkline } from '@/components/ui/chart';
import {
  resolveRangeKey,
  rangeLabelFull,
  formatUtcTime,
  clampBarWidth,
} from '@/lib/dashboard-utils';
import {
  getDashboardMetricsAction,
  getAircraftUtilizationAction,
  getReservationsTrendAction,
  getTodaysFlightsAction,
  getGroundedAircraftAction,
  getOpenSquawksAction,
} from './reporting-actions';
import { getMaintenanceDueSummaryAction } from './maintenance/due-actions';

// ─── Local alias ─────────────────────────────────────────────────────────────

// rangeLabelFull is imported from @/lib/dashboard-utils — aliased for brevity.
const rangeLabel = rangeLabelFull;

/**
 * Short UTC axis label for a trend bucket, e.g. "7/3". [VERIFY-7-TZ]: bucket
 * starts are UTC-aligned server-side; we render them UTC-consistently.
 */
function fmtBucketLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

// ─── Severity chip (squawk severity) ─────────────────────────────────────────

const SEVERITY_VARIANT: Record<string, 'danger' | 'warning' | 'neutral'> = {
  grounding: 'danger',
  major: 'warning',
  minor: 'neutral',
};

function SeverityChip({ severity }: { severity: string }) {
  return (
    <StatusBadge variant={SEVERITY_VARIANT[severity] ?? 'neutral'}>
      {severity}
    </StatusBadge>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function DashboardSkeleton() {
  return (
    <div
      className="space-y-6 animate-pulse"
      aria-busy="true"
      aria-label="Loading dashboard"
    >
      {/* B: snapshot strip skeleton */}
      <div>
        <Skeleton className="h-3 w-16 mb-2" />
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs divide-x divide-slate-200 dark:divide-slate-800 flex">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="flex-1 px-4 py-4 space-y-2">
              <Skeleton className="h-2.5 w-14" />
              <Skeleton className="h-7 w-10" />
              <Skeleton className="h-2.5 w-20" />
            </div>
          ))}
        </div>
      </div>

      {/* C: KPI row skeleton */}
      <div>
        <Skeleton className="h-3 w-24 mb-2" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs p-4 space-y-2">
              <Skeleton className="h-2.5 w-20" />
              <Skeleton className="h-9 w-16" />
              <Skeleton className="h-2.5 w-24" />
            </div>
          ))}
        </div>
      </div>

      {/* C2: activity chart skeleton */}
      <div>
        <Skeleton className="h-3 w-28 mb-2" />
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs p-5">
          <div className="flex h-44 items-end gap-1.5">
            {[40, 65, 80, 55, 90, 70, 100, 60, 75, 50].map((h, i) => (
              <div key={i} className="flex-1">
                <Skeleton className="w-full rounded-t-sm" style={{ height: `${h}%` }} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* D: utilization table skeleton */}
      <div>
        <Skeleton className="h-3 w-48 mb-2" />
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden">
          <div className="h-10 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800" />
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-12 border-b border-slate-100 dark:border-slate-800 flex items-center px-4 gap-8">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-8" />
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-1.5 w-24 rounded-full" />
            </div>
          ))}
        </div>
      </div>

      {/* E: at-a-glance skeleton */}
      <div>
        <Skeleton className="h-3 w-20 mb-2" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden">
              <div className="hairline px-4 py-2.5">
                <Skeleton className="h-3 w-28" />
              </div>
              <div className="p-3 space-y-2">
                {[0, 1, 2].map((j) => (
                  <Skeleton key={j} className="h-3 w-full" />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Permission-denied panel ──────────────────────────────────────────────────

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

// ─── Dashboard content (B+C+D+E) ─────────────────────────────────────────────

interface DashboardContentProps {
  slug: string;
  range: '7d' | '30d' | '90d';
  enabledModules: OrgFeatureFlags;
}

async function DashboardContent({ slug, range, enabledModules }: DashboardContentProps) {
  // Parallel-fetch all dashboard data.
  const [metricsResult, utilizationResult, trendResult, todaysFlightsResult, groundedResult, squawksResult, maintenanceDueSummaryResult] =
    await Promise.all([
      getDashboardMetricsAction({ range }),
      getAircraftUtilizationAction({ range }),
      getReservationsTrendAction({ range }),
      getTodaysFlightsAction(),
      getGroundedAircraftAction(),
      getOpenSquawksAction(),
      getMaintenanceDueSummaryAction(),
    ]);

  // Error state: any core metric failure renders an error block.
  if ('error' in metricsResult || 'error' in utilizationResult) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load dashboard data. Please try again.</span>
          <Link
            href={`/o/${slug}?range=${range}`}
            className="text-sm underline underline-offset-2 hover:no-underline"
          >
            Retry
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  const metrics = metricsResult.ok ? metricsResult.metrics : null;
  const utilizationRows = utilizationResult.ok ? utilizationResult.rows : [];
  const todaysFlights =
    todaysFlightsResult && 'ok' in todaysFlightsResult && todaysFlightsResult.ok
      ? todaysFlightsResult.reservations
      : [];
  const groundedAircraft =
    groundedResult && 'ok' in groundedResult && groundedResult.ok
      ? groundedResult.aircraft
      : [];
  const openSquawks =
    squawksResult && 'ok' in squawksResult && squawksResult.ok
      ? squawksResult.squawks
      : [];
  // Best-effort: the activity chart is non-critical — a trend failure just
  // hides the chart rather than erroring the whole dashboard.
  const trend =
    trendResult && 'ok' in trendResult && trendResult.ok ? trendResult.trend : null;
  // Best-effort fail-closed (Slice P1.5): a reporting:access-only role
  // lacking maintenance:access (e.g. accountant) sees the tile as "—" rather
  // than an error — mirrors the existing at-a-glance-lists posture (R7 tracked nit).
  const maintenanceDueSummary =
    maintenanceDueSummaryResult && 'ok' in maintenanceDueSummaryResult && maintenanceDueSummaryResult.ok
      ? maintenanceDueSummaryResult.summary
      : null;

  if (!metrics) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load dashboard metrics. Please try again.</span>
          <Link
            href={`/o/${slug}?range=${range}`}
            className="text-sm underline underline-offset-2 hover:no-underline"
          >
            Retry
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  const rangeLbl = rangeLabel(range);
  const isEmptyOrg = metrics.activeAircraftCount === 0 && metrics.activeMemberCount === 0;
  const maxHours =
    utilizationRows.length > 0 ? Math.max(...utilizationRows.map((r) => r.flightHours)) : 0;

  // Build lookup maps for utilization-table status column (avoids N+1).
  const groundedIdSet = new Set(groundedAircraft.map((a) => a.id));
  // squawk count per resourceId from open squawks list (≤10 limit, best-effort)
  const squawkCountByResource = new Map<string, number>();
  for (const s of openSquawks) {
    squawkCountByResource.set(s.resourceId, (squawkCountByResource.get(s.resourceId) ?? 0) + 1);
  }
  // resourceId → tail # (utilization covers the whole active fleet) so the
  // today's-flights at-a-glance shows tail numbers, not raw resource ids.
  const tailByResource = new Map<string, string>();
  for (const row of utilizationRows) tailByResource.set(row.resourceId, row.tailNumber);
  for (const a of groundedAircraft) tailByResource.set(a.id, a.tailNumber);
  const tailForReservation = (resourceIds: string[]): string =>
    resourceIds.map((id) => tailByResource.get(id)).find(Boolean) ?? '—';

  return (
    <div className="space-y-6">
      {/* ── B. Snapshot strip ─────────────────────────────────────────────── */}
      <section aria-label="Operational snapshot">
        <p className="mb-1.5 text-[0.625rem] uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500">
          As of now
        </p>
        {/* One white panel, hairline divide-x: instrument cluster */}
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
          <div className="flex divide-x divide-slate-200 dark:divide-slate-800 max-sm:grid max-sm:grid-cols-2 max-sm:divide-x-0">
            {/* Tile 1: Grounded */}
            <div className="flex-1 px-5 py-4">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Grounded
              </p>
              <p
                className={[
                  'nums mt-1 text-2xl font-bold leading-none',
                  metrics.groundedAircraftCount > 0 ? 'text-danger' : 'text-slate-400 dark:text-slate-500',
                ].join(' ')}
              >
                {metrics.groundedAircraftCount}
              </p>
              <p
                className={[
                  'mt-1 text-xs',
                  metrics.groundedAircraftCount > 0
                    ? 'text-danger/70'
                    : 'text-slate-400 dark:text-slate-500',
                ].join(' ')}
              >
                {metrics.groundedAircraftCount > 0
                  ? 'aircraft — see fleet'
                  : 'none operator-grounded'}
              </p>
            </div>

            {/* Tile 2: Open squawks */}
            <div className="flex-1 px-5 py-4">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Open squawks
              </p>
              <p
                className={[
                  'nums mt-1 text-2xl font-bold leading-none',
                  metrics.openSquawkCount > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-slate-400 dark:text-slate-500',
                ].join(' ')}
              >
                {metrics.openSquawkCount}
              </p>
              <p
                className={[
                  'mt-1 text-xs',
                  metrics.openSquawkCount > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400 dark:text-slate-500',
                ].join(' ')}
              >
                {metrics.openSquawkCount > 0 ? 'open' : 'all clear'}
              </p>
            </div>

            {/* Tile 3: Active aircraft */}
            <div className="flex-1 px-5 py-4">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Active aircraft
              </p>
              <p
                className={[
                  'nums mt-1 text-2xl font-bold leading-none',
                  metrics.activeAircraftCount === 0 ? 'text-slate-400 dark:text-slate-500' : 'text-slate-900 dark:text-slate-100',
                ].join(' ')}
              >
                {metrics.activeAircraftCount}
              </p>
              <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                {metrics.activeAircraftCount === 0 ? 'none yet' : 'in fleet'}
              </p>
            </div>

            {/* Tile 4: Active members */}
            <div className="flex-1 px-5 py-4">
              <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Active members
              </p>
              <p
                className={[
                  'nums mt-1 text-2xl font-bold leading-none',
                  metrics.activeMemberCount === 0 ? 'text-slate-400 dark:text-slate-500' : 'text-slate-900 dark:text-slate-100',
                ].join(' ')}
              >
                {metrics.activeMemberCount}
              </p>
              <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                {metrics.activeMemberCount === 0 ? 'none yet' : 'on roster'}
              </p>
            </div>

            {/* Tile 5: Open work orders (maintenance module) */}
            {enabledModules.maintenance && (
              <div className="flex-1 px-5 py-4">
                <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Open work orders
                </p>
                <p
                  className={[
                    'nums mt-1 text-2xl font-bold leading-none',
                    metrics.openWorkOrderCount > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-slate-400 dark:text-slate-500',
                  ].join(' ')}
                >
                  {metrics.openWorkOrderCount}
                </p>
                <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                  <Link
                    href={`/o/${slug}/maintenance/work-orders`}
                    className="hover:text-brand underline-offset-2 hover:underline"
                  >
                    {metrics.openWorkOrderCount > 0 ? 'open or in progress' : 'none open'}
                  </Link>
                </p>
              </div>
            )}

            {/* Tile 6: Active enrollments (training module) */}
            {enabledModules.training && (
              <div className="flex-1 px-5 py-4">
                <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Active enrollments
                </p>
                <p
                  className={[
                    'nums mt-1 text-2xl font-bold leading-none',
                    metrics.activeEnrollmentCount === 0 ? 'text-slate-400 dark:text-slate-500' : 'text-slate-900 dark:text-slate-100',
                  ].join(' ')}
                >
                  {metrics.activeEnrollmentCount}
                </p>
                <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                  <Link
                    href={`/o/${slug}/training/enrollments`}
                    className="hover:text-brand underline-offset-2 hover:underline"
                  >
                    {metrics.activeEnrollmentCount === 0 ? 'none yet' : 'students in training'}
                  </Link>
                </p>
              </div>
            )}

            {/* Tile 7: Maintenance due (Slice P1.5) [VERIFY-P1.5-A] — maintenance module */}
            {enabledModules.maintenance && (
              <div className="flex-1 px-5 py-4">
                <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Maintenance due
                </p>
                {maintenanceDueSummary === null ? (
                  <>
                    <p className="nums mt-1 text-2xl font-bold leading-none text-slate-300">—</p>
                    <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">not available</p>
                  </>
                ) : (
                  <>
                    <p
                      className={[
                        'nums mt-1 text-2xl font-bold leading-none',
                        maintenanceDueSummary.overdueCount > 0
                          ? 'text-danger'
                          : maintenanceDueSummary.dueSoonCount > 0
                            ? 'text-amber-700 dark:text-amber-300'
                            : 'text-slate-400 dark:text-slate-500',
                      ].join(' ')}
                    >
                      {maintenanceDueSummary.overdueCount + maintenanceDueSummary.dueSoonCount}
                    </p>
                    <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
                      <Link
                        href={`/o/${slug}/maintenance/due`}
                        className="hover:text-brand underline-offset-2 hover:underline"
                      >
                        {maintenanceDueSummary.overdueCount > 0
                          ? `${maintenanceDueSummary.overdueCount} overdue`
                          : maintenanceDueSummary.dueSoonCount > 0
                            ? `${maintenanceDueSummary.dueSoonCount} due soon`
                            : 'none due'}
                      </Link>
                    </p>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── C. KPI row (range-scoped) ─────────────────────────────────────── */}
      <section aria-label={`Throughput — last ${rangeLbl}`}>
        <p className="mb-1.5 text-[0.625rem] uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500">
          Last {rangeLbl}
        </p>
        {/* Structurally DIFFERENT from B: separate gap-3 grid */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* Flights */}
          <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs px-5 py-4">
            <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Flights
            </p>
            <p
              className={[
                'nums mt-1 text-3xl font-bold leading-none',
                metrics.totalFlights === 0 ? 'text-slate-300' : 'text-slate-900 dark:text-slate-100',
              ].join(' ')}
            >
              {metrics.totalFlights}
            </p>
            <p className="mt-1.5 text-xs text-slate-400 dark:text-slate-500" aria-hidden="true">
              {metrics.totalFlights === 0 ? 'no flights in period' : 'completed dispatches'}
            </p>
            {/* Per-day flights sparkline (from the activity trend) */}
            <div className="mt-2 h-4">
              {trend && trend.totalFlightsClosed > 0 && (
                <Sparkline
                  values={trend.buckets.map((b) => b.flightsClosed)}
                  color="hsl(var(--color-success))"
                  height={16}
                />
              )}
            </div>
          </div>

          {/* Flight hours */}
          <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs px-5 py-4">
            <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Flight hours *
            </p>
            <p
              className={[
                'nums mt-1 text-3xl font-bold leading-none',
                metrics.totalFlightHours === 0 ? 'text-slate-300' : 'text-slate-900 dark:text-slate-100',
              ].join(' ')}
            >
              {metrics.totalFlightHours.toFixed(1)}
            </p>
            <p className="mt-1.5 text-xs text-slate-400 dark:text-slate-500">
              {metrics.totalFlightHours === 0 ? 'no … in period' : 'utilization hrs'}
            </p>
            <div className="h-4" aria-hidden="true" />
          </div>

          {/* Reservations */}
          <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs px-5 py-4">
            <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Reservations
            </p>
            <p
              className={[
                'nums mt-1 text-3xl font-bold leading-none',
                metrics.reservationsInRange === 0 ? 'text-slate-300' : 'text-slate-900 dark:text-slate-100',
              ].join(' ')}
            >
              {metrics.reservationsInRange}
            </p>
            <p className="mt-1.5 text-xs text-slate-400 dark:text-slate-500">
              {metrics.reservationsInRange === 0 ? 'no … in period' : 'incl. upcoming'}
            </p>
            {/* Per-day reservations sparkline (from the activity trend) */}
            <div className="mt-2 h-4">
              {trend && trend.totalReservationsCreated > 0 && (
                <Sparkline
                  values={trend.buckets.map((b) => b.reservationsCreated)}
                  color="hsl(var(--color-brand))"
                  height={16}
                />
              )}
            </div>
          </div>
        </div>
        {/* Range-no-data subline */}
        {metrics.activeAircraftCount > 0 && metrics.totalFlights === 0 && (
          <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
            No completed flights in the selected period. Try a wider range.
          </p>
        )}
      </section>

      {/* ── C2. Activity trend chart ──────────────────────────────────────── */}
      {trend && (
        <section aria-label={`Activity — last ${rangeLbl}`}>
          <p className="mb-1.5 text-[0.625rem] uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500">
            Activity — last {rangeLbl}
          </p>
          <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs p-5">
            <BarTrend
              categories={trend.buckets.map((b) => fmtBucketLabel(b.bucketStart))}
              series={[
                {
                  label: 'Reservations',
                  color: 'hsl(var(--color-brand))',
                  values: trend.buckets.map((b) => b.reservationsCreated),
                },
                {
                  label: 'Flights flown',
                  color: 'hsl(var(--color-success))',
                  values: trend.buckets.map((b) => b.flightsClosed),
                },
              ]}
              ariaLabel={`Reservations booked versus flights flown per ${trend.granularity}, last ${rangeLbl}: ${trend.totalReservationsCreated} reservations, ${trend.totalFlightsClosed} flights.`}
              emptyLabel="No reservations or flights in this period yet."
            />
          </div>
        </section>
      )}

      {/* ── D. Utilization table ──────────────────────────────────────────── */}
      <section aria-label={`Fleet utilization — last ${rangeLbl}`}>
        <p className="mb-1.5 text-[0.625rem] uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500">
          Fleet utilization — last {rangeLbl}
        </p>
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden">
          <table
            className="w-full text-sm"
            aria-label={`Fleet utilization last ${rangeLbl}`}
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
                <th
                  scope="col"
                  className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400 hidden sm:table-cell"
                >
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {utilizationRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
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
                utilizationRows.map((row) => {
                  const barWidth = clampBarWidth(row.flightHours, maxHours);
                  return (
                    <tr
                      key={row.resourceId}
                      className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                    >
                      {/* Tail # */}
                      <td className="px-4 py-3">
                        <Link
                          href={`/o/${slug}/fleet/${row.resourceId}`}
                          className="nums font-bold text-slate-900 dark:text-slate-100 hover:text-brand underline-offset-2 hover:underline"
                          aria-label={`View details for ${row.tailNumber}`}
                        >
                          {row.tailNumber}
                        </Link>
                      </td>
                      {/* Flights */}
                      <td className="px-4 py-3 text-right">
                        <span className="nums text-slate-700 dark:text-slate-300">{row.flightCount}</span>
                      </td>
                      {/* Hours */}
                      <td className="px-4 py-3 text-right">
                        <span className="nums text-slate-700 dark:text-slate-300">
                          {row.flightHours.toFixed(1)}h
                        </span>
                      </td>
                      {/* Proportion bar — decorative only */}
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
                      {/* Status — hidden on mobile */}
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <div className="flex flex-wrap gap-1.5 items-center">
                          {groundedIdSet.has(row.resourceId) && (
                            <StatusBadge variant="danger" aria-label="Grounded">
                              Grounded
                            </StatusBadge>
                          )}
                          {(squawkCountByResource.get(row.resourceId) ?? 0) > 0 && (
                            <Link
                              href={`/o/${slug}/maintenance/squawks?resourceId=${row.resourceId}`}
                              className="inline-flex items-center gap-1 rounded-sm border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-amber-800 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-950/50 transition-colors"
                              aria-label={`${squawkCountByResource.get(row.resourceId)} open squawk${(squawkCountByResource.get(row.resourceId) ?? 0) !== 1 ? 's' : ''} for ${row.tailNumber}`}
                            >
                              {squawkCountByResource.get(row.resourceId)} open squawk{(squawkCountByResource.get(row.resourceId) ?? 0) !== 1 ? 's' : ''}
                            </Link>
                          )}
                          {!groundedIdSet.has(row.resourceId) &&
                            (squawkCountByResource.get(row.resourceId) ?? 0) === 0 && (
                              <span className="text-xs text-slate-400 dark:text-slate-500">—</span>
                            )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {/* Mandatory hours footnote [VERIFY-A] */}
        <p className="mt-1.5 text-[0.6875rem] text-slate-400 dark:text-slate-500">
          * Utilization hours derived from recorded Hobbs at check-in. Operational
          figure only — not an airworthiness statement.
        </p>
      </section>

      {/* ── Getting-started nudge (empty brand-new org) ────────────────────── */}
      {isEmptyOrg && (
        <div
          className="rounded-md border border-brand/20 bg-brand/5 px-5 py-4"
          role="note"
        >
          <p className="text-sm font-semibold text-brand-ink">Getting started</p>
          <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-300">
            Add aircraft in{' '}
            <Link
              href={`/o/${slug}/schedule/resources`}
              className="text-brand underline underline-offset-2 hover:text-brand-ink"
            >
              Resources
            </Link>
            , then add members in{' '}
            <Link
              href={`/o/${slug}/people`}
              className="text-brand underline underline-offset-2 hover:text-brand-ink"
            >
              People
            </Link>{' '}
            to start dispatching.
          </p>
        </div>
      )}

      {/* ── E. At-a-glance ───────────────────────────────────────────────── */}
      <section aria-label="Today's operations">
        <p className="mb-1.5 text-[0.625rem] uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500">
          On the board
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* Card 1: Today's flights */}
          <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden">
            <div className="hairline flex items-center justify-between px-4 py-2.5">
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Today&apos;s flights
                <span className="ml-1 text-[0.625rem] font-normal text-slate-400 dark:text-slate-500 uppercase tracking-wide">
                  UTC
                </span>
              </span>
              <Link
                href={`/o/${slug}/schedule/board`}
                className="text-xs text-brand hover:text-brand-ink underline-offset-2 hover:underline"
              >
                Board
              </Link>
            </div>
            <div className="max-h-52 overflow-y-auto">
              {todaysFlights.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-slate-400 dark:text-slate-500">
                  No flights today.
                </p>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {todaysFlights.map((r) => (
                    <li key={r.id} className="flex items-baseline gap-2 px-4 py-2.5">
                      <span className="nums text-xs text-slate-500 dark:text-slate-400 shrink-0">
                        {formatUtcTime(r.startAt)}
                      </span>
                      <span className="text-xs font-medium text-slate-700 dark:text-slate-300 shrink-0">
                        {tailForReservation(r.resourceIds)}
                      </span>
                      <span className="text-xs text-slate-400 dark:text-slate-500 truncate ml-auto text-right">
                        {r.notes?.trim() || r.status}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Card 2: Grounded aircraft (maintenance module) */}
          {enabledModules.maintenance && (
            <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden">
              <div className="hairline flex items-center justify-between px-4 py-2.5">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {groundedAircraft.length > 0 && (
                    <span
                      className="inline-block h-2 w-2 rounded-full bg-danger"
                      aria-hidden="true"
                    />
                  )}
                  Grounded
                </span>
                <Link
                  href={`/o/${slug}/fleet`}
                  className="text-xs text-brand hover:text-brand-ink underline-offset-2 hover:underline"
                >
                  Fleet
                </Link>
              </div>
              <div className="max-h-52 overflow-y-auto">
                {groundedAircraft.length === 0 ? (
                  <p className="px-4 py-6 text-center text-xs text-slate-400 dark:text-slate-500">
                    No aircraft grounded.
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                    {groundedAircraft.map((a) => (
                      <li key={a.id} className="flex items-baseline gap-2 px-4 py-2.5">
                        <Link
                          href={`/o/${slug}/fleet/${a.id}`}
                          className="nums text-xs font-bold text-slate-900 dark:text-slate-100 hover:text-brand underline-offset-2 hover:underline shrink-0"
                        >
                          {a.tailNumber}
                        </Link>
                        <span className="text-xs text-slate-400 dark:text-slate-500 truncate">
                          {a.groundingReason ?? 'No reason given'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {/* Card 3: Open squawks (maintenance module) */}
          {enabledModules.maintenance && (
            <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden">
              <div className="hairline flex items-center justify-between px-4 py-2.5">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {openSquawks.length > 0 && (
                    <span
                      className="inline-block h-2 w-2 rounded-full bg-amber-500"
                      aria-hidden="true"
                    />
                  )}
                  Open squawks
                </span>
                <Link
                  href={`/o/${slug}/maintenance/squawks`}
                  className="text-xs text-brand hover:text-brand-ink underline-offset-2 hover:underline"
                >
                  Maintenance
                </Link>
              </div>
              <div className="max-h-52 overflow-y-auto">
                {openSquawks.length === 0 ? (
                  <p className="px-4 py-6 text-center text-xs text-slate-400 dark:text-slate-500">
                    No open squawks.
                  </p>
                ) : (
                  <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                    {openSquawks.map((s) => (
                      <li key={s.id}>
                        <Link
                          href={`/o/${slug}/maintenance/squawks?resourceId=${s.resourceId}`}
                          className="flex items-start gap-2 px-4 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                        >
                          <span className="flex-1 min-w-0 text-xs text-slate-700 dark:text-slate-300 truncate">
                            {s.title}
                          </span>
                          <SeverityChip severity={s.severity} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

// ─── Range selector ───────────────────────────────────────────────────────────

interface RangeSelectorProps {
  slug: string;
  current: '7d' | '30d' | '90d';
}

function RangeSelector({ slug, current }: RangeSelectorProps) {
  const options: Array<{ key: '7d' | '30d' | '90d'; label: string }> = [
    { key: '7d', label: '7d' },
    { key: '30d', label: '30d' },
    { key: '90d', label: '90d' },
  ];

  return (
    <nav aria-label="Report range" className="flex items-center rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
      {options.map(({ key, label }) => {
        const isActive = current === key;
        return (
          <Link
            key={key}
            href={`/o/${slug}?range=${key}`}
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

// ─── Page ─────────────────────────────────────────────────────────────────────

interface DashboardPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ range?: string }>;
}

export default async function DashboardPage({
  params,
  searchParams,
}: DashboardPageProps) {
  const { slug } = await params;
  const sp = await searchParams;
  const rawRange = sp.range;
  const session = await auth();

  // Middleware guards this, but defend in depth.
  if (!session) {
    redirect(`/o/${slug}/login`);
  }

  // Per-org module toggles (Slice CLUB-MODE) — FAIL SOFT to all-enabled: a
  // read failure must never break the landing redirect or hide dashboard
  // content; each module page still gates server-side on its own read.
  let enabledModules: OrgFeatureFlags = ALL_MODULES_ENABLED;
  try {
    const features = await getOrgFeatures(session);
    enabledModules = features.features;
  } catch {
    enabledModules = ALL_MODULES_ENABLED;
  }

  // Redirect roles that belong elsewhere (student/renter → portal; mechanic → Fleet;
  // any other non-dashboard role → first accessible page).
  // Roles with reporting:access (owner/manager/dispatcher/cfi/accountant) stay here.
  const landingRaw = landingPathFor(session, NAV_ITEMS, enabledModules);
  if (landingRaw) {
    // landingRaw still contains the [slug] placeholder — resolve it now.
    redirect(landingRaw.replace('[slug]', slug));
  }

  // Validate and normalize the range param (validates→fallback 30d).
  const range = resolveRangeKey(rawRange);

  // Fetch org name for the heading (may fail gracefully).
  let orgName = slug;
  try {
    const orgData = await getDashboardSummary(session);
    orgName = orgData.orgName;
  } catch {
    // Graceful fallback to slug if org data is unavailable.
  }

  // UI-only capability check — gate is enforced server-side in the actions.
  // Spec D2: Dashboard is app:access; metrics section is reporting:access.
  const canViewReporting = hasCapability(session, 'reporting:access');

  // Setup nudge (owner/manager only): show a dismissible banner while the
  // operation's ESSENTIALS (aircraft + people) are incomplete. Best-effort —
  // any failure just hides the nudge, it never blocks the dashboard.
  let showSetupBanner = false;
  if (hasCapability(session, 'org:manage_settings')) {
    try {
      const onboarding = await getOnboardingStatus(session);
      showSetupBanner = !onboarding.essentialDone;
    } catch {
      // getOnboardingStatus failed → simply don't show the nudge.
    }
  }

  return (
    <div className="space-y-6">
      {/* ── Setup nudge — only while essentials are incomplete ────────────── */}
      {showSetupBanner && <SetupBanner slug={slug} />}

      {/* ── A. Heading row — OUTSIDE Suspense (always interactive/instant) ── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tightish text-slate-900 dark:text-slate-100">
            {orgName}
          </h1>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">Operations overview</p>
        </div>
        {canViewReporting && (
          <RangeSelector slug={slug} current={range} />
        )}
      </div>

      {/* ── B+C+D+E — Suspense boundary ─────────────────────────────────── */}
      {canViewReporting ? (
        <Suspense fallback={<DashboardSkeleton />}>
          <DashboardContent slug={slug} range={range} enabledModules={enabledModules} />
        </Suspense>
      ) : (
        <PermissionDeniedPanel />
      )}
    </div>
  );
}
