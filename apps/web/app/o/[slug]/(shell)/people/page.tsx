/**
 * people/page.tsx — People/Members list page (RSC).
 *
 * Route: /o/[slug]/people
 * Capability gate: people:access (page-level requireCapability → redirect).
 *
 * States:
 *   Loading           — Suspense skeleton.
 *   Populated         — table: Name, Email, Role badge, Status chip, Tags chips +N, Phone.
 *   Empty             — "No members yet" state.
 *   Error             — destructive Alert + Retry link.
 *   Permission-denied — redirect to no-access via requireCapability.
 *
 * Active-only toggle uses a URL search param (?includeInactive=1) so it is
 * SSR-friendly and shareable.
 *
 * "Add member" button visible only if people:manage.
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Users, AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { listMembersAction } from './actions';
import { MembersTable } from './_components/members-table';
import { AddMemberDialog } from './_components/add-member-dialog';
import { ActiveToggle } from './_components/active-toggle';

// ─── Loading skeleton ──────────────────────────────────────────────────────────

function PeopleListSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading members">
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="rounded-md border border-slate-200 overflow-hidden">
        <div className="h-10 bg-slate-50 border-b border-slate-200" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-14 border-b border-slate-100 bg-white" />
        ))}
      </div>
    </div>
  );
}

// ─── Inner async component ─────────────────────────────────────────────────────

interface PeopleContentProps {
  slug: string;
  includeInactive: boolean;
  canManage: boolean;
}

async function PeopleContent({ slug, includeInactive, canManage }: PeopleContentProps) {
  const result = await listMembersAction({ includeInactive });

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load members. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/people`}>Retry</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const members = result.members;

  if (members.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-16 text-center space-y-3"
        role="status"
      >
        <Users className="h-10 w-10 text-slate-300" aria-hidden="true" />
        <p className="text-slate-500 font-medium">
          {includeInactive ? 'No members on this roster.' : 'No active members.'}
        </p>
        {!includeInactive && (
          <p className="text-sm text-slate-400">
            Try enabling{' '}
            <Link
              href={`/o/${slug}/people?includeInactive=1`}
              className="text-brand underline underline-offset-2 hover:text-brand-ink"
            >
              Show inactive
            </Link>{' '}
            to see deactivated members.
          </p>
        )}
        {canManage && <AddMemberDialog />}
      </div>
    );
  }

  return <MembersTable members={members} slug={slug} />;
}

// ─── Page ──────────────────────────────────────────────────────────────────────

interface PeoplePageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ includeInactive?: string }>;
}

export default async function PeoplePage({ params, searchParams }: PeoplePageProps) {
  const { slug } = await params;
  const sp = await searchParams;
  const includeInactive = sp.includeInactive === '1';
  const session = await auth();

  // ── RBAC gate ──────────────────────────────────────────────────────────────
  try {
    requireCapability(session, 'people:access');
  } catch (err) {
    const action = mapAuthErrorToResponse(err);
    if (action === 'forbidden') redirect(`/o/${slug}/no-access?reason=insufficient_role`);
    if (action === 'login') redirect(`/o/${slug}/login`);
    throw err;
  }

  const canManage = hasCapability(session, 'people:manage');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-900">People</h1>
        <div className="flex items-center gap-2">
          <ActiveToggle slug={slug} includeInactive={includeInactive} />
          {canManage && <AddMemberDialog />}
        </div>
      </div>

      <Suspense fallback={<PeopleListSkeleton />}>
        <PeopleContent slug={slug} includeInactive={includeInactive} canManage={canManage} />
      </Suspense>
    </div>
  );
}
