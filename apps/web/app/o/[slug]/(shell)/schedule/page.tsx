/**
 * schedule/page.tsx — Reservations List page (RSC).
 *
 * Route: /o/[slug]/schedule
 * Capability: schedule:access (server-side gate via requireCapability in the action;
 *   requireCapability is also called here for the redirect path).
 *
 * AUTHZ:
 *   requireCapability(session, 'schedule:access') → ForbiddenError → redirect no-access.
 *   hasCapability used UI-only for conditional rendering (canCreate, canManageResources).
 *
 * TENANT ISOLATION:
 *   All data fetched via server actions which call auth() internally.
 *   listReservationsAction + listResourcesAction are org-scoped by session.orgId.
 *
 * States:
 *   Loading         — Suspense wraps ScheduleContent; outer skeleton shows 3 rows.
 *   Populated       — ReservationList renders cards.
 *   Empty           — ReservationList renders empty state.
 *   Error           — listReservationsAction returns error → error prop to list.
 *   No permission   — requireCapability throws ForbiddenError → redirect no-access.
 *   First-run       — no resources + canManageResources → info banner in ReservationList.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/auth';
import { requireCapability, hasCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/ui/page-header';
import { DateNav } from './_components/date-nav';
import { ReservationList } from './_components/reservation-list';
import { MonthView } from './_components/month-view';
import {
  listReservationsAction,
  listResourcesAction,
  listOrgMembersAction,
} from './actions';
import {
  parseDateParam,
  startOfDay,
  endOfDay,
  toDateInputValue,
} from './_utils/format-time';
import { buildMonthGrid, parseMonthParam, formatMonthParam } from '@/lib/month-grid';

// ─── Props ────────────────────────────────────────────────────────────────────

interface SchedulePageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    date?: string;
    success?: string;
    /** 'month' switches to the month calendar; anything else = List (default). */
    view?: string;
    /** "YYYY-MM" month to display when view=month. */
    month?: string;
  }>;
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function ScheduleSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading reservations">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

// ─── Inner async component (fetches data under Suspense) ──────────────────────

interface ScheduleContentProps {
  slug: string;
  date: Date;
  dateStr: string;
  canCreate: boolean;
  canManageResources: boolean;
}

async function ScheduleContent({
  slug,
  date,
  dateStr,
  canCreate,
  canManageResources,
}: ScheduleContentProps) {
  // Fetch reservations + resources in parallel.
  const [reservationsResult, resourcesResult] = await Promise.all([
    listReservationsAction({ from: startOfDay(date), to: endOfDay(date) }),
    listResourcesAction({}),
  ]);

  const reservations =
    'ok' in reservationsResult && reservationsResult.ok
      ? reservationsResult.reservations
      : [];

  const resources =
    'ok' in resourcesResult && resourcesResult.ok
      ? resourcesResult.resources
      : [];

  const hasError = !('ok' in reservationsResult) || !reservationsResult.ok;

  return (
    <ReservationList
      reservations={reservations}
      resources={resources}
      canCreate={canCreate}
      canManageResources={canManageResources}
      dateStr={dateStr}
      slug={slug}
      error={hasError}
    />
  );
}

// ─── Month-view inner async component (fetches data under Suspense) ──────────

interface MonthContentProps {
  slug: string;
  year: number;
  month: number;
  todayIso: string;
  canManageResources: boolean;
}

async function MonthContent({
  slug,
  year,
  month,
  todayIso,
  canManageResources,
}: MonthContentProps) {
  // Padded grid window: local midnight of the first grid cell → end of the
  // last grid cell (same local-day semantics as the List view's day window).
  const grid = buildMonthGrid(year, month);
  const from = startOfDay(parseDateParam(grid.gridStartIso) ?? new Date());
  const to = endOfDay(parseDateParam(grid.gridEndIso) ?? new Date());

  // Fetch reservations + resources (+ member names when permitted) in parallel.
  // listReservations excludes cancelled by default — month chips never show them.
  // Member names are gated on schedule:manage_resources server-side; without
  // the capability we skip the call entirely (fail-closed: chips omit booked-by).
  const [reservationsResult, resourcesResult, membersResult] = await Promise.all([
    listReservationsAction({ from, to }),
    listResourcesAction({}),
    canManageResources
      ? listOrgMembersAction()
      : Promise.resolve(null),
  ]);

  const reservations =
    'ok' in reservationsResult && reservationsResult.ok
      ? reservationsResult.reservations
      : [];
  const resources =
    'ok' in resourcesResult && resourcesResult.ok ? resourcesResult.resources : [];
  const memberNames: Array<[string, string]> =
    membersResult && 'ok' in membersResult && membersResult.ok
      ? membersResult.members.map((m) => [m.userId, m.displayName])
      : [];

  const hasError = !('ok' in reservationsResult) || !reservationsResult.ok;

  return (
    <MonthView
      slug={slug}
      year={year}
      month={month}
      todayIso={todayIso}
      reservations={reservations}
      resources={resources}
      memberNames={memberNames}
      error={hasError}
    />
  );
}

// ─── Page component ───────────────────────────────────────────────────────────

export default async function SchedulePage({
  params,
  searchParams,
}: SchedulePageProps) {
  const { slug } = await params;
  const {
    date: dateParam,
    view: viewParam,
    month: monthParam,
  } = await searchParams;

  const session = await auth();

  // ── Server-side RBAC gate ─────────────────────────────────────────────────
  try {
    requireCapability(session, 'schedule:access');
  } catch (err) {
    const action = mapAuthErrorToResponse(err);
    if (action === 'forbidden') {
      redirect(`/o/${slug}/no-access?reason=insufficient_role`);
    }
    if (action === 'login') {
      redirect(`/o/${slug}/login`);
    }
    throw err;
  }

  // ── Capability checks for UI rendering (UI-only, NOT the gate) ───────────
  // UI only — gate enforced by requireCapability in each server action.
  const canCreate = hasCapability(session, 'schedule:create_reservation');
  const canManageResources = hasCapability(session, 'schedule:manage_resources');
  const canAutoSchedule = hasCapability(session, 'schedule:create_reservation');

  // ── Resolve the display date + view ──────────────────────────────────────
  // Default stays List — ?view=month is opt-in (linkable), zero behavior
  // change for existing users. Malformed ?month= degrades to the display date.
  const date = parseDateParam(dateParam) ?? new Date();
  const dateStr = toDateInputValue(date);
  const isMonthView = viewParam === 'month';
  const ym = parseMonthParam(monthParam) ?? {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
  };
  const monthStr = formatMonthParam(ym.year, ym.month);
  const todayIso = toDateInputValue(new Date());

  return (
    <div className="space-y-4">
      {/* ── Page heading + primary action ────────────────────────────────── */}
      <PageHeader
        title="Schedule"
        actions={
          <>
            {/* Auto-schedule — shown only with schedule:create_reservation (UI-only; gate in action) */}
            {canAutoSchedule && (
              <Button asChild variant="outline" size="sm">
                <Link href={`/o/${slug}/schedule/auto`}>
                  Auto-schedule
                </Link>
              </Button>
            )}
            {/* + New Reservation — shown only with schedule:create_reservation */}
            {canCreate && (
              <Button asChild>
                <Link href={`/o/${slug}/schedule/new?date=${dateStr}`}>
                  + New Reservation
                </Link>
              </Button>
            )}
          </>
        }
      />

      {/* ── Toolbar: DateNav (List only) + List/Month/Board view toggle ──── */}
      <div className="flex flex-wrap items-center gap-3">
        {!isMonthView && <DateNav date={date} basePath={`/o/${slug}/schedule`} />}

        {/* List / Month / Board view toggle */}
        <div
          role="group"
          aria-label="View"
          className="flex rounded-md border border-slate-200 overflow-hidden"
        >
          {isMonthView ? (
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="rounded-none border-r border-slate-200"
            >
              <Link href={`/o/${slug}/schedule?date=${dateStr}`}>List</Link>
            </Button>
          ) : (
            <Button
              variant="default"
              size="sm"
              className="rounded-none border-r border-slate-200"
              aria-current="page"
              disabled
            >
              List
            </Button>
          )}
          {isMonthView ? (
            <Button
              variant="default"
              size="sm"
              className="rounded-none border-r border-slate-200"
              aria-current="page"
              disabled
            >
              Month
            </Button>
          ) : (
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="rounded-none border-r border-slate-200"
            >
              <Link href={`/o/${slug}/schedule?view=month&month=${monthStr}`}>
                Month
              </Link>
            </Button>
          )}
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="rounded-none"
          >
            <Link href={`/o/${slug}/schedule/board?date=${dateStr}`}>
              Board
            </Link>
          </Button>
        </div>
      </div>

      {/* ── Content under Suspense: Month grid or Reservation list ────────── */}
      <Suspense fallback={<ScheduleSkeleton />}>
        {isMonthView ? (
          <MonthContent
            slug={slug}
            year={ym.year}
            month={ym.month}
            todayIso={todayIso}
            canManageResources={canManageResources}
          />
        ) : (
          <ScheduleContent
            slug={slug}
            date={date}
            dateStr={dateStr}
            canCreate={canCreate}
            canManageResources={canManageResources}
          />
        )}
      </Suspense>
    </div>
  );
}
