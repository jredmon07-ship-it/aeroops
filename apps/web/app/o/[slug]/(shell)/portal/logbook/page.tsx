/**
 * portal/logbook/page.tsx — Pilot Logbook view in the student/renter portal
 * (Slice P2).
 *
 * Route: /o/[slug]/portal/logbook
 * Capability gate: portal:access (page-level requireCapability → redirect
 * /no-access on Forbidden — copies portal/page.tsx's gate block exactly).
 *
 * SELF-SCOPED: getMyPilotLogAction takes no userId — subject is ALWAYS
 * session.userId (the verified JWT subject). A portal user can never read
 * another member's logbook.
 *
 * COMPLIANCE HARD LINE — this is a CONVENIENCE VIEW derived from the
 * operator's dispatch history, NOT the pilot's official §61.51 logbook of
 * record. Verbatim disclaimer rendered below, ALWAYS visible (not gated
 * behind the empty state).
 *
 * States: loading (Suspense skeleton) / empty ("No logged flights yet.") /
 * populated (table, newest first, grand total) / error (destructive Alert +
 * Retry) / permission-denied (redirect). Primary action: Download CSV.
 *
 * BOUNDARY: imports ONLY from '@aeroops/api'-backed actions. Never '@aeroops/db'.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { AlertCircle, BookOpen } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, getOrgFeatures } from '@aeroops/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { getMyPilotLogAction, exportMyPilotLogCsvAction } from '../actions';
import type { SerializedPilotLog } from '@/lib/serialize-pilot-log';
import { DownloadCsvButton } from './_components/download-csv-button';
import { AnnotateFlightDialog } from './_components/annotate-flight-dialog';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';

// ─── Date helpers ──────────────────────────────────────────────────────────────

function formatLocalDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function LogbookSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading logbook">
      <Skeleton className="h-8 w-40" />
      <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden">
        <div className="p-5 space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Disclaimer (verbatim, always rendered) ────────────────────────────────────

function LogbookDisclaimer() {
  return (
    <p className="text-[0.6875rem] text-slate-400 dark:text-slate-500">
      This logbook is a convenience view generated from your operator&rsquo;s dispatch
      records. It is not your official pilot logbook and is not a certified record
      under 14 CFR 61.51. AeroOps makes no determination of flight experience,
      currency, or recency under 14 CFR 61.51 or 61.57 — verifying and maintaining
      your logbook of record remains your responsibility. Night, instrument,
      cross-country, remarks, and aircraft category/class are operator/pilot-entered
      data — not an FAA logbook of record; AeroOps does not compute currency.
    </p>
  );
}

// ─── Table ────────────────────────────────────────────────────────────────────

function LogbookTable({ log }: { log: SerializedPilotLog }) {
  if (log.entries.length === 0) {
    return (
      <EmptyState icon={BookOpen} title="No logged flights yet." className="py-10" />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" aria-label="Pilot logbook">
        <thead>
          <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-100 dark:border-slate-800">
            <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400">Date</th>
            <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400">Tail</th>
            <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400">Make / Model</th>
            <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400">Category / Class</th>
            <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400">Hobbs Out → In</th>
            <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400">Flight Time</th>
            <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400">Night</th>
            <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400">Instrument</th>
            <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400">XC</th>
            <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400">Running Total</th>
            <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400">Remarks</th>
            <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {log.entries.map((e) => (
            <tr key={e.ticketId} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
              <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300 nums whitespace-nowrap">{formatLocalDate(e.date)}</td>
              <td className="px-3 py-2 text-sm font-medium text-slate-900 dark:text-slate-100 whitespace-nowrap">{e.tail}</td>
              <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">
                {e.make || e.model ? [e.make, e.model].filter(Boolean).join(' ') : <span className="text-slate-400 dark:text-slate-500">—</span>}
              </td>
              <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap">
                {e.category || e.aircraftClass
                  ? [e.category, e.aircraftClass].filter(Boolean).join(' / ')
                  : <span className="text-slate-400 dark:text-slate-500">—</span>}
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                <span className="nums text-xs text-slate-700 dark:text-slate-300">
                  {e.hobbsOut.toFixed(1)} → {e.hobbsIn.toFixed(1)}
                </span>
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                <span className="nums text-xs text-slate-700 dark:text-slate-300">{e.flightTimeHours.toFixed(1)} h</span>
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                <span className="nums text-xs text-slate-700 dark:text-slate-300">
                  {e.nightHours != null ? `${e.nightHours.toFixed(1)} h` : '—'}
                </span>
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                <span className="nums text-xs text-slate-700 dark:text-slate-300">
                  {e.instrumentHours != null ? `${e.instrumentHours.toFixed(1)} h` : '—'}
                </span>
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                <span className="nums text-xs text-slate-700 dark:text-slate-300">
                  {e.crossCountryHours != null ? `${e.crossCountryHours.toFixed(1)} h` : '—'}
                </span>
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                <span className="nums text-xs font-semibold text-slate-900 dark:text-slate-100">{e.runningTotalHours.toFixed(1)} h</span>
              </td>
              <td className="px-3 py-2 text-xs text-slate-600 dark:text-slate-300 max-w-[16rem]">
                {e.remarks
                  ? <span className="line-clamp-2" title={e.remarks}>{e.remarks}</span>
                  : <span className="text-slate-400 dark:text-slate-500">—</span>}
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                <AnnotateFlightDialog
                  ticketId={e.ticketId}
                  tail={e.tail}
                  nightHours={e.nightHours}
                  instrumentHours={e.instrumentHours}
                  crossCountryHours={e.crossCountryHours}
                  remarks={e.remarks}
                />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800">
            <td colSpan={9} className="px-3 py-2 text-right text-xs font-semibold text-slate-600 dark:text-slate-300">Total</td>
            <td className="px-3 py-2 text-right">
              <span className="nums text-sm font-bold text-slate-900 dark:text-slate-100">{log.totalHours.toFixed(1)} h</span>
            </td>
            <td colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ─── Content ──────────────────────────────────────────────────────────────────

interface LogbookContentProps {
  slug: string;
}

async function LogbookContent({ slug }: LogbookContentProps) {
  const result = await getMyPilotLogAction();

  if ('error' in result) {
    const message =
      result.error === 'forbidden'
        ? 'You do not have access to the logbook.'
        : result.error === 'unauthenticated'
          ? 'Your session has expired. Please sign in again.'
          : 'Could not load your logbook. Please try again.';

    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>{message}</span>
          <Link
            href={`/o/${slug}/portal/logbook`}
            className="text-sm underline underline-offset-2 hover:no-underline"
          >
            Retry
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  const { log } = result;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Logbook"
        subtitle="Your flight history from dispatch records."
        actions={<DownloadCsvButton action={exportMyPilotLogCsvAction} />}
      />

      <section
        className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden"
        aria-label="Logbook entries"
      >
        <LogbookTable log={log} />
      </section>

      <LogbookDisclaimer />
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface LogbookPageProps {
  params: Promise<{ slug: string }>;
}

export default async function LogbookPage({ params }: LogbookPageProps) {
  const { slug } = await params;
  const session = await auth();

  if (!session) {
    redirect(`/o/${slug}/login`);
  }

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

  // ── Module gate (Slice CLUB-MODE) — fail-soft to enabled on read failure.
  // NOTE: redirect() must run OUTSIDE the try/catch — it throws to signal the
  // redirect, and a catch-all here would otherwise swallow that throw.
  let orgFeatures: Awaited<ReturnType<typeof getOrgFeatures>> | null = null;
  try {
    orgFeatures = await getOrgFeatures(session);
  } catch {
    orgFeatures = null;
  }
  if (orgFeatures && !orgFeatures.features.portal) {
    redirect(`/o/${slug}/no-access?reason=module_disabled`);
  }

  return (
    <Suspense fallback={<LogbookSkeleton />}>
      <LogbookContent slug={slug} />
    </Suspense>
  );
}
