/**
 * fleet/locations/page.tsx — Base-location (airport) management (RSC).
 *
 * Route: /o/[slug]/fleet/locations
 * Capability gate: fleet:access to view (page-level requireCapability → redirect).
 *   Add/edit requires fleet:manage — the write controls are hidden for
 *   fleet:access-only roles (cfi) as a cosmetic guard; the server actions
 *   re-check fleet:manage regardless.
 *
 * WHY THIS PAGE: base coordinates power the civil-twilight (day/night)
 * scheduling calc AND satisfy the onboarding "base airport" step. Previously
 * only seed/tests could create a location — this is the first self-serve surface.
 *
 * States: Loading (Suspense) / Populated / Empty / Error / Permission-denied.
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { MapPin, AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { listLocationsAction } from '../actions';
import { LocationsClient } from './_components/locations-client';
import { PageHeader } from '@/components/ui/page-header';

function LocationsSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading locations">
      <Skeleton className="h-8 w-40" />
      <div className="rounded-md border border-slate-200 overflow-hidden">
        <div className="h-10 bg-slate-50 border-b border-slate-200" />
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-14 border-b border-slate-100 bg-white" />
        ))}
      </div>
    </div>
  );
}

async function LocationsContent({ slug, canManage }: { slug: string; canManage: boolean }) {
  const result = await listLocationsAction();

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load locations. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/fleet/locations`}>Retry</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return <LocationsClient locations={result.locations} slug={slug} canManage={canManage} />;
}

interface LocationsPageProps {
  params: Promise<{ slug: string }>;
}

export default async function LocationsPage({ params }: LocationsPageProps) {
  const { slug } = await params;
  const session = await auth();

  try {
    requireCapability(session, 'fleet:access');
  } catch (err) {
    const action = mapAuthErrorToResponse(err);
    if (action === 'forbidden') redirect(`/o/${slug}/no-access?reason=insufficient_role`);
    if (action === 'login') redirect(`/o/${slug}/login`);
    throw err;
  }

  const canManage = hasCapability(session, 'fleet:manage');

  return (
    <div className="space-y-4">
      <PageHeader
        backHref={`/o/${slug}/fleet`}
        backLabel="Fleet"
        title={
          <span className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-brand" aria-hidden="true" />
            Locations
          </span>
        }
        subtitle={
          <>
            Your bases and airports. Coordinates enable accurate day/night scheduling —
            operator data, not an FAA determination.
          </>
        }
      />
      <Suspense fallback={<LocationsSkeleton />}>
        <LocationsContent slug={slug} canManage={canManage} />
      </Suspense>
    </div>
  );
}
