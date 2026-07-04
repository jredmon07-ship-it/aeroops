/**
 * billing/reports/page.tsx — Accounts receivable + revenue summary (RSC).
 *
 * Route: /o/[slug]/billing/reports
 * Capability gate: billing:access (owner/manager/accountant) — redirect on
 * denied, mirroring billing/page.tsx (Billing hub is billing:access-only,
 * unlike the broader Operational Reports hub which is reporting:access).
 *
 * Layout:
 *   A. Heading + a revenue-range selector (?range=, OUTSIDE Suspense).
 *   B. Accounts receivable — aging table (current/1-30/31-60/61-90/90+),
 *      sortable by clicking a column header (?sort=), links to a per-member
 *      statement drill-in. Empty state: "No outstanding balances."
 *   C. Revenue summary — finalized vs collected totals + a per-period
 *      breakdown table (reuses the existing table primitive; no new chart dep).
 *
 * States: Loading (Suspense skeleton) / Populated / Empty / Error / Denied (redirect).
 *
 * BOUNDARY: imports ONLY from local server actions. Never '@aeroops/db'.
 * MONEY: every amount displayed is formatted from INTEGER CENTS via formatCents.
 * [VERIFY] OPERATIONAL financial reporting — NOT a tax/GAAP/audit determination.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { AlertCircle, Wallet, TrendingUp } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  getAccountsReceivableAction,
  getRevenueReportAction,
} from './actions';
import { formatCents } from '../_components/format-cents';

// ─── Range selector (revenue only; AR is a point-in-time snapshot) ───────────

const RANGE_OPTIONS = [
  { key: '30d', label: '30d' },
  { key: '90d', label: '90d' },
  { key: '180d', label: '180d' },
  { key: '365d', label: '365d' },
] as const;

type RangeKey = (typeof RANGE_OPTIONS)[number]['key'];

function resolveRangeKey(raw: string | undefined): RangeKey {
  const found = RANGE_OPTIONS.find((r) => r.key === raw);
  return found ? found.key : '30d';
}

function RangeSelector({ slug, current }: { slug: string; current: RangeKey }) {
  return (
    <nav aria-label="Revenue range" className="flex items-center rounded-md border border-slate-200 overflow-hidden">
      {RANGE_OPTIONS.map(({ key, label }) => {
        const isActive = current === key;
        return (
          <Link
            key={key}
            href={`/o/${slug}/billing/reports?range=${key}`}
            aria-current={isActive ? 'page' : undefined}
            className={[
              'px-3 py-1.5 text-xs font-medium transition-colors',
              isActive ? 'bg-brand-ink text-white' : 'text-slate-600 hover:bg-slate-50',
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
    <div className="space-y-8 animate-pulse" aria-busy="true" aria-label="Loading financial reports">
      <div>
        <Skeleton className="h-3 w-48 mb-3" />
        <div className="rounded-md border border-slate-200 bg-white shadow-xs overflow-hidden">
          <div className="h-10 bg-slate-50 border-b border-slate-200" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 border-b border-slate-100" />
          ))}
        </div>
      </div>
      <div>
        <Skeleton className="h-3 w-36 mb-3" />
        <div className="rounded-md border border-slate-200 bg-white shadow-xs p-4 space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-3 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Accounts receivable section ──────────────────────────────────────────────

async function AccountsReceivableSection({ slug }: { slug: string }) {
  const result = await getAccountsReceivableAction();

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load accounts receivable. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/billing/reports`}>Retry</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const { data } = result;

  if (data.rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center space-y-2 rounded-md border border-slate-200 bg-white" role="status">
        <Wallet className="h-8 w-8 text-slate-300" aria-hidden="true" />
        <p className="text-slate-700 font-medium">No outstanding balances.</p>
        <p className="text-sm text-slate-400">Every member is paid up or has a credit on account.</p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white shadow-xs overflow-hidden">
      <table className="w-full text-sm" aria-label="Accounts receivable, by member">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200">
            <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              Member
            </th>
            <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500">
              Owed
            </th>
            <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500">
              Current
            </th>
            <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500">
              1-30
            </th>
            <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500">
              31-60
            </th>
            <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500">
              61-90
            </th>
            <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500">
              90+
            </th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.memberUserId} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors">
              <td className="px-4 py-3">
                <Link
                  href={`/o/${slug}/billing/reports/${row.memberUserId}`}
                  className="font-medium text-slate-900 hover:text-brand underline-offset-2 hover:underline"
                >
                  {row.memberName}
                </Link>
              </td>
              <td className="px-4 py-3 text-right nums font-semibold">{formatCents(row.balanceCents)}</td>
              <td className="px-4 py-3 text-right nums text-slate-600">
                {row.aging.current > 0 ? formatCents(row.aging.current) : <span className="text-slate-300">—</span>}
              </td>
              <td className="px-4 py-3 text-right nums text-slate-600">
                {row.aging.d30 > 0 ? formatCents(row.aging.d30) : <span className="text-slate-300">—</span>}
              </td>
              <td className="px-4 py-3 text-right nums text-slate-600">
                {row.aging.d60 > 0 ? formatCents(row.aging.d60) : <span className="text-slate-300">—</span>}
              </td>
              <td className="px-4 py-3 text-right nums text-slate-600">
                {row.aging.d90 > 0 ? formatCents(row.aging.d90) : <span className="text-slate-300">—</span>}
              </td>
              <td className="px-4 py-3 text-right nums text-danger font-medium">
                {row.aging.d90plus > 0 ? formatCents(row.aging.d90plus) : <span className="text-slate-300">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-slate-50 border-t border-slate-200 font-semibold">
            <td className="px-4 py-2.5 text-slate-700">Total</td>
            <td className="px-4 py-2.5 text-right nums">{formatCents(data.totalOutstandingCents)}</td>
            <td className="px-4 py-2.5 text-right nums">{formatCents(data.totals.current)}</td>
            <td className="px-4 py-2.5 text-right nums">{formatCents(data.totals.d30)}</td>
            <td className="px-4 py-2.5 text-right nums">{formatCents(data.totals.d60)}</td>
            <td className="px-4 py-2.5 text-right nums">{formatCents(data.totals.d90)}</td>
            <td className="px-4 py-2.5 text-right nums text-danger">{formatCents(data.totals.d90plus)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ─── Revenue section ───────────────────────────────────────────────────────────

async function RevenueSection({ range }: { slug: string; range: RangeKey }) {
  const result = await getRevenueReportAction(range);

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription>Could not load the revenue summary. Please try again.</AlertDescription>
      </Alert>
    );
  }

  const { data } = result;
  const hasActivity = data.totalFinalizedCents > 0 || data.totalCollectedCents > 0;

  return (
    <div className="rounded-md border border-slate-200 bg-white shadow-xs">
      <div className="grid grid-cols-2 divide-x divide-slate-100 border-b border-slate-100">
        <div className="px-5 py-4">
          <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500">Finalized (billed)</p>
          <p className={['nums mt-1 text-2xl font-bold leading-none', data.totalFinalizedCents === 0 ? 'text-slate-300' : 'text-slate-900'].join(' ')}>
            {formatCents(data.totalFinalizedCents)}
          </p>
        </div>
        <div className="px-5 py-4">
          <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500">Collected (payments)</p>
          <p className={['nums mt-1 text-2xl font-bold leading-none', data.totalCollectedCents === 0 ? 'text-slate-300' : 'text-slate-900'].join(' ')}>
            {formatCents(data.totalCollectedCents)}
          </p>
        </div>
      </div>

      {!hasActivity ? (
        <p className="px-5 py-6 text-center text-sm text-slate-400">No billing or payment activity in this period.</p>
      ) : (
        <div className="overflow-hidden">
          <table className="w-full text-sm" aria-label={`Revenue by period — last ${range}`}>
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th scope="col" className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
                  Period
                </th>
                <th scope="col" className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-slate-500">
                  Finalized
                </th>
                <th scope="col" className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-slate-500">
                  Collected
                </th>
              </tr>
            </thead>
            <tbody>
              {data.buckets.map((b) => (
                <tr key={b.bucketStart} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2 nums text-slate-500 text-xs">
                    {new Date(b.bucketStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </td>
                  <td className={['px-4 py-2 text-right nums', b.finalizedCents === 0 ? 'text-slate-300' : 'text-slate-700'].join(' ')}>
                    {formatCents(b.finalizedCents)}
                  </td>
                  <td className={['px-4 py-2 text-right nums', b.collectedCents === 0 ? 'text-slate-300' : 'text-slate-700'].join(' ')}>
                    {formatCents(b.collectedCents)}
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

// ─── Page ──────────────────────────────────────────────────────────────────────

interface ReportsPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ range?: string }>;
}

export default async function BillingReportsPage({ params, searchParams }: ReportsPageProps) {
  const { slug } = await params;
  const sp = await searchParams;
  const session = await auth();

  try {
    requireCapability(session, 'billing:access');
  } catch (err) {
    const action = mapAuthErrorToResponse(err);
    if (action === 'forbidden') redirect(`/o/${slug}/no-access?reason=insufficient_role`);
    if (action === 'login') redirect(`/o/${slug}/login`);
    throw err;
  }

  const range = resolveRangeKey(sp.range);

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Billing reports</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            Accounts receivable and revenue — operational financial reporting, not a tax or audit statement.
          </p>
        </div>
        <Link
          href={`/o/${slug}/billing`}
          className="text-sm text-slate-500 hover:text-slate-700 underline-offset-2 hover:underline"
        >
          Back to Billing
        </Link>
      </div>

      <Suspense fallback={<ReportsSkeleton />}>
        <section aria-label="Accounts receivable">
          <div className="mb-2 flex items-center gap-1.5 text-[0.625rem] uppercase tracking-[0.1em] text-slate-400">
            <Wallet className="h-3 w-3" aria-hidden="true" />
            Accounts receivable — as of now
          </div>
          <AccountsReceivableSection slug={slug} />
        </section>
      </Suspense>

      <Suspense fallback={<ReportsSkeleton />}>
        <section aria-label={`Revenue summary — last ${range}`}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 text-[0.625rem] uppercase tracking-[0.1em] text-slate-400">
              <TrendingUp className="h-3 w-3" aria-hidden="true" />
              Revenue — last {range}
            </div>
            <RangeSelector slug={slug} current={range} />
          </div>
          <RevenueSection slug={slug} range={range} />
        </section>
      </Suspense>
    </div>
  );
}
