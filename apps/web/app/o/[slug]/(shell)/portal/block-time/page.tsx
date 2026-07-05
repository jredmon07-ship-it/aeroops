/**
 * portal/block-time/page.tsx — Member self-view of block-time / prepaid
 * packages (Slice B4).
 *
 * Route: /o/[slug]/portal/block-time
 * Capability gate: portal:access (page-level requireCapability → redirect
 * /no-access), mirroring portal/billing/page.tsx EXACTLY.
 *
 * Self-scoped to session.userId — see getMyBlockSummaryAction (portal/actions.ts)
 * and its underlying @aeroops/api getMyBlockSummary command. NO cross-member data.
 *
 * States: loading (Suspense skeleton) / populated / empty (no blocks purchased
 * yet) / error (Alert + Retry) / permission-denied (redirect).
 *
 * BOUNDARY: imports ONLY from '@aeroops/api' (types) + local server actions.
 * NEVER '@aeroops/db'. READ-ONLY.
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
import { getMyBlockSummaryAction } from '../actions';
import { PortalBlockTimeClient } from './_components/portal-block-time-client';

function BlockTimeSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading block time">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-24 w-full max-w-md" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

interface BlockTimeContentProps {
  slug: string;
}

async function BlockTimeContent({ slug }: BlockTimeContentProps) {
  const result = await getMyBlockSummaryAction();

  if ('error' in result) {
    const message =
      result.error === 'forbidden'
        ? 'You do not have access to block time.'
        : result.error === 'unauthenticated'
          ? 'Your session has expired. Please sign in again.'
          : 'Could not load your block-time summary. Please try again.';
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>{message}</span>
          <Link
            href={`/o/${slug}/portal/block-time`}
            className="text-sm underline underline-offset-2 hover:no-underline"
          >
            Retry
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  return <PortalBlockTimeClient summary={result.summary} />;
}

interface PortalBlockTimePageProps {
  params: Promise<{ slug: string }>;
}

export default async function PortalBlockTimePage({ params }: PortalBlockTimePageProps) {
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
      <Suspense fallback={<BlockTimeSkeleton />}>
        <BlockTimeContent slug={slug} />
      </Suspense>
    </div>
  );
}
