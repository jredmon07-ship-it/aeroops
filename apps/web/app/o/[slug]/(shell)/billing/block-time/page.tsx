/**
 * billing/block-time/page.tsx — Block-time / prepaid packages (Slice B4).
 *
 * Route: /o/[slug]/billing/block-time
 * Capability gate: billing:access (page-level requireCapability → redirect).
 * Write actions (add/edit/deactivate a package, selling a block) require
 * billing:manage — enforced by the @aeroops/api commands; the UI hides/
 * disables write controls for accountant (billing:access only) as a
 * cosmetic guard, mirroring billing/catalog + billing/pos exactly.
 *
 * States:
 *   Loading           — Suspense skeleton.
 *   Empty             — "No block packages yet" + primary "Add package" CTA.
 *   Populated         — package table (name / hours / price / effective
 *                        rate / active) + row actions (edit / deactivate).
 *   Error             — destructive Alert.
 *   Permission-denied — redirect to no-access via requireCapability.
 *
 * BOUNDARY: imports only from '@aeroops/api' (via ./ actions). Never '@aeroops/db'.
 *
 * MONEY: price_cents / amount_cents are INTEGER CENTS, displayed via
 * formatCents. NO Stripe, NO card/bank data — selling a block only ever
 * posts an operator-recorded ledger credit (like recordManualPayment).
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Layers, AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { listBlockPackagesAction, listBillableMembersAction } from './actions';
import { BlockPackagesClient } from './_components/block-packages-client';
import { SellBlockClient } from './_components/sell-block-client';

// ─── Loading skeleton ──────────────────────────────────────────────────────────

function BlockTimeSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading block time">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-40 w-full" />
      <div className="rounded-md border border-slate-200 overflow-hidden">
        <div className="h-10 bg-slate-50 border-b border-slate-200" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-14 border-b border-slate-100 bg-white" />
        ))}
      </div>
    </div>
  );
}

// ─── Inner async content ───────────────────────────────────────────────────────

async function BlockTimeContent({ slug, canManage }: { slug: string; canManage: boolean }) {
  const [packagesResult, membersResult] = await Promise.all([
    listBlockPackagesAction({ includeInactive: true }),
    canManage ? listBillableMembersAction() : Promise.resolve({ ok: true as const, members: [] }),
  ]);

  if ('error' in packagesResult) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription>Could not load block packages. Please try again.</AlertDescription>
      </Alert>
    );
  }
  if ('error' in membersResult) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription>Could not load members. Please try again.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-8">
      {canManage && (
        <section className="space-y-3" aria-labelledby="sell-block-heading">
          <h2 id="sell-block-heading" className="text-lg font-semibold text-slate-900">
            Sell a block
          </h2>
          <SellBlockClient
            slug={slug}
            members={membersResult.members}
            activePackages={packagesResult.packages.filter((p) => p.active)}
          />
        </section>
      )}
      <section className="space-y-3" aria-labelledby="packages-heading">
        <h2 id="packages-heading" className="text-lg font-semibold text-slate-900">
          Block packages
        </h2>
        <BlockPackagesClient slug={slug} initialPackages={packagesResult.packages} canManage={canManage} />
      </section>
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

interface BlockTimePageProps {
  params: Promise<{ slug: string }>;
}

export default async function BlockTimePage({ params }: BlockTimePageProps) {
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Layers className="h-6 w-6 text-slate-400" aria-hidden="true" />
          <h1 className="text-2xl font-bold text-slate-900">Block time</h1>
        </div>
        <Link
          href={`/o/${slug}/billing`}
          className="text-sm text-slate-500 hover:text-slate-700 underline underline-offset-2"
        >
          Back to billing
        </Link>
      </div>
      <p className="text-sm text-slate-500">
        Prepaid, discounted hour bundles members buy up front and draw down as they fly. A block
        sale records an operator-recorded credit on the member&apos;s account — the same billing
        ledger a manual payment posts to. Amounts are recorded in cents; no card is ever charged
        here.
      </p>
      <Suspense fallback={<BlockTimeSkeleton />}>
        <BlockTimeContent slug={slug} canManage={canManage} />
      </Suspense>
    </div>
  );
}
