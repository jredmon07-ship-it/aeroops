/**
 * fleet/page.tsx — Fleet list page (RSC).
 *
 * Route: /o/[slug]/fleet
 * Capability gate: fleet:access (page-level requireCapability → redirect).
 *
 * States:
 *   Loading           — Suspense skeleton.
 *   Populated         — table: tail # bold .nums, make+model, status chips.
 *   Empty             — "No aircraft yet" + link to Resources admin.
 *   Error             — destructive Alert + Retry link.
 *   Permission-denied — redirect to no-access via requireCapability.
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Plane, AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { listAircraftAction } from './actions';
import { FleetTable } from './_components/fleet-table';

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function FleetListSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading fleet">
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-8 w-24" />
      </div>
      <div className="rounded-md border border-slate-200 overflow-hidden">
        <div className="h-10 bg-slate-50 border-b border-slate-200" />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-14 border-b border-slate-100 bg-white" />
        ))}
      </div>
    </div>
  );
}

// ─── Inner async component ────────────────────────────────────────────────────

interface FleetContentProps {
  slug: string;
}

async function FleetContent({ slug }: FleetContentProps) {
  const result = await listAircraftAction({ includeInactive: true });

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load fleet. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/fleet`}>Retry</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const aircraft = result.aircraft;

  if (aircraft.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-16 text-center space-y-3"
        role="status"
      >
        <Plane className="h-10 w-10 text-slate-300" aria-hidden="true" />
        <p className="text-slate-500 font-medium">No aircraft yet.</p>
        <p className="text-sm text-slate-400">
          Add aircraft in{' '}
          <Link
            href={`/o/${slug}/schedule/resources`}
            className="text-brand underline underline-offset-2 hover:text-brand-ink"
          >
            Resources admin
          </Link>
          .
        </p>
      </div>
    );
  }

  return <FleetTable aircraft={aircraft} slug={slug} />;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface FleetPageProps {
  params: Promise<{ slug: string }>;
}

export default async function FleetPage({ params }: FleetPageProps) {
  const { slug } = await params;
  const session = await auth();

  // ── RBAC gate ──────────────────────────────────────────────────────────────
  try {
    requireCapability(session, 'fleet:access');
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Fleet</h1>
        <Button asChild variant="outline" size="sm">
          <Link href={`/o/${slug}/fleet/locations`}>Locations &amp; base airports</Link>
        </Button>
      </div>
      <Suspense fallback={<FleetListSkeleton />}>
        <FleetContent slug={slug} />
      </Suspense>
    </div>
  );
}
