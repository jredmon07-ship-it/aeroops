/**
 * billing/recurring/page.tsx — Recurring billing hub (org-level dues/tuition
 * schedules, Slice DUES-CADENCE / RECUR-HUB).
 *
 * Route: /o/[slug]/billing/recurring
 * Capability gate: billing:access (page-level requireCapability → redirect).
 * Write actions (bulk-apply a standard schedule, generate a period's
 * invoices) require billing:manage — enforced by the @aeroops/api commands;
 * the UI hides the write controls for accountant (billing:access only) as a
 * cosmetic guard, mirroring the other billing sub-pages.
 *
 * States:
 *   Loading           — Suspense skeleton.
 *   Empty             — "No recurring {noun} schedules yet."
 *   Populated         — one row per active schedule (member / amount /
 *                        cadence / memo).
 *   Error             — destructive Alert + Retry.
 *   Permission-denied — redirect to no-access via requireCapability.
 *
 * BOUNDARY: imports only from '@aeroops/api' (via ./ ../actions) + local
 * server actions. Never '@aeroops/db'.
 *
 * MONEY: amount_cents is INTEGER CENTS, displayed via formatCents. NO Stripe,
 * NO card/bank data — a schedule only produces a DRAFT invoice when a period
 * is generated; it never charges anything by itself.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability, getOrgFeatures } from '@aeroops/api';
import { recurringChargeNoun } from '@aeroops/core';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/ui/page-header';
import { listOrgDuesSchedulesAction } from '../actions';
import { RecurringBillingClient } from './_components/recurring-billing-client';

// ─── Loading skeleton ──────────────────────────────────────────────────────────

function RecurringBillingSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading recurring billing">
      <Skeleton className="h-8 w-56" />
      <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="h-10 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800" />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-14 border-b border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900" />
        ))}
      </div>
    </div>
  );
}

// ─── Inner async content ───────────────────────────────────────────────────────

interface RecurringBillingContentProps {
  slug: string;
  chargeNoun: 'Tuition' | 'Dues';
  canManage: boolean;
  currentPeriodKey: string;
}

async function RecurringBillingContent({
  slug,
  chargeNoun,
  canManage,
  currentPeriodKey,
}: RecurringBillingContentProps) {
  const result = await listOrgDuesSchedulesAction();

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load recurring {chargeNoun.toLowerCase()} schedules. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/billing/recurring`}>Retry</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  // Empty and populated are both handled inside RecurringBillingClient — a
  // billing:manage user still needs the "Bulk apply" action visible even
  // with zero schedules (that IS the onboarding path for a fresh org).
  return (
    <RecurringBillingClient
      slug={slug}
      schedules={result.schedules}
      chargeNoun={chargeNoun}
      canManage={canManage}
      currentPeriodKey={currentPeriodKey}
    />
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

interface RecurringBillingPageProps {
  params: Promise<{ slug: string }>;
}

export default async function RecurringBillingPage({ params }: RecurringBillingPageProps) {
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
  // Default 'school' (=> "Tuition") when the module-gate read failed above
  // and orgFeatures is null — matches the fail-soft-to-enabled posture used
  // for `features` a few lines up.
  const chargeNoun = recurringChargeNoun(orgFeatures?.operatingMode ?? 'school');

  const now = new Date();
  const currentPeriodKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Recurring ${chargeNoun}`}
        subtitle={`Every member with an active ${chargeNoun.toLowerCase()} schedule, in one place.`}
        backHref={`/o/${slug}/billing`}
        backLabel="Back to Billing"
      />
      <Suspense fallback={<RecurringBillingSkeleton />}>
        <RecurringBillingContent
          slug={slug}
          chargeNoun={chargeNoun}
          canManage={canManage}
          currentPeriodKey={currentPeriodKey}
        />
      </Suspense>
    </div>
  );
}
