/**
 * billing/reports/[memberId]/page.tsx — Member statement drill-in (RSC).
 *
 * Route: /o/[slug]/billing/reports/[memberId]
 * Capability gate: billing:access (owner/manager/accountant) — STAFF view.
 * Distinct from the member's own portal self-view (portal:access, untouched).
 *
 * Shows: invoices (status + totals, newest first) and the full chronological
 * ledger history with a running balance, for one member.
 *
 * States: Loading (Suspense) / Populated / Not-found / Error / Denied (redirect).
 *
 * BOUNDARY: imports only local server actions. Never '@aeroops/db'.
 * MONEY: every amount displayed is formatted from INTEGER CENTS via formatCents.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { AlertCircle, ArrowLeft, FileText } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { getMemberStatementAction } from '../actions';
import type { SerializedStatementLedgerRow } from '../actions';
import { formatCents } from '../../_components/format-cents';

function entryTypeLabel(entryType: string): string {
  switch (entryType) {
    case 'invoice_finalized':
      return 'Invoice finalized';
    case 'payment':
      return 'Payment';
    case 'credit_memo':
      return 'Credit memo';
    case 'adjustment':
      return 'Adjustment';
    default:
      return entryType;
  }
}

function StatusBadge({ status }: { status: 'draft' | 'finalized' | 'void' }) {
  if (status === 'finalized') {
    return (
      <span className="inline-flex items-center rounded-sm border border-green-200 bg-green-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-green-800">
        Finalized
      </span>
    );
  }
  if (status === 'void') {
    return (
      <span className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-slate-500">
        Void
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-sm border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-amber-800">
      Draft
    </span>
  );
}

function LedgerRow({ row }: { row: SerializedStatementLedgerRow }) {
  const signed = row.direction === 'credit' ? row.amountCents : -row.amountCents;
  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="px-4 py-2.5 text-xs text-slate-500 nums whitespace-nowrap">
        {new Date(row.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
      </td>
      <td className="px-4 py-2.5 text-slate-700">{entryTypeLabel(row.entryType)}</td>
      <td className="px-4 py-2.5 text-slate-500 text-xs">{row.memo ?? row.paymentId ?? '—'}</td>
      <td className={['px-4 py-2.5 text-right nums font-medium', signed < 0 ? 'text-danger' : 'text-slate-700'].join(' ')}>
        {signed < 0 ? `-${formatCents(row.amountCents)}` : formatCents(row.amountCents)}
      </td>
      <td className="px-4 py-2.5 text-right nums font-semibold">{formatCents(row.runningBalanceCents)}</td>
    </tr>
  );
}

async function StatementContent({ slug, memberId }: { slug: string; memberId: string }) {
  const result = await getMemberStatementAction(memberId);

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load this statement. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/billing/reports/${memberId}`}>Retry</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!result.ok) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center space-y-3" role="status">
        <FileText className="h-10 w-10 text-slate-300" aria-hidden="true" />
        <p className="text-slate-700 font-medium">This member could not be found.</p>
        <Button asChild variant="outline" size="sm">
          <Link href={`/o/${slug}/billing/reports`}>
            <ArrowLeft className="h-4 w-4 mr-1" aria-hidden="true" />
            Back to reports
          </Link>
        </Button>
      </div>
    );
  }

  const { statement } = result;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{statement.memberName}</h1>
        <p className="mt-0.5 text-sm text-slate-500">Member statement — staff view.</p>
      </div>

      <div className="rounded-md border border-slate-200 bg-white shadow-xs px-5 py-4 inline-block">
        <p className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-500">Current balance</p>
        <p className={['nums mt-1 text-2xl font-bold leading-none', statement.endingBalanceCents < 0 ? 'text-danger' : statement.endingBalanceCents === 0 ? 'text-slate-300' : 'text-green-700'].join(' ')}>
          {statement.endingBalanceCents < 0 ? `-${formatCents(statement.endingBalanceCents)}` : formatCents(statement.endingBalanceCents)}
        </p>
        <p className="mt-1 text-xs text-slate-400">
          {statement.endingBalanceCents < 0
            ? 'Owed to the operator'
            : statement.endingBalanceCents === 0
              ? 'Paid in full'
              : 'Credit on account'}
        </p>
      </div>

      {/* Invoices */}
      <section aria-label="Invoices">
        <p className="mb-2 text-[0.625rem] uppercase tracking-[0.1em] text-slate-400">Invoices</p>
        {statement.invoices.length === 0 ? (
          <p className="text-sm text-slate-400 py-4">No invoices for this member.</p>
        ) : (
          <div className="rounded-md border border-slate-200 bg-white shadow-xs overflow-hidden">
            <table className="w-full text-sm" aria-label="Invoices">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th scope="col" className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-500">Status</th>
                  <th scope="col" className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-slate-500">Total</th>
                  <th scope="col" className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-500">Issued</th>
                </tr>
              </thead>
              <tbody>
                {statement.invoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2.5">
                      <Link href={`/o/${slug}/billing/${inv.id}`}>
                        <StatusBadge status={inv.status} />
                      </Link>
                    </td>
                    <td className="px-4 py-2.5 text-right nums">{formatCents(inv.totalCents)}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-500 nums">
                      {inv.issuedAt ? new Date(inv.issuedAt).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Ledger */}
      <section aria-label="Ledger history">
        <p className="mb-2 text-[0.625rem] uppercase tracking-[0.1em] text-slate-400">Ledger history (chronological)</p>
        {statement.ledger.length === 0 ? (
          <p className="text-sm text-slate-400 py-4">No ledger activity for this member.</p>
        ) : (
          <div className="rounded-md border border-slate-200 bg-white shadow-xs overflow-hidden">
            <table className="w-full text-sm" aria-label="Ledger history">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th scope="col" className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-500">Date</th>
                  <th scope="col" className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-500">Type</th>
                  <th scope="col" className="px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-500">Memo</th>
                  <th scope="col" className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-slate-500">Amount</th>
                  <th scope="col" className="px-4 py-2 text-right text-xs font-medium uppercase tracking-wide text-slate-500">Balance</th>
                </tr>
              </thead>
              <tbody>
                {statement.ledger.map((row) => (
                  <LedgerRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function StatementSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading statement">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-20 w-full max-w-sm" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

interface StatementPageProps {
  params: Promise<{ slug: string; memberId: string }>;
}

export default async function MemberStatementPage({ params }: StatementPageProps) {
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
        href={`/o/${slug}/billing/reports`}
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Back to reports
      </Link>
      <Suspense fallback={<StatementSkeleton />}>
        <StatementContent slug={slug} memberId={memberId} />
      </Suspense>
    </div>
  );
}
