/**
 * billing/block-time/[memberId]/page.tsx — Member block-time summary
 * (Slice B4). STAFF view (billing:access).
 *
 * Route: /o/[slug]/billing/block-time/[memberId]
 * Capability gate: billing:access (page-level requireCapability → redirect).
 *
 * States:
 *   Loading   — Suspense skeleton.
 *   Populated — totals (hours/amount purchased, prepaid balance) + purchase
 *               history table (newest first).
 *   Empty     — "No blocks purchased yet" (member exists, zero purchases).
 *   Not found — cross-org / unknown memberId.
 *   Error     — destructive Alert + Retry.
 *
 * BOUNDARY: imports only from '@aeroops/api' (via ../ actions). Never '@aeroops/db'.
 *
 * MONEY: amounts are INTEGER CENTS, displayed via formatCents. Prepaid
 * balance is the derived ledger balance clamped to >= 0 (never negative —
 * see getMemberBlockSummary's METRIC DEFINITIONS).
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, AlertCircle, Layers } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { getMemberBlockSummaryAction } from '../actions';
import { formatCents } from '../../_components/format-cents';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';

function SummarySkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading block-time summary">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-24 w-full max-w-md" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

interface SummaryContentProps {
  slug: string;
  memberId: string;
}

async function SummaryContent({ slug, memberId }: SummaryContentProps) {
  const result = await getMemberBlockSummaryAction(memberId);

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load this member&apos;s block-time summary. Please try again.</span>
        </AlertDescription>
      </Alert>
    );
  }

  if (!result.ok) {
    return (
      <Alert role="status">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription>This member could not be found.</AlertDescription>
      </Alert>
    );
  }

  const { summary } = result;

  return (
    <div className="space-y-6">
      <PageHeader title={summary.memberName} subtitle="Block-time summary" />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl">
        <div className="rounded-md border border-slate-200 dark:border-slate-800 p-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Hours purchased</p>
          <p className="mt-1 nums text-xl font-semibold text-slate-900 dark:text-slate-100">{summary.totalHoursPurchased}</p>
        </div>
        <div className="rounded-md border border-slate-200 dark:border-slate-800 p-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Amount purchased</p>
          <p className="mt-1 nums text-xl font-semibold text-slate-900 dark:text-slate-100">
            {formatCents(summary.totalAmountPurchasedCents)}
          </p>
        </div>
        <div className="rounded-md border border-slate-200 dark:border-slate-800 p-4">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Prepaid balance</p>
          <p className="mt-1 nums text-xl font-semibold text-slate-900 dark:text-slate-100">
            {formatCents(summary.prepaidBalanceCents)}
          </p>
        </div>
      </div>
      <p className="text-xs text-slate-400 dark:text-slate-500 max-w-2xl">
        Prepaid balance is the member&apos;s remaining ledger credit — it never shows negative here
        (a member who owes money is tracked on the accounts-receivable report instead). Drawdown per
        flight hour is not tracked in this version; the balance reflects payments and invoices only.
      </p>

      <div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-2">Purchase history</h2>
        {summary.purchases.length === 0 ? (
          <EmptyState icon={Layers} title="No blocks purchased yet." className="py-12" />
        ) : (
          <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-x-auto">
            <table className="w-full text-sm" aria-label="Block purchase history">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
                  <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Date</th>
                  <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Hours</th>
                  <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Amount</th>
                  <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide hidden sm:table-cell">Note</th>
                </tr>
              </thead>
              <tbody>
                {summary.purchases.map((p) => (
                  <tr key={p.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                    <td className="px-3 py-2 nums text-xs text-slate-500 dark:text-slate-400">
                      {new Date(p.purchasedAt).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2 text-right nums">{p.hours}</td>
                    <td className="px-3 py-2 text-right nums">{formatCents(p.amountCents)}</td>
                    <td className="px-3 py-2 text-xs text-slate-500 dark:text-slate-400 hidden sm:table-cell">{p.note ?? '—'}</td>
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

interface MemberBlockTimePageProps {
  params: Promise<{ slug: string; memberId: string }>;
}

export default async function MemberBlockTimePage({ params }: MemberBlockTimePageProps) {
  const { slug, memberId } = await params;
  const session = await auth();

  try {
    requireCapability(session, 'billing:access');
  } catch (err) {
    const action = mapAuthErrorToResponse(err);
    if (action === 'forbidden') redirect(`/o/${slug}/no-access?reason=insufficient_role`);
    if (action === 'login') redirect(`/o/${slug}/login`);
    throw err;
  }

  return (
    <div className="space-y-4">
      <Link
        href={`/o/${slug}/billing/block-time`}
        className="inline-flex items-center gap-1 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Back to block time
      </Link>
      <Suspense fallback={<SummarySkeleton />}>
        <SummaryContent slug={slug} memberId={memberId} />
      </Suspense>
    </div>
  );
}
