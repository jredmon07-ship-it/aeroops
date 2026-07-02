/**
 * billing/accounts/[memberId]/page.tsx — Member account detail (Slice B2).
 *
 * Route: /o/[slug]/billing/accounts/[memberId]
 * Capability gate: billing:access (page-level requireCapability → redirect).
 *
 * States:
 *   Loading           — Suspense skeleton.
 *   Populated         — DERIVED balance + ledger history table.
 *   Not-found         — memberUserId is not a member of this org.
 *   Error             — destructive Alert.
 *   Permission-denied — redirect to no-access via requireCapability.
 *
 * BOUNDARY: imports only from '@aeroops/api' (types) + local server actions.
 * Never '@aeroops/db'.
 *
 * MONEY BOUNDARY: read-only display of a DERIVED (never stored) balance +
 * append-only ledger history, in INTEGER CENTS. The only mutation available
 * here is "Record payment" (billing:manage) — a MANUAL operator
 * acknowledgement (check/cash/external), NOT a Stripe charge. NO Stripe, NO
 * card/bank data on this page in this slice.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Wallet, AlertCircle, ArrowLeft } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { getMemberBalanceAction, listLedgerEntriesAction } from '../../actions';
import { AccountDetailClient } from '../_components/account-detail-client';

// ─── Loading skeleton ──────────────────────────────────────────────────────────

function DetailSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading account">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="h-20 w-full max-w-sm" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

// ─── Inner async content ───────────────────────────────────────────────────────

interface DetailContentProps {
  memberId: string;
  slug: string;
  canManage: boolean;
}

async function DetailContent({ memberId, slug, canManage }: DetailContentProps) {
  const [balanceResult, entriesResult] = await Promise.all([
    getMemberBalanceAction(memberId),
    listLedgerEntriesAction(memberId),
  ]);

  if ('error' in balanceResult || 'error' in entriesResult) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load this account. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/billing/accounts/${memberId}`}>Retry</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!balanceResult.ok || !entriesResult.ok) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center space-y-3" role="status">
        <Wallet className="h-10 w-10 text-slate-300" aria-hidden="true" />
        <p className="text-slate-700 font-medium">This member has no billing account.</p>
        <Button asChild variant="outline" size="sm">
          <Link href={`/o/${slug}/billing`}>
            <ArrowLeft className="h-4 w-4 mr-1" aria-hidden="true" />
            Back to Billing
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <AccountDetailClient
      memberId={memberId}
      slug={slug}
      balanceCents={balanceResult.balanceCents}
      minimumBalanceCents={balanceResult.minimumBalanceCents}
      initialEntries={entriesResult.entries}
      canManage={canManage}
    />
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

interface AccountDetailPageProps {
  params: Promise<{ slug: string; memberId: string }>;
}

export default async function AccountDetailPage({ params }: AccountDetailPageProps) {
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

  const canManage = hasCapability(session, 'billing:manage');

  return (
    <div className="space-y-4">
      <Link
        href={`/o/${slug}/billing`}
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Back to Billing
      </Link>
      <Suspense fallback={<DetailSkeleton />}>
        <DetailContent memberId={memberId} slug={slug} canManage={canManage} />
      </Suspense>
    </div>
  );
}
