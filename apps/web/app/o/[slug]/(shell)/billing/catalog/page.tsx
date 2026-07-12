/**
 * billing/catalog/page.tsx — Product catalog admin (Slice P2 — POS).
 *
 * Route: /o/[slug]/billing/catalog
 * Capability gate: billing:access (page-level requireCapability → redirect).
 * Write actions (add/edit/deactivate/delete) require billing:manage —
 * enforced by the @aeroops/api commands; the UI hides/disables write
 * controls for accountant (billing:access only) as a cosmetic guard.
 *
 * States:
 *   Loading           — Suspense skeleton.
 *   Empty             — "No catalog items yet" + primary "Add item" CTA.
 *   Populated         — table (name / price / sku / category / active) +
 *                        row actions (edit / deactivate / delete).
 *   Error             — destructive Alert + Retry.
 *   Permission-denied — redirect to no-access via requireCapability.
 *
 * BOUNDARY: imports only from '@aeroops/api' (via ./ actions). Never '@aeroops/db'.
 *
 * MONEY: unit_price_cents is INTEGER CENTS, displayed via formatCents. NO
 * Stripe, NO card/bank data. This is a price LIST, not a charge.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { Package, AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { listProductCatalogItemsAction } from '../pos/actions';
import { CatalogClient } from './_components/catalog-client';
import { PageHeader } from '@/components/ui/page-header';

// ─── Loading skeleton ──────────────────────────────────────────────────────────

function CatalogSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading catalog">
      <Skeleton className="h-8 w-40" />
      <div className="rounded-md border border-slate-200 overflow-hidden">
        <div className="h-10 bg-slate-50 border-b border-slate-200" />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-14 border-b border-slate-100 bg-white" />
        ))}
      </div>
    </div>
  );
}

// ─── Inner async content ───────────────────────────────────────────────────────

async function CatalogContent({ slug, canManage }: { slug: string; canManage: boolean }) {
  const result = await listProductCatalogItemsAction({ includeInactive: true });

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load the catalog. Please try again.</span>
        </AlertDescription>
      </Alert>
    );
  }

  return <CatalogClient slug={slug} initialItems={result.items} canManage={canManage} />;
}

// ─── Page ──────────────────────────────────────────────────────────────────────

interface CatalogPageProps {
  params: Promise<{ slug: string }>;
}

export default async function CatalogPage({ params }: CatalogPageProps) {
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
            <Package className="h-6 w-6 text-slate-400" aria-hidden="true" />
            Catalog
          </span>
        }
      />
      <p className="text-sm text-slate-500">
        Non-flight goods and services (headsets, charts, fuel, merch) sold at the counter.
        Amounts are recorded in cents. Tax is not calculated.
      </p>
      <Suspense fallback={<CatalogSkeleton />}>
        <CatalogContent slug={slug} canManage={canManage} />
      </Suspense>
    </div>
  );
}
