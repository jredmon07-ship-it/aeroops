/**
 * billing/page.tsx — Invoice list (RSC).
 *
 * Route: /o/[slug]/billing
 * Capability gate: billing:access (owner/manager/accountant).
 *
 * States:
 *   Loading   — Suspense skeleton.
 *   Populated — invoice rows (status badge, total, created date), links to detail.
 *   Empty     — "No invoices yet".
 *   Error     — destructive Alert + Retry.
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 *
 * MONEY: totals displayed are read-only integer cents formatted as dollars.
 * NO Stripe, NO card/bank data.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Receipt, AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { PageHeader } from '@/components/ui/page-header';
import { SectionHeader } from '@/components/ui/section-header';
import { EmptyState } from '@/components/ui/empty-state';
import {
  listInvoicesAction,
  listInvoiceableDispatchAction,
  listRatePickerAction,
  listInvoiceQboStatusesAction,
} from './actions';
import { getAccountsReceivableAction, getRevenueReportAction } from './reports/actions';
import { formatCents } from './_components/format-cents';
import { ReadyToInvoiceClient } from './_components/ready-to-invoice-client';
import { QboExportBadge } from './_components/qbo-export-badge';
import type { QboInvoiceExportStatus } from './_components/qbo-export-badge';

// ─── Loading skeleton ──────────────────────────────────────────────────────────

function InvoiceListSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading invoices">
      <Skeleton className="h-8 w-40" />
      <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="h-10 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-14 border-b border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900" />
        ))}
      </div>
    </div>
  );
}

// ─── Inner async content ───────────────────────────────────────────────────────

async function InvoiceListContent({ slug }: { slug: string }) {
  const result = await listInvoicesAction();

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load invoices. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/billing`}>Retry</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (result.invoices.length === 0) {
    return (
      <EmptyState
        icon={Receipt}
        title="No invoices yet."
        body="Generate a draft invoice from a closed dispatch ticket to get started."
      />
    );
  }

  // Best-effort QBO export state for the finalized rows (Slice QBO-SYNC). The
  // column only appears once at least one invoice has an export-log entry, so
  // an operator who never touched QuickBooks sees no extra noise. A failure
  // here just hides the column — it never blocks the list.
  const finalizedIds = result.invoices
    .filter((inv) => inv.status === 'finalized')
    .map((inv) => inv.id)
    .slice(0, 200);
  const qboStatusById = new Map<string, QboInvoiceExportStatus>();
  if (finalizedIds.length > 0) {
    const qboResult = await listInvoiceQboStatusesAction(finalizedIds);
    if ('ok' in qboResult && qboResult.ok) {
      for (const s of qboResult.statuses) qboStatusById.set(s.invoiceId, s.status);
    }
  }
  const showQboColumn = Array.from(qboStatusById.values()).some((s) => s !== 'not_exported');

  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
      <table className="w-full text-sm" aria-label="Invoices">
        <thead>
          <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
            <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Status
            </th>
            <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Total
            </th>
            <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide hidden sm:table-cell">
              Created
            </th>
            {showQboColumn && (
              <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide hidden md:table-cell">
                QuickBooks
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {result.invoices.map((inv) => (
            <tr key={inv.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
              <td className="px-3 py-3">
                <Link href={`/o/${slug}/billing/${inv.id}`} className="flex items-center gap-2">
                  <InvoiceStatusBadge status={inv.status} />
                </Link>
              </td>
              <td className="px-3 py-3 text-right nums">
                <Link href={`/o/${slug}/billing/${inv.id}`}>{formatCents(inv.totalCents)}</Link>
              </td>
              <td className="px-3 py-3 text-xs text-slate-500 dark:text-slate-400 hidden sm:table-cell nums">
                <Link href={`/o/${slug}/billing/${inv.id}`}>{new Date(inv.createdAt).toLocaleDateString()}</Link>
              </td>
              {showQboColumn && (
                <td className="px-3 py-3 hidden md:table-cell">
                  {inv.status === 'finalized' && (
                    <Link href={`/o/${slug}/billing/${inv.id}`}>
                      <QboExportBadge status={qboStatusById.get(inv.id) ?? 'not_exported'} />
                    </Link>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Flights ready to invoice (billing:manage) ──────────────────────────────────

async function ReadyToInvoiceContent({ slug }: { slug: string }) {
  const [worklist, ratePicker] = await Promise.all([
    listInvoiceableDispatchAction(),
    listRatePickerAction(),
  ]);

  if ('error' in worklist || 'error' in ratePicker) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription>Could not load flights ready to invoice.</AlertDescription>
      </Alert>
    );
  }

  // Nothing waiting — keep the section quiet rather than showing an empty table.
  if (worklist.rows.length === 0) return null;

  return (
    <section className="space-y-3" aria-labelledby="ready-to-invoice-heading">
      <div>
        <h2 id="ready-to-invoice-heading" className="text-lg font-semibold text-slate-900 dark:text-slate-100">
          Flights ready to invoice
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Closed flights with no invoice yet. Pick a rate and the draft builds itself from the
          Hobbs reading.
        </p>
      </div>
      <ReadyToInvoiceClient slug={slug} rows={worklist.rows} rates={ratePicker.rates} />
    </section>
  );
}

function ReadyToInvoiceSkeleton() {
  return (
    <div className="space-y-3 animate-pulse" aria-busy="true" aria-label="Loading flights ready to invoice">
      <Skeleton className="h-6 w-56" />
      <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="h-10 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800" />
        {[0, 1].map((i) => (
          <div key={i} className="h-14 border-b border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900" />
        ))}
      </div>
    </div>
  );
}

const INVOICE_STATUS_META: Record<
  'draft' | 'finalized' | 'void',
  { label: string; variant: 'success' | 'warning' | 'neutral' }
> = {
  draft: { label: 'Draft', variant: 'warning' },
  finalized: { label: 'Finalized', variant: 'success' },
  void: { label: 'Void', variant: 'neutral' },
};

function InvoiceStatusBadge({ status }: { status: 'draft' | 'finalized' | 'void' }) {
  const meta = INVOICE_STATUS_META[status];
  return <StatusBadge variant={meta.variant}>{meta.label}</StatusBadge>;
}

// ─── Money at a glance (3-metric strip — dashboard snapshot pattern) ──────────

async function BillingSnapshotContent() {
  // Reuses the EXISTING billing report reads (billing:access-gated inside the
  // API fns) — no new API. Quietly renders nothing on any failure.
  const [arResult, revenueResult] = await Promise.all([
    getAccountsReceivableAction(),
    getRevenueReportAction('30d'),
  ]);
  if (!('ok' in arResult) || !('ok' in revenueResult)) return null;

  const overdueMemberCount = arResult.data.rows.filter(
    (r) => r.aging.d30 + r.aging.d60 + r.aging.d90 + r.aging.d90plus > 0,
  ).length;
  const outstandingCents = arResult.data.totalOutstandingCents;
  const collectedCents = revenueResult.data.totalCollectedCents;

  return (
    <section aria-label="Billing snapshot">
      <SectionHeader eyebrow="As of now" />
      <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
        <div className="flex divide-x divide-slate-200 dark:divide-slate-800 max-sm:grid max-sm:grid-cols-1 max-sm:divide-x-0">
          {/* Tile 1: Outstanding balance */}
          <div className="flex-1 px-5 py-4">
            <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Outstanding
            </p>
            <p
              className={[
                'nums mt-1 text-2xl font-bold leading-none',
                outstandingCents > 0 ? 'text-slate-900 dark:text-slate-100' : 'text-slate-400 dark:text-slate-500',
              ].join(' ')}
            >
              {formatCents(outstandingCents)}
            </p>
            <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
              {outstandingCents > 0 ? 'owed across all members' : 'nothing owed'}
            </p>
          </div>

          {/* Tile 2: Members overdue (past 30 days) */}
          <div className="flex-1 px-5 py-4">
            <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Overdue
            </p>
            <p
              className={[
                'nums mt-1 text-2xl font-bold leading-none',
                overdueMemberCount > 0 ? 'text-warning' : 'text-slate-400 dark:text-slate-500',
              ].join(' ')}
            >
              {overdueMemberCount}
            </p>
            <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
              {overdueMemberCount > 0 ? 'members past 30 days' : 'no one past 30 days'}
            </p>
          </div>

          {/* Tile 3: Collected — last 30 days */}
          <div className="flex-1 px-5 py-4">
            <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Collected — 30d
            </p>
            <p
              className={[
                'nums mt-1 text-2xl font-bold leading-none',
                collectedCents > 0 ? 'text-slate-900 dark:text-slate-100' : 'text-slate-400 dark:text-slate-500',
              ].join(' ')}
            >
              {formatCents(collectedCents)}
            </p>
            <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
              {collectedCents > 0 ? 'payments received' : 'none received'}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function BillingSnapshotSkeleton() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label="Loading billing snapshot">
      <Skeleton className="h-3 w-16 mb-2" />
      <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs divide-x divide-slate-200 dark:divide-slate-800 flex">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex-1 px-5 py-4 space-y-2">
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-7 w-16" />
            <Skeleton className="h-2.5 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

interface BillingPageProps {
  params: Promise<{ slug: string }>;
}

export default async function BillingPage({ params }: BillingPageProps) {
  const { slug } = await params;
  const session = await auth();

  try {
    requireCapability(session, 'billing:access');
  } catch (err) {
    const action = mapAuthErrorToResponse(err);
    if (action === 'forbidden') redirect(`/o/${slug}/no-access?reason=insufficient_role`);
    if (action === 'login') redirect(`/o/${slug}/login`);
    throw err;
  }

  // Only roles that can generate invoices (billing:manage) see the worklist.
  const canManage = hasCapability(session, 'billing:manage');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Billing"
        subtitle="Invoices, balances, and money collected."
        actions={
          <>
            <Button asChild variant="outline" size="sm">
              <Link href={`/o/${slug}/billing/block-time`}>Block time</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href={`/o/${slug}/billing/reports`}>Accounts receivable &amp; revenue</Link>
            </Button>
          </>
        }
      />
      <Suspense fallback={<BillingSnapshotSkeleton />}>
        <BillingSnapshotContent />
      </Suspense>
      {canManage && (
        <Suspense fallback={<ReadyToInvoiceSkeleton />}>
          <ReadyToInvoiceContent slug={slug} />
        </Suspense>
      )}
      <div className="space-y-4">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Invoices</h2>
        <Suspense fallback={<InvoiceListSkeleton />}>
          <InvoiceListContent slug={slug} />
        </Suspense>
      </div>
    </div>
  );
}
