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
import type { MemberCursor } from '@aeroops/api';
import { listMembersPageAction } from './actions';
import { MembersTable } from './_components/members-table';
import { AddMemberDialog } from './_components/add-member-dialog';
import { ActiveToggle } from './_components/active-toggle';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';

// ─── Cursor codec (base64url JSON — URL-safe; mirrors activity feed) ───────────

function encodeMemberCursor(cursor: MemberCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeMemberCursor(raw: string): MemberCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'sortName' in parsed &&
      'id' in parsed &&
      typeof (parsed as Record<string, unknown>).sortName === 'string' &&
      typeof (parsed as Record<string, unknown>).id === 'string'
    ) {
      return parsed as MemberCursor;
    }
    return null;
  } catch {
    return null;
  }
}

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
  cursor: MemberCursor | null;
}

async function PeopleContent({ slug, includeInactive, canManage, cursor }: PeopleContentProps) {
  const result = await listMembersPageAction({
    includeInactive,
    ...(cursor ? { cursor } : {}),
  });

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

  // Preserve the includeInactive filter across the "Load more" navigation.
  const baseParams = includeInactive ? 'includeInactive=1&' : '';
  const loadMoreHref = result.nextCursor
    ? `/o/${slug}/people?${baseParams}before=${encodeMemberCursor(result.nextCursor)}`
    : null;

  if (members.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title={includeInactive ? 'No members on this roster.' : 'No active members.'}
        body={
          !includeInactive && (
            <>
              Try enabling{' '}
              <Link
                href={`/o/${slug}/people?includeInactive=1`}
                className="text-brand underline underline-offset-2 hover:text-brand-ink"
              >
                Show inactive
              </Link>{' '}
              to see deactivated members.
            </>
          )
        }
        cta={canManage && <AddMemberDialog />}
      />
    );
  }

  return (
    <div className="space-y-4">
      <MembersTable members={members} slug={slug} />
      {loadMoreHref && (
        <div className="flex justify-center">
          <Button asChild variant="outline" size="sm">
            <Link href={loadMoreHref} aria-label="Load more members">
              Load more
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

interface PeoplePageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ includeInactive?: string; before?: string }>;
}

export default async function PeoplePage({ params, searchParams }: PeoplePageProps) {
  const { slug } = await params;
  const sp = await searchParams;
  const includeInactive = sp.includeInactive === '1';
  const cursor = sp.before ? decodeMemberCursor(sp.before) : null;
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
      <PageHeader
        title="People"
        actions={
          <>
            <ActiveToggle slug={slug} includeInactive={includeInactive} />
            {canManage && <AddMemberDialog />}
          </>
        }
      />

      <Suspense fallback={<PeopleListSkeleton />}>
        <PeopleContent
          slug={slug}
          includeInactive={includeInactive}
          canManage={canManage}
          cursor={cursor}
        />
      </Suspense>
    </div>
  );
}
