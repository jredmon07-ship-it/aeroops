/**
 * fleet/[id]/page.tsx — Aircraft detail page (RSC).
 *
 * Route: /o/[slug]/fleet/[id]
 * Capability gate: fleet:access (page-level requireCapability → redirect).
 *
 * States:
 *   Permission-denied — redirect to no-access via requireCapability.
 *   Not-found         — 404-style empty state (not a 500).
 *   Loading           — Suspense skeleton.
 *   Populated         — overview cards: identity, grounding, meters, squawks,
 *                       dispatch, upcoming reservations.
 *   Error             — destructive Alert.
 *
 * Edit button visible only if fleet:manage.
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  Plane,
  AlertTriangle,
  AlertCircle,
  WrenchIcon,
  CalendarDays,
  Gauge,
  ArrowLeft,
  CheckCircle,
} from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { getAircraftDetailAction, listAircraftAction } from '../actions';
import { EditAircraftDialog } from '../_components/edit-aircraft-dialog';
import { DispatchRequirementsCard } from '../_components/dispatch-requirements-card';
import { AvailabilityWindowsCard } from '../_components/availability-windows-card';
import { AircraftCalendarFeedCard } from '../_components/aircraft-calendar-feed-card';
import { OpenWorkOrdersCard } from '../_components/open-work-orders-card';
import { MaintenanceDueCard } from '../_components/maintenance-due-card';
import { listMaintenanceDueAction } from '../../maintenance/due-actions';
import type { SerializedMaintenanceDueView } from '../../maintenance/due-actions';
import type { SerializedAircraftDetail } from '../actions';
import type { AircraftListRow } from '@aeroops/api';

// ─── Date helpers ─────────────────────────────────────────────────────────────

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatMeter(val: number | null): string {
  if (val === null) return '—';
  return val.toFixed(1);
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function DetailSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading aircraft detail">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-48" />
        </div>
        <Skeleton className="h-10 w-24" />
      </div>
      <Skeleton className="h-12 w-full" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

// ─── Dispatch status chip ─────────────────────────────────────────────────────

function DispatchStatusChip({ status }: { status: string }) {
  if (status === 'open') {
    return (
      <span className="inline-flex items-center rounded-sm border border-brand/30 bg-brand/8 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-brand-ink">
        Open
      </span>
    );
  }
  if (status === 'closed') {
    return (
      <span className="inline-flex items-center rounded-sm border border-green-200 bg-green-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-green-800">
        Closed
      </span>
    );
  }
  if (status === 'voided') {
    return (
      <span className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-slate-500">
        Voided
      </span>
    );
  }
  return <span className="text-xs text-slate-400">{status}</span>;
}

// ─── Inner async component ────────────────────────────────────────────────────

interface DetailContentProps {
  resourceId: string;
  slug: string;
  canManage: boolean;
  canManageRequirements: boolean;
  canManageResources: boolean;
  canWorkOrder: boolean;
}

async function DetailContent({ resourceId, slug, canManage, canManageRequirements, canManageResources, canWorkOrder }: DetailContentProps) {
  const [result, aircraftListResult, maintenanceDueResult] = await Promise.all([
    getAircraftDetailAction({ resourceId }),
    listAircraftAction({ includeInactive: false }),
    listMaintenanceDueAction({ resourceId }),
  ]);

  // Auth / server errors
  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load aircraft detail. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/fleet/${resourceId}`}>Retry</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  // not_found → 404-style empty state (NOT a 500)
  if (!result.ok) {
    return (
      <div
        className="flex flex-col items-center justify-center py-16 text-center space-y-3"
        role="status"
      >
        <Plane className="h-10 w-10 text-slate-300" aria-hidden="true" />
        <p className="text-slate-700 font-medium">Aircraft not found.</p>
        <p className="text-sm text-slate-400">
          It may have been removed or you may not have access.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href={`/o/${slug}/fleet`}>
            <ArrowLeft className="h-4 w-4 mr-1" aria-hidden="true" />
            Back to Fleet
          </Link>
        </Button>
      </div>
    );
  }

  // ok: true — aircraft is defined
  const aircraft = result.aircraft;
  const aircraftList =
    'ok' in aircraftListResult && aircraftListResult.ok ? aircraftListResult.aircraft : [];
  // Best-effort fail-closed: a role with fleet:access but not maintenance:access
  // (none currently in the matrix, but this mirrors the R7 at-a-glance nit
  // posture) sees an empty maintenance-due card rather than an error.
  const maintenanceDueItems =
    'ok' in maintenanceDueResult && maintenanceDueResult.ok ? maintenanceDueResult.items : [];

  return (
    <AircraftDetailView
      aircraft={aircraft}
      slug={slug}
      canManage={canManage}
      canManageRequirements={canManageRequirements}
      canManageResources={canManageResources}
      canWorkOrder={canWorkOrder}
      aircraftList={aircraftList}
      maintenanceDueItems={maintenanceDueItems}
    />
  );
}

// ─── Detail view (pure, receives serialized data) ─────────────────────────────

interface AircraftDetailViewProps {
  aircraft: SerializedAircraftDetail;
  slug: string;
  canManage: boolean;
  canManageRequirements: boolean;
  canManageResources: boolean;
  canWorkOrder: boolean;
  aircraftList: AircraftListRow[];
  maintenanceDueItems: SerializedMaintenanceDueView[];
}

function AircraftDetailView({ aircraft, slug, canManage, canManageRequirements, canManageResources, canWorkOrder, aircraftList, maintenanceDueItems }: AircraftDetailViewProps) {
  const { grounding } = aircraft;

  return (
    <div className="space-y-6">
      {/* ── Back link ──────────────────────────────────────────────────────── */}
      <div>
        <Link
          href={`/o/${slug}/fleet`}
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Fleet
        </Link>
      </div>

      {/* ── Identity header ────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold nums text-slate-900">
            {aircraft.tailNumber}
          </h1>
          {aircraft.displayName && aircraft.displayName !== aircraft.tailNumber && (
            <p className="text-slate-600 font-medium">{aircraft.displayName}</p>
          )}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-slate-500">
            {(aircraft.make || aircraft.model) && (
              <span>{[aircraft.make, aircraft.model].filter(Boolean).join(' ')}</span>
            )}
            {aircraft.year && <span>{aircraft.year}</span>}
            {aircraft.serialNumber && (
              <span>S/N: <span className="font-mono text-xs">{aircraft.serialNumber}</span></span>
            )}
            {aircraft.homeBase && (
              <span>
                {aircraft.homeBase.name}
                {aircraft.homeBase.icao && (
                  <span className="font-mono text-xs ml-1">({aircraft.homeBase.icao})</span>
                )}
              </span>
            )}
          </div>
          {!aircraft.active && (
            <span className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-slate-500">
              Inactive
            </span>
          )}
        </div>

        {canManage && (
          <EditAircraftDialog aircraft={aircraft} slug={slug} />
        )}
      </div>

      {/* ── Grounding status banner ────────────────────────────────────────── */}
      {/* [VERIFY-5-B] operator-data language only, never "not airworthy" */}
      {grounding.grounded ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>
            <span className="font-semibold">Grounded by operator</span>
            {grounding.reason && (
              <span>: {grounding.reason}</span>
            )}
            {grounding.since && (
              <span className="ml-2 text-xs opacity-80">since {formatDateTime(grounding.since)}</span>
            )}
          </AlertDescription>
        </Alert>
      ) : (
        <div className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          <CheckCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Available — no active operator grounding</span>
        </div>
      )}

      {/* ── Dispatch requirements card (Slice 3c) ─────────────────────────── */}
      {/* [VERIFY-3c-A] free-text tags only; no FAA/currency/medical meaning */}
      <DispatchRequirementsCard
        resourceId={aircraft.id}
        canManageRequirements={canManageRequirements}
      />

      {/* ── Operating-hours availability card (Slice AV1.3) ───────────────── */}
      {/* [VERIFY-AV1-A] operator operating-hours only; NOT an FAA determination */}
      <AvailabilityWindowsCard
        resourceId={aircraft.id}
        canManageResources={canManageResources}
      />

      {/* ── Calendar feed card (Slice P1.4) ────────────────────────────────── */}
      <AircraftCalendarFeedCard resourceId={aircraft.id} />

      {/* ── Meters card ───────────────────────────────────────────────────── */}
      {/* [VERIFY-5-A] label as "last recorded" — not an airworthiness total */}
      {(aircraft.hasHobbs || aircraft.hasTach) && (
        <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-slate-400" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-700">
              Last Recorded Meters
            </h2>
            {aircraft.currentMetersAsOf && (
              <span className="text-xs text-slate-400">
                as of {formatDateTime(aircraft.currentMetersAsOf)}
              </span>
            )}
          </div>

          {aircraft.currentMetersAsOf === null ? (
            <p className="text-sm text-slate-400 italic">No recorded meters yet.</p>
          ) : (
            <div className="flex flex-wrap gap-6">
              {aircraft.hasHobbs && (
                <div>
                  <p className="text-xs text-slate-500 uppercase tracking-wide font-medium">Hobbs</p>
                  <p className="text-lg font-bold nums text-slate-900">
                    {formatMeter(aircraft.currentHobbs)}
                    <span className="text-xs font-normal text-slate-500 ml-1">h</span>
                  </p>
                </div>
              )}
              {aircraft.hasTach && (
                <div>
                  <p className="text-xs text-slate-500 uppercase tracking-wide font-medium">Tach</p>
                  <p className="text-lg font-bold nums text-slate-900">
                    {formatMeter(aircraft.currentTach)}
                    <span className="text-xs font-normal text-slate-500 ml-1">h</span>
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Open squawks card ─────────────────────────────────────────────── */}
      <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <WrenchIcon className="h-4 w-4 text-slate-400" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-700">Open Squawks</h2>
            {aircraft.openSquawkCount > 0 && (
              <span className="inline-flex items-center rounded-sm border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
                {aircraft.openSquawkCount}
              </span>
            )}
          </div>
          <Link
            href={`/o/${slug}/maintenance/squawks?resourceId=${aircraft.id}`}
            className="text-xs text-brand hover:text-brand-ink underline underline-offset-2"
          >
            View all squawks
          </Link>
        </div>

        {aircraft.recentSquawks.length === 0 ? (
          <p className="text-sm text-slate-400 italic">No open squawks.</p>
        ) : (
          <div className="space-y-1.5">
            {aircraft.recentSquawks.map((s) => (
              <div
                key={s.id}
                className="flex items-start justify-between gap-2 rounded-md bg-slate-50 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 truncate">{s.title}</p>
                  {s.description && (
                    <p className="text-xs text-slate-500 truncate">{s.description}</p>
                  )}
                </div>
                <span className="shrink-0 text-xs text-slate-400">{formatDate(s.reportedAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Recent dispatch card ───────────────────────────────────────────── */}
      <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Plane className="h-4 w-4 text-slate-400" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-slate-700">Recent Dispatch</h2>
        </div>

        {aircraft.recentDispatch.length === 0 ? (
          <p className="text-sm text-slate-400 italic">No dispatch history yet.</p>
        ) : (
          <div className="rounded-md border border-slate-100 overflow-hidden">
            <table className="w-full text-sm" aria-label="Recent dispatch history">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-100">
                  <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500">
                    Date
                  </th>
                  <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 hidden sm:table-cell">
                    Pilot
                  </th>
                  <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500">
                    Hobbs Out / In
                  </th>
                  <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 hidden sm:table-cell">
                    Flight time
                  </th>
                  <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {aircraft.recentDispatch.map((ticket) => (
                  <tr
                    key={ticket.id}
                    className="border-b border-slate-100 last:border-0"
                  >
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {formatDate(ticket.openedAt)}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600 hidden sm:table-cell font-mono truncate max-w-[8rem]">
                      {ticket.pilotUserId}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className="nums text-xs text-slate-700">
                        {formatMeter(ticket.hobbsOut)}
                        {ticket.hobbsIn !== null && (
                          <> / {formatMeter(ticket.hobbsIn)}</>
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right hidden sm:table-cell">
                      <span className="nums text-xs text-slate-700">
                        {ticket.flightTimeHours !== null
                          ? `${ticket.flightTimeHours.toFixed(1)} h`
                          : '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <DispatchStatusChip status={ticket.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Upcoming reservations card ─────────────────────────────────────── */}
      <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-slate-400" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-700">Upcoming Reservations</h2>
          </div>
          <Link
            href={`/o/${slug}/schedule`}
            className="text-xs text-brand hover:text-brand-ink underline underline-offset-2"
          >
            View schedule
          </Link>
        </div>

        {aircraft.upcomingReservations.length === 0 ? (
          <p className="text-sm text-slate-400 italic">No upcoming reservations.</p>
        ) : (
          <div className="space-y-1.5">
            {aircraft.upcomingReservations.map((res) => (
              <div
                key={res.id}
                className="flex items-center justify-between gap-2 rounded-md bg-slate-50 px-3 py-2"
              >
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                  <span className="text-sm text-slate-700">
                    {formatDateTime(res.startAt)}
                  </span>
                  <span className="text-xs text-slate-400">
                    → {formatDateTime(res.endAt)}
                  </span>
                  {res.seriesId && (
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                      Repeats
                    </Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Open work orders card (Slice M1.3) [VERIFY-M1-E] ──────────────── */}
      <OpenWorkOrdersCard
        resourceId={aircraft.id}
        openWorkOrders={aircraft.openWorkOrders ?? []}
        openWorkOrderCount={aircraft.openWorkOrderCount ?? 0}
        aircraft={aircraftList}
        slug={slug}
        canWorkOrder={canWorkOrder}
      />

      {/* ── Maintenance due card (Slice P1.5) [VERIFY-P1.5-A] ──────────────── */}
      <MaintenanceDueCard
        resourceId={aircraft.id}
        items={maintenanceDueItems}
        aircraft={aircraftList}
        slug={slug}
        canManage={canWorkOrder}
      />
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface AircraftDetailPageProps {
  params: Promise<{ slug: string; id: string }>;
}

export default async function AircraftDetailPage({ params }: AircraftDetailPageProps) {
  const { slug, id } = await params;
  const session = await auth();

  // ── RBAC gate ──────────────────────────────────────────────────────────────
  try {
    requireCapability(session, 'fleet:access');
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
  const canManage = hasCapability(session, 'fleet:manage');
  // dispatch:manage_requirements → owner/manager/dispatcher (controls add/remove UI).
  // The server-side action re-gates independently.
  const canManageRequirements = hasCapability(session, 'dispatch:manage_requirements');
  // schedule:manage_resources → owner/manager (controls availability windows UI).
  // The server-side action re-gates independently.
  const canManageResources = hasCapability(session, 'schedule:manage_resources');
  // maintenance:work_order → owner/manager/dispatcher/mechanic.
  const canWorkOrder = hasCapability(session, 'maintenance:work_order');

  return (
    <Suspense fallback={<DetailSkeleton />}>
      <DetailContent
        resourceId={id}
        slug={slug}
        canManage={canManage}
        canManageRequirements={canManageRequirements}
        canManageResources={canManageResources}
        canWorkOrder={canWorkOrder}
      />
    </Suspense>
  );
}
