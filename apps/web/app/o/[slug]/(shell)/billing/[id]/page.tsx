/**
 * billing/[id]/page.tsx — Invoice detail page (RSC).
 *
 * Route: /o/[slug]/billing/[id]
 * Capability gate: billing:access (page-level requireCapability → redirect).
 *
 * States:
 *   Loading           — Suspense skeleton.
 *   Populated         — header + line items + status actions.
 *   Not-found         — empty state card.
 *   Error             — destructive Alert.
 *   Permission-denied — redirect to no-access via requireCapability.
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 *
 * MONEY BOUNDARY: read-only display of INTEGER CENTS amounts. The only
 * mutations available here are the existing Slice B1 status transitions
 * (finalize/void, billing:manage) and the Slice QB1 "Export to QuickBooks"
 * action (billing:manage) — a bookkeeping EXPORT of this existing invoice
 * record. NEITHER moves money. NO Stripe, NO card/bank data.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Receipt, AlertCircle, ArrowLeft } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability, getOrgFeatures } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { getInvoiceAction, getInvoiceQboStatusAction } from '../actions';
import type { QboInvoiceExportStatus } from '../actions';
import { InvoiceDetailClient } from '../_components/invoice-detail-client';

// ─── Loading skeleton ──────────────────────────────────────────────────────────

function DetailSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading invoice">
      <Skeleton className="h-4 w-24" />
      <div className="space-y-2">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-32" />
      </div>
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

// ─── Inner async content ───────────────────────────────────────────────────────

interface DetailContentProps {
  invoiceId: string;
  slug: string;
  canManage: boolean;
}

async function DetailContent({ invoiceId, slug, canManage }: DetailContentProps) {
  const result = await getInvoiceAction(invoiceId);

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load this invoice. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/billing/${invoiceId}`}>Retry</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!result.ok) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center space-y-3" role="status">
        <Receipt className="h-10 w-10 text-slate-300" aria-hidden="true" />
        <p className="text-slate-700 dark:text-slate-300 font-medium">Invoice not found.</p>
        <Button asChild variant="outline" size="sm">
          <Link href={`/o/${slug}/billing`}>
            <ArrowLeft className="h-4 w-4 mr-1" aria-hidden="true" />
            Back to Billing
          </Link>
        </Button>
      </div>
    );
  }

  // QBO export status (best-effort — a failure just renders the neutral
  // "not exported" badge; it never blocks the invoice detail).
  let initialQboStatus: QboInvoiceExportStatus = 'not_exported';
  let initialQboId: string | null = null;
  const qboResult = await getInvoiceQboStatusAction(result.invoice.id);
  if ('ok' in qboResult && qboResult.ok) {
    initialQboStatus = qboResult.status;
    initialQboId = qboResult.qboId;
  }

  return (
    <InvoiceDetailClient
      invoice={result.invoice}
      lineItems={result.lineItems}
      slug={slug}
      canManage={canManage}
      initialQboStatus={initialQboStatus}
      initialQboId={initialQboId}
    />
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

interface InvoiceDetailPageProps {
  params: Promise<{ slug: string; id: string }>;
}

export default async function InvoiceDetailPage({ params }: InvoiceDetailPageProps) {
  const { slug, id } = await params;
  const session = await auth();

  try {
    requireCapability(session, 'billing:access');
  } catch (err) {
    const action = mapAuthErrorToResponse(err);
    if (action === 'forbidden') redirect(`/o/${slug}/no-access?reason=insufficient_role`);
    if (action === 'login') redirect(`/o/${slug}/login`);
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
  if (orgFeatures && !orgFeatures.features.billing) {
    redirect(`/o/${slug}/no-access?reason=module_disabled`);
  }

  const canManage = hasCapability(session, 'billing:manage');

  return (
    <div className="space-y-4">
      <Link
        href={`/o/${slug}/billing`}
        className="inline-flex items-center gap-1 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Back to Billing
      </Link>
      <Suspense fallback={<DetailSkeleton />}>
        <DetailContent invoiceId={id} slug={slug} canManage={canManage} />
      </Suspense>
    </div>
  );
}
