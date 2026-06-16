/**
 * schedule/resources/page.tsx — Resource Admin RSC page (Slice 1, spec §5).
 *
 * SERVER-SIDE RBAC GATE:
 *   requireCapability(session, 'schedule:manage_resources') is called first.
 *   ForbiddenError → redirect to no-access. UnauthenticatedError → redirect to login.
 *   This is the real gate — the nav link visibility is cosmetic only.
 *
 * DATA STRATEGY:
 *   - listResources({ includeInactive: true }) — fetches ALL resources (active + inactive)
 *     so the inactive section can be shown without a second fetch.
 *   - listOrgMembersAction({ role: ['cfi'] }) — fetches CFI members to populate the
 *     instructor picker in AddResourceDialog. Requires schedule:manage_resources (same cap).
 *   - Both fetches run in parallel via Promise.all for performance.
 *
 * STATES:
 *   Loading            — Suspense skeleton (ResourceListSkeleton) via loading.tsx sibling
 *   Populated          — ResourceList client component (tabs: Aircraft / Instructors)
 *   Error              — destructive Alert "Could not load resources. Try refreshing."
 *   Permission-denied  — redirect to /o/[slug]/no-access?reason=insufficient_role
 *
 * TENANT ISOLATION PROOF:
 *   org_id is sourced from session JWT (auth()), never the URL slug.
 *   Both listResources and listOrgMembers enforce RLS + requireCapability inside @aeroops/api.
 */

import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { auth } from '@/auth';
import { requireCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { listResourcesAction } from '../actions';
import { listOrgMembersAction } from '../actions';
import { ResourceList, ResourceListSkeleton } from './_components/resource-list';
import type { ResourceRow, OrgMemberRow } from '@aeroops/api';

interface ResourcesPageProps {
  params: Promise<{ slug: string }>;
}

export default async function ResourcesPage({ params }: ResourcesPageProps) {
  const { slug } = await params;
  const session = await auth();

  // ── Server-side RBAC gate ──────────────────────────────────────────────────
  try {
    requireCapability(session, 'schedule:manage_resources');
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

  // ── Fetch resources + CFI members in parallel ──────────────────────────────
  let resources: ResourceRow[] = [];
  let orgMembers: OrgMemberRow[] = [];
  let fetchError = false;

  try {
    const [resourcesResult, membersResult] = await Promise.all([
      listResourcesAction({ includeInactive: true }),
      listOrgMembersAction({ role: ['cfi'] }),
    ]);

    if ('error' in resourcesResult) {
      fetchError = true;
    } else {
      resources = resourcesResult.resources;
    }

    if ('error' in membersResult) {
      // Non-fatal: org members failure just means instructor picker is empty.
      // The dialog will still open but show no CFI options.
      orgMembers = [];
    } else {
      orgMembers = membersResult.members;
    }
  } catch {
    fetchError = true;
  }

  if (fetchError) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Resources</h1>
        </div>
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            Could not load resources. Try refreshing the page.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // ── Populated state: render client component ───────────────────────────────
  return (
    <Suspense fallback={<ResourceListSkeleton />}>
      <ResourceList resources={resources} orgMembers={orgMembers} />
    </Suspense>
  );
}
