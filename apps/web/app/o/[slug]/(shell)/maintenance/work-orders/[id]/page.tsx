/**
 * maintenance/work-orders/[id]/page.tsx — Work order detail page (RSC).
 *
 * Route: /o/[slug]/maintenance/work-orders/[id]
 * Capability gate: maintenance:access (page-level requireCapability → redirect).
 *
 * States:
 *   Loading           — Suspense skeleton.
 *   Populated         — header + linked squawk + work performed + sign-off/cancel block.
 *   Not-found         — empty state card.
 *   Error             — destructive Alert.
 *   Permission-denied — redirect to no-access via requireCapability.
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 * [VERIFY-M1-A/C/D]: compliance disclaimers rendered in WorkOrderDetailClient.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Wrench, AlertCircle, ArrowLeft } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { getWorkOrderDetailAction } from '../actions';
import { getAircraftDetailAction } from '../../../fleet/actions';
import { WorkOrderDetailClient } from '../_components/work-order-detail-client';

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function DetailSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading work order">
      <Skeleton className="h-4 w-24" />
      <div className="space-y-2">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-32" />
      </div>
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  );
}

// ─── Inner async component ────────────────────────────────────────────────────

interface DetailContentProps {
  workOrderId: string;
  slug: string;
  canWorkOrder: boolean;
  canResolveSquawk: boolean;
  canUnground: boolean;
}

async function DetailContent({
  workOrderId,
  slug,
  canWorkOrder,
  canResolveSquawk,
  canUnground,
}: DetailContentProps) {
  const result = await getWorkOrderDetailAction({ workOrderId });

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load work order. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/maintenance/work-orders/${workOrderId}`}>Retry</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!result.ok) {
    return (
      <div
        className="flex flex-col items-center justify-center py-16 text-center space-y-3"
        role="status"
      >
        <Wrench className="h-10 w-10 text-slate-300" aria-hidden="true" />
        <p className="text-slate-700 dark:text-slate-300 font-medium">Work order not found.</p>
        <p className="text-sm text-slate-400 dark:text-slate-500">
          It may have been removed or you may not have access.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href={`/o/${slug}/maintenance/work-orders`}>
            <ArrowLeft className="h-4 w-4 mr-1" aria-hidden="true" />
            Back to Work orders
          </Link>
        </Button>
      </div>
    );
  }

  const { workOrder, squawk: linkedSquawk } = result;

  // Load aircraft detail for grounding info (grounding basis matching).
  // Fleet detail is gated by fleet:access; if the user lacks it the RPC
  // returns an auth error and we gracefully degrade (isGrounded=false).
  let isGrounded = false;
  let groundingMatchesSquawk = false;
  let groundingSquawkId: string | null = null;

  const aircraftResult = await getAircraftDetailAction({
    resourceId: workOrder.resourceId,
  });

  if ('ok' in aircraftResult && aircraftResult.ok) {
    const grounding = aircraftResult.aircraft.grounding;
    isGrounded = grounding.grounded;
    // For grounding basis matching: the grounding event's squawkId must equal
    // this WO's squawkId. The grounding view includes eventId but not squawkId
    // directly — we check if both WO and grounding are linked to the same squawk.
    // Per the spec shouldUngroundForWorkOrder: latest grounding event squawk_id
    // == WO squawk_id. We surface this by checking workOrder.squawkId matches
    // a field available from the fleet grounding view.
    // NOTE: GroundingStatusView does not expose squawkId directly (it was not in
    // the original type). We therefore rely on a conservative: if the WO has a
    // squawkId AND the aircraft is grounded, we surface both checkboxes and let
    // the server-side shouldUngroundForWorkOrder make the real determination.
    // The UI shows "grounded for a different reason" from the server's skip result.
    // For the initial render, assume it could match (conservative = show checkbox).
    groundingSquawkId = null; // not directly available in GroundingStatusView
    groundingMatchesSquawk = isGrounded && workOrder.squawkId !== null;
  }

  return (
    <WorkOrderDetailClient
      workOrder={workOrder}
      linkedSquawk={linkedSquawk}
      isGrounded={isGrounded}
      groundingMatchesSquawk={groundingMatchesSquawk}
      groundingSquawkId={groundingSquawkId}
      slug={slug}
      canWorkOrder={canWorkOrder}
      canResolveSquawk={canResolveSquawk}
      canUnground={canUnground}
    />
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface WorkOrderDetailPageProps {
  params: Promise<{ slug: string; id: string }>;
}

export default async function WorkOrderDetailPage({ params }: WorkOrderDetailPageProps) {
  const { slug, id } = await params;
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

  const canWorkOrder = hasCapability(session, 'maintenance:work_order');
  const canResolveSquawk = hasCapability(session, 'maintenance:squawk');
  const canUnground = hasCapability(session, 'maintenance:ground');

  return (
    <Suspense fallback={<DetailSkeleton />}>
      <DetailContent
        workOrderId={id}
        slug={slug}
        canWorkOrder={canWorkOrder}
        canResolveSquawk={canResolveSquawk}
        canUnground={canUnground}
      />
    </Suspense>
  );
}
