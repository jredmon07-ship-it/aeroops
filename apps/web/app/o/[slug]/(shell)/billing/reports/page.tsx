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
import { AlertCircle, Wallet, TrendingUp, ShoppingBag, Banknote, Scale, Receipt } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  getAccountsReceivableAction,
  getRevenueReportAction,
  getItemsSoldReportAction,
  getPaymentsReportAction,
  getAdjustmentsReportAction,
  getTaxesOwedReportAction,
} from './actions';
import { formatCents } from '../_components/format-cents';
import { PageHeader } from '@/components/ui/page-header';
import { SectionHeader } from '@/components/ui/section-header';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusBadge } from '@/components/ui/status-badge';
import { ExportCsvButton } from '@/components/ui/export-csv-button';
import { centsToAmount, csvDate, csvFilename } from '@/lib/csv-format';

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
    <nav aria-label="Revenue range" className="flex items-center rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
      {RANGE_OPTIONS.map(({ key, label }) => {
        const isActive = current === key;
        return (
          <Link
            key={key}
            href={`/o/${slug}/billing/reports?range=${key}`}
            aria-current={isActive ? 'page' : undefined}
            className={[
              'px-3 py-1.5 text-xs font-medium transition-colors',
              isActive ? 'bg-brand-ink text-white' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
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
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden">
          <div className="h-10 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800" />
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 border-b border-slate-100 dark:border-slate-800" />
          ))}
        </div>
      </div>
      <div>
        <Skeleton className="h-3 w-36 mb-3" />
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs p-4 space-y-3">
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
      <div className="flex flex-col items-center justify-center py-12 text-center space-y-2 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900" role="status">
        <Wallet className="h-8 w-8 text-slate-300" aria-hidden="true" />
        <p className="text-slate-700 dark:text-slate-300 font-medium">No outstanding balances.</p>
        <p className="text-sm text-slate-400 dark:text-slate-500">Every member is paid up or has a credit on account.</p>
      </div>
    );
  }

  const csvRows: string[][] = [
    ['Member', 'Owed', 'Current', '1-30', '31-60', '61-90', '90+'],
    ...data.rows.map((r) => [
      r.memberName,
      centsToAmount(r.balanceCents),
      centsToAmount(r.aging.current),
      centsToAmount(r.aging.d30),
      centsToAmount(r.aging.d60),
      centsToAmount(r.aging.d90),
      centsToAmount(r.aging.d90plus),
    ]),
  ];

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <ExportCsvButton rows={csvRows} filename={csvFilename('accounts-receivable')} />
      </div>
      <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-x-auto">
      <table className="w-full text-sm" aria-label="Accounts receivable, by member">
        <thead>
          <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
            <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Member
            </th>
            <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Owed
            </th>
            <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Current
            </th>
            <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              1-30
            </th>
            <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              31-60
            </th>
            <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              61-90
            </th>
            <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              90+
            </th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.memberUserId} className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
              <td className="px-4 py-3">
                <Link
                  href={`/o/${slug}/billing/reports/${row.memberUserId}`}
                  className="font-medium text-slate-900 dark:text-slate-100 hover:text-brand underline-offset-2 hover:underline"
                >
                  {row.memberName}
                </Link>
              </td>
              <td className="px-4 py-3 text-right nums font-semibold">{formatCents(row.balanceCents)}</td>
              <td className="px-4 py-3 text-right nums text-slate-600 dark:text-slate-300">
                {row.aging.current > 0 ? formatCents(row.aging.current) : <span className="text-slate-300">—</span>}
              </td>
              <td className="px-4 py-3 text-right nums text-slate-600 dark:text-slate-300">
                {row.aging.d30 > 0 ? formatCents(row.aging.d30) : <span className="text-slate-300">—</span>}
              </td>
              <td className="px-4 py-3 text-right nums text-slate-600 dark:text-slate-300">
                {row.aging.d60 > 0 ? formatCents(row.aging.d60) : <span className="text-slate-300">—</span>}
              </td>
              <td className="px-4 py-3 text-right nums text-slate-600 dark:text-slate-300">
                {row.aging.d90 > 0 ? formatCents(row.aging.d90) : <span className="text-slate-300">—</span>}
              </td>
              <td className="px-4 py-3 text-right nums text-danger font-medium">
                {row.aging.d90plus > 0 ? formatCents(row.aging.d90plus) : <span className="text-slate-300">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bg-slate-50 dark:bg-slate-800 border-t border-slate-200 dark:border-slate-800 font-semibold">
            <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300">Total</td>
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

  const csvRows: string[][] = [
    ['Period', 'Finalized', 'Collected'],
    ...data.buckets.map((b) => [
      csvDate(b.bucketStart),
      centsToAmount(b.finalizedCents),
      centsToAmount(b.collectedCents),
    ]),
  ];

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <ExportCsvButton rows={csvRows} filename={csvFilename('revenue')} disabled={!hasActivity} />
      </div>
      <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
      <div className="grid grid-cols-2 divide-x divide-slate-100 dark:divide-slate-800 border-b border-slate-100 dark:border-slate-800">
        <div className="px-5 py-4">
          <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Finalized (billed)</p>
          <p className={['nums mt-1 text-2xl font-bold leading-none', data.totalFinalizedCents === 0 ? 'text-slate-300' : 'text-slate-900 dark:text-slate-100'].join(' ')}>
            {formatCents(data.totalFinalizedCents)}
          </p>
        </div>
        <div className="px-5 py-4">
          <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Collected (payments)</p>
          <p className={['nums mt-1 text-2xl font-bold leading-none', data.totalCollectedCents === 0 ? 'text-slate-300' : 'text-slate-900 dark:text-slate-100'].join(' ')}>
            {formatCents(data.totalCollectedCents)}
          </p>
        </div>
      </div>

      {!hasActivity ? (
        <p className="px-5 py-6 text-center text-sm text-slate-400 dark:text-slate-500">No billing or payment activity in this period.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label={`Revenue by period — last ${range}`}>
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
                <th scope="col" className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Period
                </th>
                <th scope="col" className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Finalized
                </th>
                <th scope="col" className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  Collected
                </th>
              </tr>
            </thead>
            <tbody>
              {data.buckets.map((b) => (
                <tr key={b.bucketStart} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                  <td className="px-4 py-2 nums text-slate-500 dark:text-slate-400 text-xs">
                    {new Date(b.bucketStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </td>
                  <td className={['px-4 py-2 text-right nums', b.finalizedCents === 0 ? 'text-slate-300' : 'text-slate-700 dark:text-slate-300'].join(' ')}>
                    {formatCents(b.finalizedCents)}
                  </td>
                  <td className={['px-4 py-2 text-right nums', b.collectedCents === 0 ? 'text-slate-300' : 'text-slate-700 dark:text-slate-300'].join(' ')}>
                    {formatCents(b.collectedCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </div>
    </div>
  );
}

// ─── Items sold section (POS) ──────────────────────────────────────────────────

async function ItemsSoldSection({ range }: { slug: string; range: RangeKey }) {
  const result = await getItemsSoldReportAction(range);

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription>Could not load the items-sold report. Please try again.</AlertDescription>
      </Alert>
    );
  }

  const { data } = result;
  const hasSales = data.totalQtySold > 0 || data.totalGrossCents > 0;

  const csvRows: string[][] = [
    ['Product', 'SKU', 'Qty sold', 'Gross', 'Tax'],
    ...data.rows.map((row) => [
      row.productName,
      row.sku ?? '',
      String(row.qtySold),
      centsToAmount(row.grossCents),
      centsToAmount(row.taxCents),
    ]),
  ];

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <ExportCsvButton rows={csvRows} filename={csvFilename('items-sold')} disabled={data.rows.length === 0} />
      </div>
      <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-x-auto">
      {data.rows.length === 0 ? (
        <EmptyState
          icon={ShoppingBag}
          title="No products in the catalog yet."
          body="Counter-sale products appear here with units sold and gross revenue."
          className="py-10"
        />
      ) : (
        <table className="w-full text-sm" aria-label={`Items sold — last ${range}`}>
          <thead>
            <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
              <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Product
              </th>
              <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Qty sold
              </th>
              <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Gross
              </th>
              <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Tax
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row) => (
              <tr key={row.productId} className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                <td className="px-4 py-3">
                  <span className="font-medium text-slate-900 dark:text-slate-100">{row.productName}</span>
                  {row.sku && <span className="ml-2 text-xs text-slate-400 dark:text-slate-500 nums">{row.sku}</span>}
                </td>
                <td className={['px-4 py-3 text-right nums', row.qtySold === 0 ? 'text-slate-300' : 'text-slate-700 dark:text-slate-300'].join(' ')}>
                  {row.qtySold}
                </td>
                <td className={['px-4 py-3 text-right nums font-medium', row.grossCents === 0 ? 'text-slate-300' : 'text-slate-900 dark:text-slate-100'].join(' ')}>
                  {formatCents(row.grossCents)}
                </td>
                <td className="px-4 py-3 text-right nums text-slate-300">
                  {formatCents(row.taxCents)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-slate-50 dark:bg-slate-800 border-t border-slate-200 dark:border-slate-800 font-semibold">
              <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300">Total</td>
              <td className="px-4 py-2.5 text-right nums">{data.totalQtySold}</td>
              <td className="px-4 py-2.5 text-right nums">{formatCents(data.totalGrossCents)}</td>
              <td className="px-4 py-2.5 text-right nums text-slate-400 dark:text-slate-500">{formatCents(data.totalTaxCents)}</td>
            </tr>
          </tfoot>
        </table>
      )}
      {data.rows.length > 0 && !hasSales && (
        <p className="px-4 py-3 text-xs text-slate-400 dark:text-slate-500">No counter-sale activity in this period. Try a wider range.</p>
      )}
      </div>
    </div>
  );
}

// ─── Payments section ───────────────────────────────────────────────────────────

async function PaymentsSection({ range }: { slug: string; range: RangeKey }) {
  const result = await getPaymentsReportAction(range);

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription>Could not load the payments report. Please try again.</AlertDescription>
      </Alert>
    );
  }

  const { data } = result;

  const csvRows: string[][] = [
    ['Date', 'Member', 'Amount', 'Reference'],
    ...data.rows.map((r) => [
      csvDate(r.createdAt),
      r.memberName,
      centsToAmount(r.amountCents),
      r.paymentId ?? r.memo ?? '',
    ]),
  ];

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <ExportCsvButton rows={csvRows} filename={csvFilename('payments')} disabled={data.rows.length === 0} />
      </div>
      <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-x-auto">
        {data.rows.length === 0 ? (
          <EmptyState
            icon={Banknote}
            title="No payments in this period."
            body="Recorded payments appear here with the member, amount, and reference."
            className="py-10"
          />
        ) : (
          <table className="w-full text-sm" aria-label={`Payments — last ${range}`}>
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
                <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Date</th>
                <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Member</th>
                <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Amount</th>
                <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Reference</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.entryId} className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                  <td className="px-4 py-3 nums text-slate-500 dark:text-slate-400 text-xs">
                    {new Date(r.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  </td>
                  <td className="px-4 py-3 text-slate-900 dark:text-slate-100">{r.memberName}</td>
                  <td className="px-4 py-3 text-right nums font-medium text-success">{formatCents(r.amountCents)}</td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400 text-xs">
                    {r.paymentId ?? r.memo ?? <span className="text-slate-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-slate-50 dark:bg-slate-800 border-t border-slate-200 dark:border-slate-800 font-semibold">
                <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300" colSpan={2}>Total — {data.paymentCount} payment{data.paymentCount === 1 ? '' : 's'}</td>
                <td className="px-4 py-2.5 text-right nums">{formatCents(data.totalPaymentCents)}</td>
                <td className="px-4 py-2.5" />
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Adjustments section ────────────────────────────────────────────────────────

async function AdjustmentsSection({ range }: { slug: string; range: RangeKey }) {
  const result = await getAdjustmentsReportAction(range);

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription>Could not load the adjustments report. Please try again.</AlertDescription>
      </Alert>
    );
  }

  const { data } = result;

  const typeLabel = (t: 'credit_memo' | 'adjustment') => (t === 'credit_memo' ? 'Credit memo' : 'Adjustment');

  const csvRows: string[][] = [
    ['Date', 'Member', 'Type', 'Direction', 'Amount', 'Memo', 'Posted by'],
    ...data.rows.map((r) => [
      csvDate(r.createdAt),
      r.memberName,
      typeLabel(r.entryType),
      r.direction,
      centsToAmount(r.amountCents),
      r.memo ?? '',
      r.createdByName ?? 'System',
    ]),
  ];

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <ExportCsvButton rows={csvRows} filename={csvFilename('adjustments')} disabled={data.rows.length === 0} />
      </div>
      <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-x-auto">
        {data.rows.length === 0 ? (
          <EmptyState
            icon={Scale}
            title="No corrections in this period."
            body="Credit memos and manual adjustments appear here with the reason and who posted them."
            className="py-10"
          />
        ) : (
          <table className="w-full text-sm" aria-label={`Adjustments — last ${range}`}>
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
                <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Date</th>
                <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Member</th>
                <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Type</th>
                <th scope="col" className="px-4 py-2.5 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Amount</th>
                <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Memo</th>
                <th scope="col" className="px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Posted by</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.entryId} className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                  <td className="px-4 py-3 nums text-slate-500 dark:text-slate-400 text-xs">
                    {new Date(r.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                  </td>
                  <td className="px-4 py-3 text-slate-900 dark:text-slate-100">{r.memberName}</td>
                  <td className="px-4 py-3">
                    <StatusBadge variant={r.entryType === 'credit_memo' ? 'info' : 'neutral'}>
                      {typeLabel(r.entryType)}
                    </StatusBadge>
                  </td>
                  <td className={['px-4 py-3 text-right nums font-medium', r.direction === 'credit' ? 'text-success' : 'text-danger'].join(' ')}>
                    {r.direction === 'credit' ? '+' : '−'}{formatCents(r.amountCents)}
                  </td>
                  <td className="px-4 py-3 text-slate-600 dark:text-slate-300 text-xs max-w-xs truncate" title={r.memo ?? undefined}>
                    {r.memo ?? <span className="text-slate-300">—</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-500 dark:text-slate-400 text-xs">{r.createdByName ?? 'System'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-slate-50 dark:bg-slate-800 border-t border-slate-200 dark:border-slate-800 font-semibold">
                <td className="px-4 py-2.5 text-slate-700 dark:text-slate-300" colSpan={3}>Totals — {data.count} correction{data.count === 1 ? '' : 's'}</td>
                <td className="px-4 py-2.5 text-right nums">
                  <span className="text-success">+{formatCents(data.totalCreditCents)}</span>
                  {' / '}
                  <span className="text-danger">−{formatCents(data.totalDebitCents)}</span>
                </td>
                <td className="px-4 py-2.5" colSpan={2} />
              </tr>
            </tfoot>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Taxes-owed section (POS) ───────────────────────────────────────────────────

async function TaxesOwedSection({ range }: { slug: string; range: RangeKey }) {
  const result = await getTaxesOwedReportAction(range);

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription>Could not load the taxes report. Please try again.</AlertDescription>
      </Alert>
    );
  }

  const { data } = result;
  const hasBase = data.totalTaxableGrossCents > 0;

  const csvRows: string[][] = [
    ['Period', 'Taxable POS base', 'Tax collected'],
    ...data.buckets.map((b) => [
      csvDate(b.bucketStart),
      centsToAmount(b.taxableGrossCents),
      centsToAmount(b.taxCents),
    ]),
  ];

  return (
    <div className="space-y-2">
      <div className="flex justify-end">
        <ExportCsvButton rows={csvRows} filename={csvFilename('taxes-owed')} disabled={!hasBase} />
      </div>
      <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
        <div className="grid grid-cols-2 divide-x divide-slate-100 dark:divide-slate-800 border-b border-slate-100 dark:border-slate-800">
          <div className="px-5 py-4">
            <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Taxable POS base</p>
            <p className={['nums mt-1 text-2xl font-bold leading-none', !hasBase ? 'text-slate-300' : 'text-slate-900 dark:text-slate-100'].join(' ')}>
              {formatCents(data.totalTaxableGrossCents)}
            </p>
          </div>
          <div className="px-5 py-4">
            <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Tax collected</p>
            <p className="nums mt-1 text-2xl font-bold leading-none text-slate-300">{formatCents(data.totalTaxCents)}</p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label={`Taxes — last ${range}`}>
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
                <th scope="col" className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Period</th>
                <th scope="col" className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Taxable base</th>
                <th scope="col" className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">Tax</th>
              </tr>
            </thead>
            <tbody>
              {data.buckets.map((b) => (
                <tr key={b.bucketStart} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                  <td className="px-4 py-2 nums text-slate-500 dark:text-slate-400 text-xs">
                    {new Date(b.bucketStart).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </td>
                  <td className={['px-4 py-2 text-right nums', b.taxableGrossCents === 0 ? 'text-slate-300' : 'text-slate-700 dark:text-slate-300'].join(' ')}>
                    {formatCents(b.taxableGrossCents)}
                  </td>
                  <td className="px-4 py-2 text-right nums text-slate-300">{formatCents(b.taxCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
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
      <PageHeader
        title="Billing reports"
        subtitle="Accounts receivable and revenue — operational financial reporting, not a tax or audit statement."
        actions={
          <Link
            href={`/o/${slug}/billing`}
            className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 underline-offset-2 hover:underline"
          >
            Back to Billing
          </Link>
        }
      />

      <Suspense fallback={<ReportsSkeleton />}>
        <section aria-label="Accounts receivable">
          <div className="mb-2 flex items-center gap-1.5 text-[0.625rem] uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500">
            <Wallet className="h-3 w-3" aria-hidden="true" />
            Accounts receivable — as of now
          </div>
          <AccountsReceivableSection slug={slug} />
        </section>
      </Suspense>

      <Suspense fallback={<ReportsSkeleton />}>
        <section aria-label={`Revenue summary — last ${range}`}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 text-[0.625rem] uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500">
              <TrendingUp className="h-3 w-3" aria-hidden="true" />
              Revenue — last {range}
            </div>
            <RangeSelector slug={slug} current={range} />
          </div>
          <RevenueSection slug={slug} range={range} />
        </section>
      </Suspense>

      <Suspense fallback={<ReportsSkeleton />}>
        <section aria-label={`Items sold — last ${range}`}>
          <SectionHeader
            eyebrow={
              <span className="inline-flex items-center gap-1.5">
                <ShoppingBag className="h-3 w-3" aria-hidden="true" />
                Items sold (POS) — last {range}
              </span>
            }
          />
          <ItemsSoldSection slug={slug} range={range} />
          <p className="mt-1.5 text-[0.6875rem] text-slate-400 dark:text-slate-500">
            Units sold and gross revenue from finalized counter sales. Tax is not
            yet modeled in point-of-sale — sales-tax collection is a deferred item.
          </p>
        </section>
      </Suspense>

      <Suspense fallback={<ReportsSkeleton />}>
        <section aria-label={`Payments — last ${range}`}>
          <SectionHeader
            eyebrow={
              <span className="inline-flex items-center gap-1.5">
                <Banknote className="h-3 w-3" aria-hidden="true" />
                Payments — last {range}
              </span>
            }
          />
          <PaymentsSection slug={slug} range={range} />
        </section>
      </Suspense>

      <Suspense fallback={<ReportsSkeleton />}>
        <section aria-label={`Adjustments &amp; credit memos — last ${range}`}>
          <SectionHeader
            eyebrow={
              <span className="inline-flex items-center gap-1.5">
                <Scale className="h-3 w-3" aria-hidden="true" />
                Adjustments &amp; credit memos — last {range}
              </span>
            }
          />
          <AdjustmentsSection slug={slug} range={range} />
        </section>
      </Suspense>

      <Suspense fallback={<ReportsSkeleton />}>
        <section aria-label={`Taxes owed — last ${range}`}>
          <SectionHeader
            eyebrow={
              <span className="inline-flex items-center gap-1.5">
                <Receipt className="h-3 w-3" aria-hidden="true" />
                Taxes owed (POS) — last {range}
              </span>
            }
          />
          <TaxesOwedSection slug={slug} range={range} />
          <p className="mt-1.5 text-[0.6875rem] text-slate-400 dark:text-slate-500">
            Scoped to point-of-sale activity. Sales tax is not yet modeled in the
            schema, so tax collected is reported as $0.00 over the taxable POS
            base — sales-tax collection and remittance is a deferred item.
          </p>
        </section>
      </Suspense>
    </div>
  );
}
