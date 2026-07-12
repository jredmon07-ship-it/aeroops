/**
 * billing/pos/page.tsx — Counter sale / POS (Slice P2).
 *
 * Route: /o/[slug]/billing/pos
 * Capability gate: billing:access (page-level requireCapability → redirect).
 * Creating a sale requires billing:manage — enforced by the @aeroops/api
 * createCounterSale command. Members/catalog are only fetched (and the
 * create form only rendered) when the session has billing:manage, so an
 * accountant (billing:access only, no people:access) never triggers a
 * Forbidden from listMembers.
 *
 * States:
 *   Loading           — Suspense skeleton.
 *   Populated         — member picker + line builder + running subtotal.
 *   Permission-denied (billing:manage absent) — explanatory message, no
 *     create controls rendered.
 *   Error             — destructive Alert.
 *
 * BOUNDARY: imports only from '@aeroops/api' (via ./ actions). Never '@aeroops/db'.
 *
 * MONEY: creates a DRAFT invoice only — no card is charged until the
 * operator finalizes it (existing, unchanged finalizeInvoice path). Amounts
 * are INTEGER CENTS. NO Stripe, NO card/bank data. Tax is not calculated.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { ShoppingCart, AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { listBillableMembersAction, listProductCatalogItemsAction } from './actions';
import { PosClient } from './_components/pos-client';
import { PageHeader } from '@/components/ui/page-header';

// ─── Loading skeleton ──────────────────────────────────────────────────────────

function PosSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading counter sale">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

// ─── Inner async content ───────────────────────────────────────────────────────

async function PosContent({ slug }: { slug: string }) {
  const [membersResult, catalogResult] = await Promise.all([
    listBillableMembersAction(),
    listProductCatalogItemsAction({}),
  ]);

  if ('error' in membersResult) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription>Could not load members. Please try again.</AlertDescription>
      </Alert>
    );
  }
  if ('error' in catalogResult) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription>Could not load the catalog. Please try again.</AlertDescription>
      </Alert>
    );
  }

  return (
    <PosClient slug={slug} members={membersResult.members} catalogItems={catalogResult.items} />
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

interface PosPageProps {
  params: Promise<{ slug: string }>;
}

export default async function PosPage({ params }: PosPageProps) {
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

  const canManage = hasCapability(session, 'billing:manage');

  return (
    <div className="space-y-4">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <ShoppingCart className="h-6 w-6 text-slate-400" aria-hidden="true" />
            Counter sale
          </span>
        }
      />
      <p className="text-sm text-slate-500">
        Sell headsets, charts, fuel, or other non-flight items. Amounts are recorded in cents.
        Creating a sale drafts an invoice; no card is charged until you finalize it. Tax is not calculated.
      </p>
      {!canManage ? (
        <Alert role="status">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>You do not have permission to create a counter sale.</AlertDescription>
        </Alert>
      ) : (
        <Suspense fallback={<PosSkeleton />}>
          <PosContent slug={slug} />
        </Suspense>
      )}
    </div>
  );
}
