/**
 * maintenance/squawks/page.tsx — Squawk list page (RSC).
 *
 * Route: /o/[slug]/maintenance/squawks
 * Capability gate: maintenance:access (page-level requireCapability → redirect).
 *
 * States:
 *   Loading           — Suspense skeleton.
 *   Populated         — SquawkList renders the table + filters.
 *   Empty             — Overlay "No squawks" + Report if canSquawk.
 *   Error             — destructive Alert + Retry link.
 *   Permission-denied — redirect to no-access via requireCapability.
 *
 * Parallel-fetches listSquawks + listResources (aircraft only).
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { listResourcesAction } from '../../schedule/actions';
import { listSquawksAction } from '../actions';
import { SquawkList, SquawkListSkeleton } from './_components/squawk-list';

// ─── Inner async component ────────────────────────────────────────────────────

interface SquawksContentProps {
  slug: string;
  canSquawk: boolean;
  canGround: boolean;
}

async function SquawksContent({ slug, canSquawk, canGround }: SquawksContentProps) {
  // Parallel fetch: squawks + aircraft resources
  const [squawksResult, resourcesResult] = await Promise.all([
    listSquawksAction({ limit: 200 }),
    listResourcesAction({}),
  ]);

  if (!('ok' in squawksResult) || !squawksResult.ok) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load squawks. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/maintenance/squawks`}>Retry</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const squawks = squawksResult.squawks;
  const aircraft = (resourcesResult && 'ok' in resourcesResult && resourcesResult.ok
    ? resourcesResult.resources
    : []
  ).filter((r) => r.kind === 'aircraft' && r.active);

  return (
    <SquawkList
      initialSquawks={squawks}
      aircraft={aircraft}
      canSquawk={canSquawk}
      canGround={canGround}
    />
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface SquawksPageProps {
  params: Promise<{ slug: string }>;
}

export default async function SquawksPage({ params }: SquawksPageProps) {
  const { slug } = await params;
  const session = await auth();

  // ── RBAC gate ──────────────────────────────────────────────────────────────
  try {
    requireCapability(session, 'maintenance:access');
  } catch (err) {
    const action = mapAuthErrorToResponse(err);
    if (action === 'forbidden') {
      redirect(`/o/${slug}/no-access?reason=insufficient_role`);
    }
    if (action === 'login') {
      redirect(`/o/${slug}/login`);
    }
    throw err;
  }

  // ── Capability checks (UI-only; gate enforced server-side in actions) ───────
  const canSquawk = hasCapability(session, 'maintenance:squawk');
  const canGround = hasCapability(session, 'maintenance:ground');

  return (
    <Suspense fallback={<SquawkListSkeleton />}>
      <SquawksContent slug={slug} canSquawk={canSquawk} canGround={canGround} />
    </Suspense>
  );
}
