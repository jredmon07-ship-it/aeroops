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
import { requireCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { listInvoicesAction } from './actions';
import { formatCents } from './_components/format-cents';

// ─── Loading skeleton ──────────────────────────────────────────────────────────

function InvoiceListSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading invoices">
      <Skeleton className="h-8 w-40" />
      <div className="rounded-md border border-slate-200 overflow-hidden">
        <div className="h-10 bg-slate-50 border-b border-slate-200" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-14 border-b border-slate-100 bg-white" />
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
      <div className="flex flex-col items-center justify-center py-16 text-center space-y-3" role="status">
        <Receipt className="h-10 w-10 text-slate-300" aria-hidden="true" />
        <p className="text-slate-700 font-medium">No invoices yet.</p>
        <p className="text-sm text-slate-400">
          Generate a draft invoice from a closed dispatch ticket to get started.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-slate-200 overflow-hidden">
      <table className="w-full text-sm" aria-label="Invoices">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200">
            <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
              Status
            </th>
            <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 uppercase tracking-wide">
              Total
            </th>
            <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden sm:table-cell">
              Created
            </th>
          </tr>
        </thead>
        <tbody>
          {result.invoices.map((inv) => (
            <tr key={inv.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors">
              <td className="px-3 py-3">
                <Link href={`/o/${slug}/billing/${inv.id}`} className="flex items-center gap-2">
                  <StatusBadge status={inv.status} />
                </Link>
              </td>
              <td className="px-3 py-3 text-right nums">
                <Link href={`/o/${slug}/billing/${inv.id}`}>{formatCents(inv.totalCents)}</Link>
              </td>
              <td className="px-3 py-3 text-xs text-slate-500 hidden sm:table-cell nums">
                <Link href={`/o/${slug}/billing/${inv.id}`}>{new Date(inv.createdAt).toLocaleDateString()}</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Billing</h1>
        <Button asChild variant="outline" size="sm">
          <Link href={`/o/${slug}/billing/reports`}>Accounts receivable &amp; revenue</Link>
        </Button>
      </div>
      <Suspense fallback={<InvoiceListSkeleton />}>
        <InvoiceListContent slug={slug} />
      </Suspense>
    </div>
  );
}
