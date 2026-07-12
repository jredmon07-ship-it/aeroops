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
import type { AircraftCursor } from '@aeroops/api';
import { listAircraftPageAction } from './actions';
import { FleetTable } from './_components/fleet-table';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';

// ─── Cursor codec (base64url JSON — URL-safe; mirrors activity feed) ───────────

function encodeAircraftCursor(cursor: AircraftCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeAircraftCursor(raw: string): AircraftCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'tailNumber' in parsed &&
      'id' in parsed &&
      typeof (parsed as Record<string, unknown>).tailNumber === 'string' &&
      typeof (parsed as Record<string, unknown>).id === 'string'
    ) {
      return parsed as AircraftCursor;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function FleetListSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading fleet">
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-8 w-24" />
      </div>
      <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="h-10 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800" />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-14 border-b border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900" />
        ))}
      </div>
    </div>
  );
}

// ─── Inner async component ────────────────────────────────────────────────────

interface FleetContentProps {
  slug: string;
  cursor: AircraftCursor | null;
}

async function FleetContent({ slug, cursor }: FleetContentProps) {
  const result = await listAircraftPageAction({
    includeInactive: true,
    ...(cursor ? { cursor } : {}),
  });

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

  const loadMoreHref = result.nextCursor
    ? `/o/${slug}/fleet?before=${encodeAircraftCursor(result.nextCursor)}`
    : null;

  if (aircraft.length === 0) {
    return (
      <EmptyState
        icon={Plane}
        title="No aircraft yet."
        body={
          <>
            Add aircraft in{' '}
            <Link
              href={`/o/${slug}/schedule/resources`}
              className="text-brand underline underline-offset-2 hover:text-brand-ink"
            >
              Resources admin
            </Link>
            .
          </>
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      <FleetTable aircraft={aircraft} slug={slug} />
      {loadMoreHref && (
        <div className="flex justify-center">
          <Button asChild variant="outline" size="sm">
            <Link href={loadMoreHref} aria-label="Load more aircraft">
              Load more
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface FleetPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ before?: string }>;
}

export default async function FleetPage({ params, searchParams }: FleetPageProps) {
  const { slug } = await params;
  const sp = await searchParams;
  const cursor = sp.before ? decodeAircraftCursor(sp.before) : null;
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
      <PageHeader
        title="Fleet"
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/fleet/locations`}>Locations &amp; base airports</Link>
          </Button>
        }
      />
      <Suspense fallback={<FleetListSkeleton />}>
        <FleetContent slug={slug} cursor={cursor} />
      </Suspense>
    </div>
  );
}
