/**
 * maintenance/due/page.tsx — Maintenance-due list page (RSC, Slice P1.5).
 *
 * Route: /o/[slug]/maintenance/due
 * Capability gate: maintenance:access (page-level requireCapability → redirect).
 *
 * States:
 *   Loading           — Suspense skeleton.
 *   Populated         — MaintenanceDueList renders the table + filters.
 *   Empty             — Overlay "No maintenance items tracked yet" + Add if canManage.
 *   Error             — destructive Alert + Retry link.
 *   Permission-denied — redirect to no-access via requireCapability.
 *
 * Parallel-fetches listMaintenanceDue + listResources (aircraft only).
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
import { listMaintenanceDueAction } from '../due-actions';
import { MaintenanceDueList, MaintenanceDueListSkeleton } from './_components/maintenance-due-list';

// ─── Inner async component ────────────────────────────────────────────────────

interface DueContentProps {
  slug: string;
  canManage: boolean;
}

async function DueContent({ slug, canManage }: DueContentProps) {
  const [dueResult, resourcesResult] = await Promise.all([
    listMaintenanceDueAction({}),
    listResourcesAction({}),
  ]);

  if (!('ok' in dueResult) || !dueResult.ok) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load maintenance-due items. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/maintenance/due`}>Retry</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const items = dueResult.items;
  const aircraft = (resourcesResult && 'ok' in resourcesResult && resourcesResult.ok
    ? resourcesResult.resources
    : []
  ).filter((r) => r.kind === 'aircraft' && r.active);

  return <MaintenanceDueList initialItems={items} aircraft={aircraft} canManage={canManage} />;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface DuePageProps {
  params: Promise<{ slug: string }>;
}

export default async function MaintenanceDuePage({ params }: DuePageProps) {
  const { slug } = await params;
  const session = await auth();

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

  const canManage = hasCapability(session, 'maintenance:work_order');

  return (
    <Suspense fallback={<MaintenanceDueListSkeleton />}>
      <DueContent slug={slug} canManage={canManage} />
    </Suspense>
  );
}
