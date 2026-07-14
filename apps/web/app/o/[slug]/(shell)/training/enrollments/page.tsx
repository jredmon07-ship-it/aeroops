/**
 * training/enrollments/page.tsx — Enrollments list page (RSC).
 *
 * Route: /o/[slug]/training/enrollments
 * Capability gate: training:access (page-level requireCapability → redirect).
 *
 * States:
 *   Loading           — Suspense skeleton.
 *   Populated         — table: Student, Course, Status chip, Progress (ratio + bar).
 *   Empty             — "No enrollments yet" + Enroll member CTA if manage.
 *   Error             — destructive Alert + Retry link.
 *   Permission-denied — redirect to no-access.
 *
 * Filters: ?courseId=<uuid> (optional course filter).
 * Primary action: Enroll member dialog (pick course + pick member) → enrollMember.
 *
 * [VERIFY-T1-B]: progress bar is a content-coverage indicator ONLY.
 * NOT a Part-141 completion rate or regulatory determination.
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Users, AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability, getOrgFeatures } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { listEnrollmentsAction, listCoursesAction } from '../actions';
import { EnrollmentsTable } from './_components/enrollments-table';
import { EnrollMemberDialog } from './_components/enroll-member-dialog';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';

// ─── Loading skeleton ──────────────────────────────────────────────────────────

function EnrollmentsListSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading enrollments">
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-9 w-36" />
      </div>
      <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="h-10 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-16 border-b border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900" />
        ))}
      </div>
    </div>
  );
}

// ─── Inner async component ─────────────────────────────────────────────────────

interface EnrollmentsContentProps {
  slug: string;
  courseId?: string;
  canManage: boolean;
}

async function EnrollmentsContent({ slug, courseId, canManage }: EnrollmentsContentProps) {
  // Fetch enrollments (and optionally courses for the Enroll dialog) in parallel.
  const [enrollResult, coursesResult] = await Promise.all([
    listEnrollmentsAction(courseId ? { courseId } : undefined),
    canManage ? listCoursesAction() : Promise.resolve(null),
  ]);

  if ('error' in enrollResult) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load enrollments. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/training/enrollments`}>Retry</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const enrollments = enrollResult.enrollments;
  const courses =
    coursesResult && !('error' in coursesResult) && coursesResult.ok
      ? coursesResult.courses
      : [];

  if (enrollments.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title={courseId ? 'No enrollments for this course.' : 'No enrollments yet.'}
        body={
          canManage
            ? 'Enroll a member to get started.'
            : 'No members are enrolled in training yet.'
        }
        cta={
          canManage && (
            <EnrollMemberDialog slug={slug} courses={courses} initialCourseId={courseId} />
          )
        }
      />
    );
  }

  return (
    <EnrollmentsTable
      enrollments={enrollments}
      slug={slug}
      canManage={canManage}
      courses={courses}
      initialCourseId={courseId}
    />
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

interface EnrollmentsPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ courseId?: string }>;
}

export default async function EnrollmentsPage({ params, searchParams }: EnrollmentsPageProps) {
  const { slug } = await params;
  const sp = await searchParams;
  const courseId = sp.courseId;
  const session = await auth();

  // ── RBAC gate ──────────────────────────────────────────────────────────────
  try {
    requireCapability(session, 'training:access');
  } catch (err) {
    const action = mapAuthErrorToResponse(err);
    if (action === 'forbidden') redirect(`/o/${slug}/no-access?reason=insufficient_role`);
    if (action === 'login') redirect(`/o/${slug}/login`);
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
  if (orgFeatures && !orgFeatures.features.training) {
    redirect(`/o/${slug}/no-access?reason=module_disabled`);
  }

  const canManage = hasCapability(session, 'training:manage');

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Link
            href={`/o/${slug}/training`}
            className="text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
          >
            Training
          </Link>
          <span className="text-slate-300" aria-hidden="true">/</span>
          <span className="text-sm text-slate-700 dark:text-slate-300">Enrollments</span>
        </div>
        <PageHeader title="Enrollments" />
      </div>

      <Suspense fallback={<EnrollmentsListSkeleton />}>
        <EnrollmentsContent slug={slug} courseId={courseId} canManage={canManage} />
      </Suspense>
    </div>
  );
}
