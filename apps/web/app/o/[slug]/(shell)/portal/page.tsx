/**
 * portal/page.tsx — Student/Renter self-service portal (RSC, Slice P1.2).
 *
 * Route: /o/[slug]/portal
 * Capability gate: portal:access (page-level requireCapability → redirect /no-access).
 *
 * portal:access is granted to: student, renter, owner, manager.
 * cfi, dispatcher, accountant, mechanic do NOT have portal:access.
 *
 * Layout (top → bottom):
 *   A. Heading — "Welcome, {firstName}" (derived from account.displayName).
 *      Rendered inside the Suspense boundary so it shows the real name,
 *      not a skeleton placeholder.
 *   B. My upcoming reservations — start/end local-formatted, tail #s from
 *      resourceIds, booker/pilot chip. Empty: "No upcoming reservations."
 *      NO book CTA (self-booking is deferred).
 *   C. My training — per-enrollment: course title + status pill + progress bar
 *      + completedCount/totalLessons. Empty: "Not enrolled in a course yet."
 *      Verbatim [VERIFY-T1-B] footnote required by spec.
 *   D. Account — name/email/phone/role label/member-since/read-only tag chips.
 *      No edit (self-edit is deferred).
 *
 * States:
 *   Loading           — per-section skeleton (Suspense boundary)
 *   Populated         — full layout above
 *   Empty (section)   — faded-0 / descriptive text per section
 *   Error             — destructive Alert + Retry link
 *   Permission-denied — redirect to /no-access?reason=insufficient_role
 *
 * THE LOAD-BEARING REQUIREMENT — SELF-SCOPING:
 *   getMyPortalSummaryAction calls getMyPortalSummary() which filters ALL rows to
 *   session.userId from the signed JWT. No userId param is accepted. A student/renter
 *   NEVER sees another member's data.
 *
 * BOUNDARY: imports ONLY from '@aeroops/api' and '@aeroops/core'. Never '@aeroops/db'.
 *
 * [VERIFY-T1-B]: progressRatio is content-coverage, NOT a regulatory outcome.
 * [VERIFY-6-A]: tags are free-text only.
 * [MONEY BOUNDARY]: No price, rate, balance, or billing data.
 */

import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability } from '@aeroops/api';
import { ROLE_LABELS } from '@aeroops/core';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { getMyPortalSummaryAction } from './actions';
import type { SerializedMyPortalSummary } from './actions';
// Pure display helpers — extracted to a separate file so they can be
// unit-tested without the Next.js/React imports in this page.
// Imported for use within this file; the utils file is the canonical export.
import { deriveFirstName, reservationRoleLabel } from './_utils/portal-display';

/**
 * formatLocalDateTime — formats an ISO string to a readable local date+time.
 */
function formatLocalDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * formatLocalDate — formats an ISO string to a readable local date.
 */
function formatLocalDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ─── Status pill ──────────────────────────────────────────────────────────────

function EnrollmentStatusPill({ status }: { status: string }) {
  const variants: Record<string, string> = {
    active:
      'inline-flex items-center rounded-sm border border-brand/30 bg-brand/10 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-brand-ink',
    completed:
      'inline-flex items-center rounded-sm border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-emerald-800',
    withdrawn:
      'inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-slate-500',
  };
  const cls =
    variants[status] ??
    'inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-slate-500';
  return (
    <span className={cls}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

function ReservationRoleChip({
  role,
}: {
  role: 'booker' | 'pilot' | 'booker_and_pilot';
}) {
  return (
    <span className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium leading-4 text-slate-600">
      {reservationRoleLabel(role)}
    </span>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function PortalSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading portal">
      {/* Heading skeleton */}
      <div className="space-y-1">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
      </div>

      {/* Reservations card */}
      <div className="rounded-md border border-slate-200 bg-white shadow-xs overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-3">
          <Skeleton className="h-3.5 w-44" />
        </div>
        <div className="p-5 space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex flex-wrap items-center gap-4">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      </div>

      {/* Training card */}
      <div className="rounded-md border border-slate-200 bg-white shadow-xs overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-3">
          <Skeleton className="h-3.5 w-24" />
        </div>
        <div className="p-5 space-y-4">
          {[0, 1].map((i) => (
            <div key={i} className="space-y-2">
              <div className="flex items-center gap-3">
                <Skeleton className="h-3.5 w-48" />
                <Skeleton className="h-4 w-16" />
              </div>
              <div className="flex items-center gap-3">
                <Skeleton className="h-1.5 flex-1 rounded-full" />
                <Skeleton className="h-3 w-8" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Account card */}
      <div className="rounded-md border border-slate-200 bg-white shadow-xs overflow-hidden">
        <div className="border-b border-slate-100 px-5 py-3">
          <Skeleton className="h-3.5 w-20" />
        </div>
        <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="space-y-1">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-3.5 w-36" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Section card wrapper ─────────────────────────────────────────────────────

function SectionCard({
  title,
  children,
  'aria-label': ariaLabel,
}: {
  title: string;
  children: React.ReactNode;
  'aria-label'?: string;
}) {
  return (
    <section
      className="rounded-md border border-slate-200 bg-white shadow-xs overflow-hidden"
      aria-label={ariaLabel ?? title}
    >
      <div className="border-b border-slate-100 px-5 py-3">
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
      </div>
      {children}
    </section>
  );
}

// ─── B. Reservations section ──────────────────────────────────────────────────

function ReservationsSection({
  reservations,
}: {
  reservations: SerializedMyPortalSummary['reservations'];
}) {
  if (reservations.length === 0) {
    return (
      <div className="px-5 py-10 text-center">
        <p className="text-sm text-slate-400">No upcoming reservations.</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-slate-100" role="list">
      {reservations.map((r) => {
        const tailDisplay =
          r.resourceIds.length > 0 ? r.resourceIds.join(', ') : '—';
        return (
          <li
            key={r.id}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3"
          >
            {/* Start time */}
            <span className="nums text-sm text-slate-700 shrink-0">
              {formatLocalDateTime(r.startAt)}
            </span>
            <span className="text-xs text-slate-400" aria-hidden="true">
              →
            </span>
            {/* End time */}
            <span className="nums text-sm text-slate-700 shrink-0">
              {formatLocalDateTime(r.endAt)}
            </span>
            {/* Tail numbers / resource ids */}
            <span className="nums text-sm font-medium text-slate-900">
              {tailDisplay}
            </span>
            {/* Role chip */}
            <ReservationRoleChip role={r.role} />
          </li>
        );
      })}
    </ul>
  );
}

// ─── C. Training section ──────────────────────────────────────────────────────

function TrainingSection({
  training,
}: {
  training: SerializedMyPortalSummary['training'];
}) {
  return (
    <>
      {training.length === 0 ? (
        <div className="px-5 py-10 text-center">
          <p className="text-sm text-slate-400">Not enrolled in a course yet.</p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100" role="list">
          {training.map((e) => (
            <li key={e.enrollmentId} className="px-5 py-4 space-y-2">
              {/* Title + status pill */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-900">
                  {e.courseTitle}
                </span>
                <EnrollmentStatusPill status={e.status} />
              </div>

              {/* Progress bar + count */}
              <div className="flex items-center gap-3">
                <div
                  className="flex-1 h-1.5 rounded-full bg-slate-100"
                  role="progressbar"
                  aria-valuenow={e.progressRatio.percent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={`${e.courseTitle} progress: ${e.progressRatio.percent}%`}
                >
                  <div
                    className="h-1.5 rounded-full bg-brand"
                    style={{ width: `${e.progressRatio.percent}%` }}
                  />
                </div>
                <span className="nums text-xs text-slate-500 shrink-0 tabular-nums">
                  {e.completedCount}/{e.totalLessons}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {/* Verbatim [VERIFY-T1-B] footnote — required by spec */}
      <p className="px-5 pb-4 pt-2 text-[0.6875rem] text-slate-400">
        Progress reflects lessons recorded by your instructor — not a regulatory
        completion or graduation.
      </p>
    </>
  );
}

// ─── D. Account section ───────────────────────────────────────────────────────

function AccountSection({
  account,
}: {
  account: SerializedMyPortalSummary['account'];
}) {
  const roleLabel =
    ROLE_LABELS[account.role as keyof typeof ROLE_LABELS] ?? account.role;

  return (
    <div className="px-5 py-5 space-y-5">
      {/* Identity grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Name */}
        <div>
          <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500">
            Name
          </p>
          <p className="mt-0.5 text-sm text-slate-900">{account.displayName}</p>
        </div>

        {/* Email */}
        <div>
          <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500">
            Email
          </p>
          <p className="mt-0.5 text-sm text-slate-900 break-all">{account.email}</p>
        </div>

        {/* Phone */}
        <div>
          <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500">
            Phone
          </p>
          <p className="mt-0.5 text-sm text-slate-700">
            {account.phone !== null ? (
              account.phone
            ) : (
              <span className="text-slate-400">—</span>
            )}
          </p>
        </div>

        {/* Role */}
        <div>
          <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500">
            Role
          </p>
          <p className="mt-0.5 text-sm text-slate-700">{roleLabel}</p>
        </div>

        {/* Member since */}
        <div>
          <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500">
            Member since
          </p>
          <p className="mt-0.5 text-sm text-slate-700">
            {formatLocalDate(account.joinedAt)}
          </p>
        </div>
      </div>

      {/* Tags (read-only) [VERIFY-6-A]: free-text operator labels only */}
      <div>
        <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 mb-1.5">
          Tags
          <span className="ml-1 font-normal normal-case tracking-normal text-slate-400">
            (operator labels)
          </span>
        </p>
        {account.tags.length === 0 ? (
          <p className="text-sm text-slate-400">No tags assigned.</p>
        ) : (
          <ul
            className="flex flex-wrap gap-1.5"
            role="list"
            aria-label="Member tags"
          >
            {account.tags.map((t) => (
              <li key={t.id}>
                <span className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-700">
                  {t.tag}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ─── Portal content (A heading + B+C+D sections) ─────────────────────────────

interface PortalContentProps {
  slug: string;
}

async function PortalContent({ slug }: PortalContentProps) {
  const result = await getMyPortalSummaryAction();

  if ('error' in result) {
    const message =
      result.error === 'forbidden'
        ? 'You do not have access to the portal.'
        : result.error === 'unauthenticated'
          ? 'Your session has expired. Please sign in again.'
          : 'Could not load your portal data. Please try again.';

    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>{message}</span>
          <Link
            href={`/o/${slug}/portal`}
            className="text-sm underline underline-offset-2 hover:no-underline"
          >
            Retry
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  const { summary } = result;
  const firstName = deriveFirstName(summary.account.displayName);

  return (
    <div className="space-y-6">
      {/* ── A. Heading ─────────────────────────────────────────────────── */}
      <div>
        <h1 className="text-2xl font-bold tracking-tightish text-slate-900">
          Welcome, {firstName}
        </h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Your upcoming reservations, training progress, and account info.
        </p>
      </div>

      {/* ── B. My upcoming reservations ─────────────────────────────────── */}
      <SectionCard
        title="My upcoming reservations"
        aria-label="My upcoming reservations"
      >
        <ReservationsSection reservations={summary.reservations} />
      </SectionCard>

      {/* ── C. My training ────────────────────────────────────────────────── */}
      <SectionCard title="My training" aria-label="My training">
        <TrainingSection training={summary.training} />
      </SectionCard>

      {/* ── D. Account ────────────────────────────────────────────────────── */}
      <SectionCard title="Account" aria-label="My account">
        <AccountSection account={summary.account} />
      </SectionCard>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface PortalPageProps {
  params: Promise<{ slug: string }>;
}

export default async function PortalPage({ params }: PortalPageProps) {
  const { slug } = await params;
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

  return (
    // Suspense wraps A+B+C+D so the heading "Welcome, {firstName}" uses real data.
    <Suspense fallback={<PortalSkeleton />}>
      <PortalContent slug={slug} />
    </Suspense>
  );
}
