/**
 * portal/schedule/page.tsx — the member Schedule (RSC).
 *
 * Route: /o/[slug]/portal/schedule?date=YYYY-MM-DD
 * Capability gate: portal:access (page-level requireCapability → /no-access),
 * and the org's portal module (like the portal home). Renters and students
 * reach it from the nav ("Schedule", portal-only); owner/manager may open it
 * from the portal home's link, but their nav keeps the staff Schedule only.
 *
 * WHAT IT SHOWS: one day, in the viewer's zone (getViewerTimeZone + dayWindow),
 * with the schedule's Prev / Today / Next (DateNav, ?date= a calendar day):
 *   one row per aircraft (tail # + make/model, "Grounded" chip) and per
 *   instructor, listing that day's taken times —
 *     someone else's booking "Booked", a blackout "Unavailable",
 *     the member's own "Your booking" (highlighted) with its notes.
 *   Free time is what is left. Staff make the bookings, so the page says to
 *   ask them for a free time (no booking control here: read-only).
 *
 * PRIVACY: listMemberAvailability returns someone else's booking as
 * { resourceId, startAt, endAt, kind } only — the page cannot show who.
 *
 * States: loading (skeleton under Suspense) · populated · nothing booked that
 * day · no aircraft or instructors yet · error (Alert + Retry) · no access
 * (redirect) · portal module off (redirect).
 *
 * COMPLIANCE: "Grounded" is the operator's own status (ADR-0008), not an
 * airworthiness determination; the copy only says staff grounded it.
 *
 * BOUNDARY: imports ONLY from '@aeroops/api' and '@aeroops/core'. Never '@aeroops/db'.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { AlertCircle, Plane } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, getOrgFeatures } from '@aeroops/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { cn } from '@/components/ui/utils';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { getViewerTimeZone } from '@/lib/viewer-time-zone';
import { dayInZone, dayLabel, dayWindow, parseDayParam } from '@/lib/schedule-day';
import { zoneAbbreviation } from '@/lib/zoned-format';
import { DateNav } from '../../schedule/_components/date-nav';
import { getMemberScheduleAction } from './actions';
import { buildMemberScheduleView } from './_utils/member-schedule-view';
import type {
  MemberScheduleIntervalView,
  MemberScheduleRowView,
} from './_utils/member-schedule-view';

// ─── Props ────────────────────────────────────────────────────────────────────

interface MemberSchedulePageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ date?: string | string[] }>;
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function MemberScheduleSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading the schedule">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="rounded-md border border-slate-200 bg-white p-4 shadow-xs dark:border-slate-800 dark:bg-slate-900"
        >
          <Skeleton className="h-4 w-32" />
          <div className="mt-3 space-y-2">
            <Skeleton className="h-3 w-48" />
            <Skeleton className="h-3 w-40" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── One taken time ───────────────────────────────────────────────────────────

const BADGE_VARIANT = {
  mine: 'info',
  booked: 'neutral',
  unavailable: 'warning',
} as const;

function IntervalItem({ interval }: { interval: MemberScheduleIntervalView }) {
  const mine = interval.kind === 'mine';
  return (
    <li
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5',
        mine && 'border-l-2 border-brand bg-brand/5 pl-3.5 dark:bg-brand/10',
      )}
    >
      <span className="nums text-sm font-medium tabular-nums text-slate-900 dark:text-slate-100">
        {interval.time}
      </span>
      <StatusBadge variant={BADGE_VARIANT[interval.kind]} size="md">
        {interval.label}
      </StatusBadge>
      {interval.withLabels.length > 0 && (
        <span className="min-w-0 break-words text-sm text-slate-600 dark:text-slate-300">
          with {interval.withLabels.join(', ')}
        </span>
      )}
      {interval.notes && (
        <p className="min-w-0 basis-full whitespace-pre-line break-words text-sm text-slate-600 dark:text-slate-300">
          {interval.notes}
        </p>
      )}
    </li>
  );
}

// ─── One aircraft / instructor ────────────────────────────────────────────────

function ResourceRow({ row }: { row: MemberScheduleRowView }) {
  const headingId = `ms-row-${row.resourceId}`;
  return (
    <li className="overflow-hidden rounded-md border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <h3
          id={headingId}
          className={cn(
            'min-w-0 break-words text-sm font-semibold text-slate-900 dark:text-slate-100',
            row.kind === 'aircraft' && 'nums',
          )}
        >
          {row.title}
        </h3>
        {row.detail && (
          <span className="min-w-0 break-words text-sm text-slate-500 dark:text-slate-400">
            {row.detail}
          </span>
        )}
        {row.grounded && (
          <StatusBadge variant="danger" size="md">
            Grounded
          </StatusBadge>
        )}
      </div>

      {row.grounded && (
        <p className="px-4 pt-2.5 text-xs text-slate-600 dark:text-slate-300">
          Staff have grounded this aircraft. Ask them before you plan a flight in it.
        </p>
      )}

      {row.intervals.length === 0 ? (
        <p className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">Nothing booked.</p>
      ) : (
        <ul
          role="list"
          aria-labelledby={headingId}
          className="divide-y divide-slate-100 dark:divide-slate-800"
        >
          {row.intervals.map((interval) => (
            <IntervalItem key={interval.key} interval={interval} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ResourceSection({
  id,
  title,
  rows,
  emptyText,
}: {
  id: string;
  title: string;
  rows: MemberScheduleRowView[];
  emptyText: string;
}) {
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h2
        id={id}
        className="text-lg font-semibold tracking-tightish text-slate-900 dark:text-slate-100"
      >
        {title}
      </h2>
      {rows.length === 0 ? (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500 shadow-xs dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
          {emptyText}
        </p>
      ) : (
        <ul role="list" className="space-y-3">
          {rows.map((row) => (
            <ResourceRow key={row.resourceId} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

// ─── Content (fetches under Suspense) ─────────────────────────────────────────

interface MemberScheduleContentProps {
  slug: string;
  /** The ?date= day, "YYYY-MM-DD". */
  day: string;
  /** The viewer's IANA zone: the day runs midnight to midnight there. */
  timeZone: string;
}

async function MemberScheduleContent({ slug, day, timeZone }: MemberScheduleContentProps) {
  const dayRange = dayWindow(day, timeZone);
  const result = await getMemberScheduleAction(dayRange);

  if (!('ok' in result)) {
    const message =
      result.error === 'forbidden'
        ? 'You do not have access to the schedule.'
        : result.error === 'unauthenticated'
          ? 'Your session has expired. Please sign in again.'
          : 'Could not load the schedule. Please try again.';
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex flex-wrap items-center justify-between gap-4">
          <span>{message}</span>
          <Link
            href={`/o/${slug}/portal/schedule?date=${day}`}
            className="text-sm underline underline-offset-2 hover:no-underline"
          >
            Retry
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  const view = buildMemberScheduleView(result.availability, dayRange, timeZone);

  if (view.aircraft.length === 0 && view.instructors.length === 0) {
    return (
      <div className="rounded-md border border-slate-200 bg-white shadow-xs dark:border-slate-800 dark:bg-slate-900">
        <EmptyState
          icon={Plane}
          title="No aircraft on the schedule yet"
          body="When staff add aircraft and instructors, you will see here when each one is free."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {view.nothingBooked && (
        <p
          role="status"
          className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 shadow-xs dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
        >
          Nothing is booked on {dayLabel(day)}.
        </p>
      )}

      <ResourceSection
        id="ms-aircraft"
        title="Aircraft"
        rows={view.aircraft}
        emptyText="No aircraft on the schedule yet."
      />

      {view.instructors.length > 0 && (
        <ResourceSection
          id="ms-instructors"
          title="Instructors"
          rows={view.instructors}
          emptyText="No instructors on the schedule yet."
        />
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function MemberSchedulePage({
  params,
  searchParams,
}: MemberSchedulePageProps) {
  const { slug } = await params;
  const { date: dateParam } = await searchParams;
  const session = await auth();

  // Middleware guards this, but defend in depth.
  if (!session) {
    redirect(`/o/${slug}/login`);
  }

  // Page-level capability gate: portal:access → redirect /no-access on Forbidden.
  try {
    requireCapability(session, 'portal:access');
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

  // ── Module gate (Slice CLUB-MODE) — part of the portal; fail-soft to
  // enabled on read failure, like the portal home. redirect() stays OUTSIDE
  // the try/catch (it throws to signal the redirect).
  let portalOn = true;
  try {
    portalOn = (await getOrgFeatures(session)).features.portal;
  } catch {
    portalOn = true;
  }
  if (!portalOn) {
    redirect(`/o/${slug}/no-access?reason=module_disabled`);
  }

  // ?date= is a calendar day kept as a string; today and the day's window are
  // in the viewer's zone (lib/schedule-day.ts). A malformed or repeated ?date=
  // falls back to today.
  const timeZone = await getViewerTimeZone();
  const todayIso = dayInZone(new Date(), timeZone);
  const day = parseDayParam(Array.isArray(dateParam) ? undefined : dateParam) ?? todayIso;
  const zone = zoneAbbreviation(timeZone, dayWindow(day, timeZone).from);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Schedule"
        subtitle={`When each aircraft and instructor is already taken. Times are in ${zone}.`}
      />

      <p
        role="note"
        className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 shadow-xs dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300"
      >
        Staff make the bookings. Find a time that is free here, then ask them to book it for you.
      </p>

      <DateNav day={day} basePath={`/o/${slug}/portal/schedule`} />

      {/* Keyed by day + zone so a ?date= step shows the skeleton, not the old day. */}
      <Suspense key={`${day}@${timeZone}`} fallback={<MemberScheduleSkeleton />}>
        <MemberScheduleContent slug={slug} day={day} timeZone={timeZone} />
      </Suspense>
    </div>
  );
}
