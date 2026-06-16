/**
 * schedule/series/[seriesId]/page.tsx — Series View RSC page.
 *
 * Route: /o/[slug]/schedule/series/[seriesId]
 * Capability: schedule:access (read gate); schedule:create_reservation (cancel gate).
 *
 * AUTHZ:
 *   requireCapability(session, 'schedule:access') → ForbiddenError → redirect no-access.
 *   hasCapability used for cancel trigger (UI-only; API gate enforces on action).
 *
 * DATA:
 *   listSeriesOccurrencesAction({seriesId}) → series row + occurrence ReservationRow[].
 *
 * States:
 *   Loading         — Suspense skeleton (3 rows)
 *   Populated       — rule summary + occurrence list
 *   Empty           — occurrence list shows empty state
 *   Error           — server error fetching series
 *   Not found       — series not visible in this org
 *   Permission denied — requireCapability throws → redirect no-access
 *
 * BOUNDARY: imports only from @aeroops/api — never @aeroops/db.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/auth';
import { requireCapability, hasCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SeriesRuleSummary } from './_components/series-rule-summary';
import { SeriesOccurrenceList } from './_components/series-occurrence-list';
import { listSeriesOccurrencesAction } from '../../actions';

// ─── Props ────────────────────────────────────────────────────────────────────

interface SeriesPageProps {
  params: Promise<{ slug: string; seriesId: string }>;
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function SeriesSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading series">
      <Skeleton className="h-36 w-full" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  );
}

// ─── Inner async component ────────────────────────────────────────────────────

interface SeriesContentProps {
  slug: string;
  seriesId: string;
  canCancel: boolean;
}

async function SeriesContent({ slug, seriesId, canCancel }: SeriesContentProps) {
  const result = await listSeriesOccurrencesAction({ seriesId });

  // Auth errors
  if ('error' in result) {
    if (result.error === 'forbidden') {
      redirect(`/o/${slug}/no-access?reason=insufficient_role`);
    }
    if (result.error === 'unauthenticated') {
      redirect(`/o/${slug}/login`);
    }
    // Server error
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>
          Could not load the series. Try refreshing the page.
        </AlertDescription>
      </Alert>
    );
  }

  // Not found
  if (!result.ok) {
    notFound();
  }

  const { series, occurrences } = result;

  return (
    <div className="space-y-6">
      <SeriesRuleSummary series={series} />
      <SeriesOccurrenceList
        series={series}
        occurrences={occurrences}
        slug={slug}
        canCancel={canCancel}
      />
    </div>
  );
}

// ─── Page component ───────────────────────────────────────────────────────────

export default async function SeriesPage({ params }: SeriesPageProps) {
  const { slug, seriesId } = await params;
  const session = await auth();

  // ── Server-side RBAC gate ─────────────────────────────────────────────────
  try {
    requireCapability(session, 'schedule:access');
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

  // UI-only: hide cancel trigger if insufficient capability
  // Real gate is cancelSeriesAction → requireCapability('schedule:create_reservation')
  const canCancel = hasCapability(session, 'schedule:create_reservation');

  return (
    <div className="space-y-4">
      {/* ── Page heading ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-slate-900">Series Occurrences</h1>
        <Button asChild variant="outline" size="sm">
          <Link href={`/o/${slug}/schedule`}>Back to Schedule</Link>
        </Button>
      </div>

      {/* ── Series content under Suspense ─────────────────────────────────── */}
      <Suspense fallback={<SeriesSkeleton />}>
        <SeriesContent slug={slug} seriesId={seriesId} canCancel={canCancel} />
      </Suspense>
    </div>
  );
}
