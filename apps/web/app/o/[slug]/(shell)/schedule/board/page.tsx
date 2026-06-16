/**
 * board/page.tsx — Dispatch Board page (RSC).
 *
 * Route: /o/[slug]/schedule/board
 * Capability: schedule:access (server-side gate; redirect to no-access on Forbidden).
 *
 * Resolves ?date= (default today), fetches listReservations + listResources in
 * parallel, passes canDrag=hasCapability(session,'schedule:create_reservation'),
 * renders <Suspense> skeleton.
 *
 * States:
 *   Loading           — Suspense skeleton grid.
 *   Populated         — DispatchBoard renders the grid.
 *   Empty (no res.)   — Overlay "No reservations on this date" + book link if cap.
 *   Empty (no res.)   — Alert + manage link if schedule:manage_resources.
 *   Error             — destructive Alert + Retry.
 *   No permission     — redirect to no-access via requireCapability.
 *
 * BOUNDARY: imports only from '@aeroops/api'; never '@aeroops/db'.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { PlaneTakeoff, CalendarX } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { DateNav } from '../_components/date-nav';
import { DispatchBoard } from './_components/dispatch-board';
import { listReservationsAction, listResourcesAction } from '../actions';
import {
  parseDateParam,
  startOfDay,
  endOfDay,
  toDateInputValue,
  formatDate,
} from '../_utils/format-time';

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function BoardSkeleton() {
  return (
    <div
      className="rounded-lg border border-slate-200 overflow-hidden"
      aria-busy="true"
      aria-label="Loading dispatch board"
    >
      {/* Time axis skeleton */}
      <Skeleton className="h-8 w-full rounded-none" />
      {/* Row skeletons */}
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-16 w-full rounded-none border-t border-slate-100" />
      ))}
    </div>
  );
}

// ─── Inner async component ────────────────────────────────────────────────────

interface BoardContentProps {
  slug: string;
  date: Date;
  dateStr: string;
  canDrag: boolean;
  canCreate: boolean;
  canManageResources: boolean;
}

async function BoardContent({
  slug,
  date,
  dateStr,
  canDrag,
  canCreate,
  canManageResources,
}: BoardContentProps) {
  // Parallel fetch — same pattern as schedule/page.tsx
  const [reservationsResult, resourcesResult] = await Promise.all([
    listReservationsAction({ from: startOfDay(date), to: endOfDay(date) }),
    listResourcesAction({}),
  ]);

  // Error state
  const reservationsError =
    !('ok' in reservationsResult) || !reservationsResult.ok;
  const resourcesError =
    !('ok' in resourcesResult) || !resourcesResult.ok;

  if (reservationsError || resourcesError) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load the dispatch board. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/schedule/board?date=${dateStr}`}>
              Retry
            </Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const reservations = reservationsResult.ok ? reservationsResult.reservations : [];
  const resources = resourcesResult.ok ? resourcesResult.resources : [];

  // Empty — no resources at all
  if (resources.length === 0) {
    return (
      <Alert role="status">
        <PlaneTakeoff className="h-4 w-4" aria-hidden="true" />
        <AlertDescription>
          No aircraft or instructors have been added yet.{' '}
          {canManageResources && (
            <Link
              href={`/o/${slug}/schedule/resources`}
              className="underline text-sky-600 hover:text-sky-700"
            >
              Manage resources
            </Link>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  // Empty — no reservations on this date
  if (reservations.length === 0) {
    return (
      <div className="relative">
        {/* Still render the board so layout is visible */}
        <div className="rounded-lg border border-slate-200 overflow-hidden opacity-40">
          <div className="h-8 bg-slate-50 border-b border-slate-200" />
          {resources.map((r) => (
            <div key={r.id} className="h-16 border-b border-slate-100" />
          ))}
        </div>
        {/* Overlay */}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
          <CalendarX className="h-8 w-8 text-slate-400" aria-hidden="true" />
          <p className="text-sm text-slate-500 font-medium">
            No reservations on this date.
          </p>
          {canCreate && (
            <Button asChild size="sm">
              <Link href={`/o/${slug}/schedule/new?date=${dateStr}`}>
                + New Reservation
              </Link>
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <DispatchBoard
      initialReservations={reservations}
      resources={resources}
      date={date}
      canDrag={canDrag}
    />
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface BoardPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ date?: string }>;
}

export default async function BoardPage({
  params,
  searchParams,
}: BoardPageProps) {
  const { slug } = await params;
  const { date: dateParam } = await searchParams;

  const session = await auth();

  // ── RBAC gate ──────────────────────────────────────────────────────────────
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

  // ── Capability checks (UI-only; gate enforced server-side in actions) ───────
  const canDrag = hasCapability(session, 'schedule:create_reservation');
  const canCreate = hasCapability(session, 'schedule:create_reservation');
  const canManageResources = hasCapability(session, 'schedule:manage_resources');

  // ── Resolve date ──────────────────────────────────────────────────────────
  const date = parseDateParam(dateParam) ?? new Date();
  const dateStr = toDateInputValue(date);

  return (
    <div className="space-y-4">
      {/* ── Header row ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-slate-900">Dispatch Board</h1>
        {canCreate && (
          <Button asChild>
            <Link href={`/o/${slug}/schedule/new?date=${dateStr}`}>
              + New Reservation
            </Link>
          </Button>
        )}
      </div>

      {/* ── Toolbar: DateNav + List/Board toggle ─────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <DateNav
          date={date}
          basePath={`/o/${slug}/schedule/board`}
        />

        {/* List / Board view toggle */}
        <div
          role="group"
          aria-label="View"
          className="flex rounded-md border border-slate-200 overflow-hidden"
        >
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="rounded-none border-r border-slate-200"
          >
            <Link href={`/o/${slug}/schedule?date=${dateStr}`}>
              List
            </Link>
          </Button>
          <Button
            variant="default"
            size="sm"
            className="rounded-none"
            aria-current="page"
            disabled
          >
            Board
          </Button>
        </div>
      </div>

      {/* ── Board content under Suspense ──────────────────────────────────── */}
      <Suspense fallback={<BoardSkeleton />}>
        <BoardContent
          slug={slug}
          date={date}
          dateStr={dateStr}
          canDrag={canDrag}
          canCreate={canCreate}
          canManageResources={canManageResources}
        />
      </Suspense>
    </div>
  );
}
