/**
 * maintenance/work-orders/page.tsx — Work orders list page (RSC).
 *
 * Route: /o/[slug]/maintenance/work-orders
 * Capability gate: maintenance:access (page-level requireCapability → redirect).
 *
 * States:
 *   Loading           — Suspense skeleton.
 *   Populated         — table with filters by aircraft + status.
 *   Empty             — "No work orders yet" + Open CTA if canWorkOrder.
 *   Error             — destructive Alert + Retry link.
 *   Permission-denied — redirect to no-access via requireCapability.
 *
 * Primary action: Open work order (gated maintenance:work_order).
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability, getOrgFeatures } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { listWorkOrdersAction } from './actions';
import { listAircraftAction } from '../../fleet/actions';
import { WorkOrdersList, WorkOrdersListSkeleton } from './_components/work-orders-list';

// ─── Inner async component ────────────────────────────────────────────────────

interface WorkOrdersContentProps {
  slug: string;
  canWorkOrder: boolean;
}

async function WorkOrdersContent({ slug, canWorkOrder }: WorkOrdersContentProps) {
  const [woResult, aircraftResult] = await Promise.all([
    listWorkOrdersAction(),
    listAircraftAction({ includeInactive: false }),
  ]);

  if ('error' in woResult) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load work orders. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/maintenance/work-orders`}>Retry</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const aircraft =
    'ok' in aircraftResult && aircraftResult.ok ? aircraftResult.aircraft : [];

  return (
    <WorkOrdersList
      initialWorkOrders={woResult.workOrders}
      aircraft={aircraft}
      slug={slug}
      canWorkOrder={canWorkOrder}
    />
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface WorkOrdersPageProps {
  params: Promise<{ slug: string }>;
}

export default async function WorkOrdersPage({ params }: WorkOrdersPageProps) {
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

  // ── Module gate (Slice CLUB-MODE) — fail-soft to enabled on read failure.
  // NOTE: redirect() must run OUTSIDE the try/catch — it throws to signal the
  // redirect, and a catch-all here would otherwise swallow that throw.
  let orgFeatures: Awaited<ReturnType<typeof getOrgFeatures>> | null = null;
  try {
    orgFeatures = await getOrgFeatures(session);
  } catch {
    orgFeatures = null;
  }
  if (orgFeatures && !orgFeatures.features.maintenance) {
    redirect(`/o/${slug}/no-access?reason=module_disabled`);
  }

  const canWorkOrder = hasCapability(session, 'maintenance:work_order');

  return (
    <Suspense fallback={<WorkOrdersListSkeleton />}>
      <WorkOrdersContent slug={slug} canWorkOrder={canWorkOrder} />
    </Suspense>
  );
}
