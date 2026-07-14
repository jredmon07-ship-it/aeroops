/**
 * schedule/auto/page.tsx — Auto-scheduler page (RSC).
 *
 * Route: /o/[slug]/schedule/auto
 *
 * AUTHZ (server-side gate):
 *   requireCapability(session, 'schedule:create_reservation') — same cap as commit.
 *   No session → redirect to login.
 *   Forbidden  → redirect to no-access (permission-denied state).
 *
 * DATA: listResources fetched server-side (active only; passed to client form).
 *
 * STATES:
 *   Loading         — Suspense skeleton.
 *   Populated       — DemandBuilder → PreviewPanel → CommitPanel (client flow).
 *   Empty           — no active resources → info banner.
 *   Error           — listResources fetch failure → alert.
 *   Permission-denied — requireCapability throws → redirect to no-access.
 *
 * ONE PRIMARY ACTION PER STEP:
 *   Step 1 (building)  → "Preview" button in DemandBuilder.
 *   Step 2 (previewed) → "Commit schedule" in PreviewPanel (after explicit review).
 *   Step 3 (committed) → "View on board" in CommitPanel.
 *
 * BOUNDARY: imports only from @aeroops/api — never @aeroops/db.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { PlaneTakeoff, Wand2, AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, listResources, getOrgFeatures } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { AutoSchedulerClient } from './_components/auto-scheduler-client';
import { PageHeader } from '@/components/ui/page-header';

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function AutoSchedulerSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading auto-scheduler">
      <div className="rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4">
        <Skeleton className="h-6 w-40 mb-4" />
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </div>
      <div className="space-y-3">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="h-32 w-full" />
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-9 w-24" />
      </div>
    </div>
  );
}

// ─── Inner async component ────────────────────────────────────────────────────

interface AutoSchedulerContentProps {
  slug: string;
}

async function AutoSchedulerContent({ slug }: AutoSchedulerContentProps) {
  // Auth is already checked at page level; fetch session again for the resource
  // call. listResources uses the session's org_id (tenant-isolated by RLS).
  const session = await auth();

  let resources: Awaited<ReturnType<typeof listResources>> = [];
  let resourcesError = false;

  try {
    resources = await listResources(session, {});
  } catch {
    resourcesError = true;
  }

  const hasResources = resources.some((r) => r.kind === 'aircraft' && r.active);

  // Resource fetch error — non-fatal, show alert + still render the form.
  if (resourcesError) {
    return (
      <>
        <Alert variant="destructive" role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>
            Could not load aircraft. Try refreshing the page.
          </AlertDescription>
        </Alert>
        <AutoSchedulerClient resources={[]} slug={slug} />
      </>
    );
  }

  // Empty state — no active aircraft yet.
  if (!hasResources) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center space-y-4">
        <PlaneTakeoff className="h-12 w-12 text-slate-300" aria-hidden="true" />
        <div className="space-y-2">
          <p className="text-slate-700 dark:text-slate-300 font-medium">No aircraft available to schedule.</p>
          <p className="text-sm text-slate-500 dark:text-slate-400 max-w-sm">
            Add at least one active aircraft as a resource before using the auto-scheduler.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href={`/o/${slug}/schedule/resources`}>Manage resources</Link>
        </Button>
      </div>
    );
  }

  return <AutoSchedulerClient resources={resources} slug={slug} />;
}

// ─── Page component ───────────────────────────────────────────────────────────

interface AutoSchedulerPageProps {
  params: Promise<{ slug: string }>;
}

export default async function AutoSchedulerPage({ params }: AutoSchedulerPageProps) {
  const { slug } = await params;
  const session = await auth();

  // ── Server-side RBAC gate ─────────────────────────────────────────────────
  try {
    requireCapability(session, 'schedule:create_reservation');
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
  if (orgFeatures && !orgFeatures.features.auto_schedule) {
    redirect(`/o/${slug}/no-access?reason=module_disabled`);
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {/* ── Page heading ──────────────────────────────────────────────────── */}
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <Wand2 className="h-6 w-6 text-brand" aria-hidden="true" />
            Auto-scheduler
          </span>
        }
        subtitle="Define sessions to schedule, preview the proposed plan, then commit."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/schedule`}>Back to schedule</Link>
          </Button>
        }
      />

      {/* ── Instructions strip ────────────────────────────────────────────── */}
      <div className="rounded border border-brand/20 bg-brand/5 px-4 py-3 text-sm text-slate-700 dark:text-slate-300">
        <ol className="space-y-0.5 list-decimal list-inside">
          <li>Add the sessions you want to schedule below.</li>
          <li>Click <strong>Preview</strong> to see a proposed plan (no reservations created yet).</li>
          <li>Review the proposals, then click <strong>Commit schedule</strong> to create them.</li>
        </ol>
      </div>

      {/* ── Main form area under Suspense ─────────────────────────────────── */}
      <Suspense fallback={<AutoSchedulerSkeleton />}>
        <AutoSchedulerContent slug={slug} />
      </Suspense>
    </div>
  );
}
