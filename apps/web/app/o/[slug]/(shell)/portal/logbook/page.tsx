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
import { AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability } from '@aeroops/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { getMyPilotLogAction, exportMyPilotLogCsvAction } from '../actions';
import type { SerializedPilotLog } from '../actions';
import { DownloadCsvButton } from './_components/download-csv-button';

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
      <div className="rounded-md border border-slate-200 bg-white shadow-xs overflow-hidden">
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
    <p className="text-[0.6875rem] text-slate-400">
      This logbook is a convenience view generated from your operator&rsquo;s dispatch
      records. It is not your official pilot logbook and is not a certified record
      under 14 CFR 61.51. AeroOps makes no determination of flight experience,
      currency, or recency under 14 CFR 61.51 or 61.57 — verifying and maintaining
      your logbook of record remains your responsibility.
    </p>
  );
}

// ─── Table ────────────────────────────────────────────────────────────────────

function LogbookTable({ log }: { log: SerializedPilotLog }) {
  if (log.entries.length === 0) {
    return (
      <div className="px-5 py-10 text-center">
        <p className="text-sm text-slate-400">No logged flights yet.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" aria-label="Pilot logbook">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-100">
            <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500">Date</th>
            <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500">Tail</th>
            <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500">Make / Model</th>
            <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500">Hobbs Out → In</th>
            <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500">Flight Time</th>
            <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500">Running Total</th>
          </tr>
        </thead>
        <tbody>
          {log.entries.map((e) => (
            <tr key={e.ticketId} className="border-b border-slate-100 last:border-0">
              <td className="px-3 py-2 text-xs text-slate-600 whitespace-nowrap">{formatLocalDate(e.date)}</td>
              <td className="px-3 py-2 text-sm font-medium text-slate-900 whitespace-nowrap">{e.tail}</td>
              <td className="px-3 py-2 text-xs text-slate-600 whitespace-nowrap">
                {e.make || e.model ? [e.make, e.model].filter(Boolean).join(' ') : <span className="text-slate-400">—</span>}
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                <span className="nums text-xs text-slate-700">
                  {e.hobbsOut.toFixed(1)} → {e.hobbsIn.toFixed(1)}
                </span>
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                <span className="nums text-xs text-slate-700">{e.flightTimeHours.toFixed(1)} h</span>
              </td>
              <td className="px-3 py-2 text-right whitespace-nowrap">
                <span className="nums text-xs font-semibold text-slate-900">{e.runningTotalHours.toFixed(1)} h</span>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-slate-200 bg-slate-50">
            <td colSpan={5} className="px-3 py-2 text-right text-xs font-semibold text-slate-600">Total</td>
            <td className="px-3 py-2 text-right">
              <span className="nums text-sm font-bold text-slate-900">{log.totalHours.toFixed(1)} h</span>
            </td>
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tightish text-slate-900">Logbook</h1>
          <p className="mt-0.5 text-sm text-slate-500">Your flight history from dispatch records.</p>
        </div>
        <DownloadCsvButton action={exportMyPilotLogCsvAction} />
      </div>

      <section
        className="rounded-md border border-slate-200 bg-white shadow-xs overflow-hidden"
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

  return (
    <Suspense fallback={<LogbookSkeleton />}>
      <LogbookContent slug={slug} />
    </Suspense>
  );
}
