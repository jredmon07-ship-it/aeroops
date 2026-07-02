/**
 * portal/billing/page.tsx — Member self-pay (Slice P0-REV).
 *
 * Route: /o/[slug]/portal/billing
 * Capability gate: portal:access (page-level requireCapability → redirect
 * /no-access), mirroring portal/page.tsx EXACTLY.
 *
 * Self-scoped to session.userId — see getMyBillingAction (portal/actions.ts)
 * and its underlying @aeroops/api getMyBilling command. NO cross-member data.
 *
 * States: loading (Suspense skeleton) / populated / empty (no invoices / no
 * saved PM / autopay off) / error (Alert + Retry) / permission-denied
 * (redirect) / not-configured ("payments not enabled").
 *
 * BOUNDARY: imports ONLY from '@aeroops/api' (types) + local server actions.
 * NEVER '@aeroops/db'. NO raw card/bank data ever reaches this server — see
 * portal-billing-client.tsx's file header for the PCI posture.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability } from '@aeroops/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { getMyBillingAction, getStripePublishableConfigAction } from '../actions';
import { PortalBillingClient } from './_components/portal-billing-client';

function BillingSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading billing">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-20 w-full max-w-sm" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

interface BillingContentProps {
  slug: string;
}

async function BillingContent({ slug }: BillingContentProps) {
  const [billingResult, stripeConfig] = await Promise.all([
    getMyBillingAction(),
    getStripePublishableConfigAction(),
  ]);

  if ('error' in billingResult) {
    const message =
      billingResult.error === 'forbidden'
        ? 'You do not have access to billing.'
        : billingResult.error === 'unauthenticated'
          ? 'Your session has expired. Please sign in again.'
          : 'Could not load your billing info. Please try again.';
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>{message}</span>
          <Link
            href={`/o/${slug}/portal/billing`}
            className="text-sm underline underline-offset-2 hover:no-underline"
          >
            Retry
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  return <PortalBillingClient initialBilling={billingResult.billing} stripeConfig={stripeConfig} />;
}

interface PortalBillingPageProps {
  params: Promise<{ slug: string }>;
}

export default async function PortalBillingPage({ params }: PortalBillingPageProps) {
  const { slug } = await params;
  const session = await auth();

  if (!session) {
    redirect(`/o/${slug}/login`);
  }

  try {
    requireCapability(session, 'portal:access');
  } catch (err) {
    const action = mapAuthErrorToResponse(err);
    if (action === 'forbidden') redirect(`/o/${slug}/no-access?reason=insufficient_role`);
    if (action === 'login') redirect(`/o/${slug}/login`);
    throw err;
  }

  return (
    <div className="space-y-4">
      <Link
        href={`/o/${slug}/portal`}
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Back to portal
      </Link>
      <Suspense fallback={<BillingSkeleton />}>
        <BillingContent slug={slug} />
      </Suspense>
    </div>
  );
}
