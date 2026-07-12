/**
 * people/[id]/page.tsx — Member detail page (RSC).
 *
 * Route: /o/[slug]/people/[id]
 * Capability gate: people:access (page-level requireCapability → redirect).
 *
 * States:
 *   Permission-denied — redirect to no-access via requireCapability.
 *   Not-found         — 404-style empty state (not a 500).
 *   Loading           — Suspense skeleton.
 *   Populated         — header (status chip + "no login" hint);
 *                       Contact card; Tags card (add/remove if people:manage);
 *                       Upcoming reservations booked by them (created_by) [VERIFY-6-C];
 *                       Recent dispatch as pilot;
 *                       Edit + Deactivate/Reactivate if people:manage.
 *   Deactivated       — still renders full detail.
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 * [VERIFY-6-C]: "booked by them" = reservation.created_by, NOT flight assignment.
 * [VERIFY-6-D]: status is a roster flag, NOT a login gate.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import {
  ArrowLeft,
  Users,
  AlertCircle,
  CalendarDays,
  Plane,
  Phone,
  Mail,
} from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { getMemberDetailAction } from '../actions';
import type { SerializedMemberDetail } from '../actions';
import { MemberDetailClient } from '../_components/member-detail-client';
import { MemberExpirationsCard } from '../_components/member-expirations-card';
import { MemberTrainingCard } from '../_components/member-training-card';
import { MemberLogbookCard } from '../_components/member-logbook-card';
import { MemberBalanceCard } from '../_components/member-balance-card';
import { DocumentsCard } from '../../documents-card';

// ─── Date helpers ──────────────────────────────────────────────────────────────

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

// ─── Loading skeleton ──────────────────────────────────────────────────────────

function DetailSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading member detail">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
        <Skeleton className="h-10 w-24" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

// ─── Dispatch status chip ──────────────────────────────────────────────────────

function DispatchStatusChip({ status }: { status: string }) {
  if (status === 'open') {
    return (
      <span className="inline-flex items-center rounded-sm border border-brand/30 bg-brand/8 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-brand-ink">
        Open
      </span>
    );
  }
  if (status === 'closed') {
    return (
      <span className="inline-flex items-center rounded-sm border border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-950/40 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-green-800 dark:text-green-200">
        Closed
      </span>
    );
  }
  if (status === 'voided') {
    return (
      <span className="inline-flex items-center rounded-sm border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-slate-500 dark:text-slate-400">
        Voided
      </span>
    );
  }
  return <span className="text-xs text-slate-400 dark:text-slate-500">{status}</span>;
}

// ─── Static contact card ───────────────────────────────────────────────────────

function StaticContactCard({ member }: { member: SerializedMemberDetail }) {
  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
      <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Contact</h2>
      <dl className="space-y-2">
        <div className="flex items-center gap-2">
          <dt className="sr-only">Email</dt>
          <Mail className="h-4 w-4 text-slate-400 dark:text-slate-500 shrink-0" aria-hidden="true" />
          <dd className="text-sm text-slate-700 dark:text-slate-300 break-all">{member.email}</dd>
        </div>
        {member.phone ? (
          <div className="flex items-center gap-2">
            <dt className="sr-only">Phone</dt>
            <Phone className="h-4 w-4 text-slate-400 dark:text-slate-500 shrink-0" aria-hidden="true" />
            <dd className="text-sm text-slate-700 dark:text-slate-300">{member.phone}</dd>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <dt className="sr-only">Phone</dt>
            <Phone className="h-4 w-4 text-slate-300 shrink-0" aria-hidden="true" />
            <dd className="text-sm text-slate-400 dark:text-slate-500 italic">No phone on file</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

// ─── Upcoming reservations card ────────────────────────────────────────────────

function StaticUpcomingReservationsCard({ member }: { member: SerializedMemberDetail }) {
  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <CalendarDays className="h-4 w-4 text-slate-400 dark:text-slate-500" aria-hidden="true" />
        {/* [VERIFY-6-C]: wording must not imply flight assignment/training credit */}
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Upcoming Reservations</h2>
        <span className="text-xs text-slate-400 dark:text-slate-500">(booked by them)</span>
      </div>

      {member.upcomingReservations.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500 italic">No upcoming reservations booked by this member.</p>
      ) : (
        <div className="space-y-1.5">
          {member.upcomingReservations.map((res) => (
            <div
              key={res.id}
              className="flex items-center justify-between gap-2 rounded-md bg-slate-50 dark:bg-slate-800 px-3 py-2"
            >
              <div className="flex flex-wrap items-center gap-2 min-w-0">
                <span className="text-sm text-slate-700 dark:text-slate-300">{formatDateTime(res.startAt)}</span>
                <span className="text-xs text-slate-400 dark:text-slate-500">→ {formatDateTime(res.endAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Recent dispatch card ──────────────────────────────────────────────────────

function StaticDispatchCard({ member }: { member: SerializedMemberDetail }) {
  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Plane className="h-4 w-4 text-slate-400 dark:text-slate-500" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Recent Dispatch as Pilot</h2>
      </div>

      {member.recentDispatch.length === 0 ? (
        <p className="text-sm text-slate-400 dark:text-slate-500 italic">No dispatch history as pilot.</p>
      ) : (
        <div className="rounded-md border border-slate-100 dark:border-slate-800 overflow-x-auto">
          <table className="w-full text-sm" aria-label="Recent dispatch as pilot">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-100 dark:border-slate-800">
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400">
                  Date
                </th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400 hidden sm:table-cell">
                  Hobbs Out / In
                </th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400 hidden sm:table-cell">
                  Flight time
                </th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {member.recentDispatch.map((ticket) => (
                <tr key={ticket.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                  <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300 nums">{formatDate(ticket.openedAt)}</td>
                  <td className="px-3 py-2 text-right hidden sm:table-cell">
                    <span className="nums text-xs text-slate-700 dark:text-slate-300">
                      {ticket.hobbsOut.toFixed(1)}
                      {ticket.hobbsIn !== null && <> / {ticket.hobbsIn.toFixed(1)}</>}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right hidden sm:table-cell">
                    <span className="nums text-xs text-slate-700 dark:text-slate-300">
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
  );
}

// ─── Inner async component ─────────────────────────────────────────────────────

interface DetailContentProps {
  userId: string;
  slug: string;
  canManage: boolean;
  canViewBilling: boolean;
}

async function DetailContent({ userId, slug, canManage, canViewBilling }: DetailContentProps) {
  const result = await getMemberDetailAction({ userId });

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load member detail. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/people/${userId}`}>Retry</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!result.ok) {
    // not_found → 404-style empty state (NOT a 500)
    return (
      <div
        className="flex flex-col items-center justify-center py-16 text-center space-y-3"
        role="status"
      >
        <Users className="h-10 w-10 text-slate-300" aria-hidden="true" />
        <p className="text-slate-700 dark:text-slate-300 font-medium">Member not found.</p>
        <p className="text-sm text-slate-400 dark:text-slate-500">
          They may have been removed or you may not have access.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href={`/o/${slug}/people`}>
            <ArrowLeft className="h-4 w-4 mr-1" aria-hidden="true" />
            Back to People
          </Link>
        </Button>
      </div>
    );
  }

  const member = result.member;

  return (
    <div className="space-y-6">
      {/* ── Back link ──────────────────────────────────────────────────────── */}
      <div>
        <Link
          href={`/o/${slug}/people`}
          className="inline-flex items-center gap-1 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          People
        </Link>
      </div>

      {/* ── Identity header + Tags (client for interactivity) ─────────────── */}
      <MemberDetailClient member={member} slug={slug} canManage={canManage} />

      {/* ── Static cards ────────────────────────────────────────────────────── */}
      <StaticContactCard member={member} />

      {/* ── Account balance chip — billing:access only, fail-closed hidden ──── */}
      {canViewBilling && (
        <Suspense
          fallback={
            <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 animate-pulse" aria-busy="true">
              <div className="h-4 w-28 bg-slate-200 dark:bg-slate-700 rounded mb-3" />
              <div className="h-7 w-24 bg-slate-100 dark:bg-slate-800 rounded" />
            </div>
          }
        >
          <MemberBalanceCard memberUserId={member.userId} slug={slug} />
        </Suspense>
      )}

      {/* ── Expirations card (Slice FC-P2) [VERIFY-FC-P2-A] ─────────────────── */}
      {/* Operator-entered reminder dates — warn-only, never blocks dispatch. */}
      <MemberExpirationsCard memberUserId={member.userId} canManage={canManage} />

      <StaticUpcomingReservationsCard member={member} />
      <StaticDispatchCard member={member} />

      {/* ── Documents card (Slice P1.6) [VERIFY-P1.6-A] ─────────────────────── */}
      <DocumentsCard ownerType="member" ownerId={member.userId} canManage={canManage} />

      {/* ── Training card (Slice T1.3) — fetched in Suspense ────────────── */}
      {/* Renders for people:access holders; [VERIFY-T1-B] applies. */}
      <Suspense
        fallback={
          <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 animate-pulse" aria-busy="true">
            <div className="h-4 w-20 bg-slate-200 dark:bg-slate-700 rounded mb-3" />
            <div className="space-y-2">
              <div className="h-8 w-full bg-slate-100 dark:bg-slate-800 rounded" />
              <div className="h-8 w-full bg-slate-100 dark:bg-slate-800 rounded" />
            </div>
          </div>
        }
      >
        <MemberTrainingCard userId={member.userId} slug={slug} />
      </Suspense>

      {/* ── Logbook card (Slice P2) — fetched in Suspense ─────────────────── */}
      {/* Convenience view of dispatch history — NOT a §61.51 record of record. */}
      <Suspense
        fallback={
          <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 animate-pulse" aria-busy="true">
            <div className="h-4 w-20 bg-slate-200 dark:bg-slate-700 rounded mb-3" />
            <div className="space-y-2">
              <div className="h-8 w-full bg-slate-100 dark:bg-slate-800 rounded" />
              <div className="h-8 w-full bg-slate-100 dark:bg-slate-800 rounded" />
            </div>
          </div>
        }
      >
        <MemberLogbookCard userId={member.userId} />
      </Suspense>
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

interface MemberDetailPageProps {
  params: Promise<{ slug: string; id: string }>;
}

export default async function MemberDetailPage({ params }: MemberDetailPageProps) {
  const { slug, id } = await params;
  const session = await auth();

  // ── RBAC gate ──────────────────────────────────────────────────────────────
  try {
    requireCapability(session, 'people:access');
  } catch (err) {
    const action = mapAuthErrorToResponse(err);
    if (action === 'forbidden') redirect(`/o/${slug}/no-access?reason=insufficient_role`);
    if (action === 'login') redirect(`/o/${slug}/login`);
    throw err;
  }

  const canManage = hasCapability(session, 'people:manage');
  const canViewBilling = hasCapability(session, 'billing:access');

  return (
    <Suspense fallback={<DetailSkeleton />}>
      <DetailContent userId={id} slug={slug} canManage={canManage} canViewBilling={canViewBilling} />
    </Suspense>
  );
}
