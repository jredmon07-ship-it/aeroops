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
import { requireCapability, hasCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { listEnrollmentsAction, listCoursesAction } from '../actions';
import { EnrollmentsTable } from './_components/enrollments-table';
import { EnrollMemberDialog } from './_components/enroll-member-dialog';

// ─── Loading skeleton ──────────────────────────────────────────────────────────

function EnrollmentsListSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading enrollments">
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-9 w-36" />
      </div>
      <div className="rounded-md border border-slate-200 overflow-hidden">
        <div className="h-10 bg-slate-50 border-b border-slate-200" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-16 border-b border-slate-100 bg-white" />
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
      <div
        className="flex flex-col items-center justify-center py-16 text-center space-y-3"
        role="status"
      >
        <Users className="h-10 w-10 text-slate-300" aria-hidden="true" />
        <p className="text-slate-500 font-medium">
          {courseId ? 'No enrollments for this course.' : 'No enrollments yet.'}
        </p>
        {canManage ? (
          <>
            <p className="text-sm text-slate-400">Enroll a member to get started.</p>
            <EnrollMemberDialog slug={slug} courses={courses} initialCourseId={courseId} />
          </>
        ) : (
          <p className="text-sm text-slate-400">No members are enrolled in training yet.</p>
        )}
      </div>
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

  const canManage = hasCapability(session, 'training:manage');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link
              href={`/o/${slug}/training`}
              className="text-sm text-slate-500 hover:text-slate-700 transition-colors"
            >
              Training
            </Link>
            <span className="text-slate-300" aria-hidden="true">/</span>
            <span className="text-sm text-slate-700">Enrollments</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Enrollments</h1>
        </div>
        {canManage && (
          // Show the trigger; full dialog needs courses, loaded in content.
          // We pass a placeholder and courses will come from content.
          null
        )}
      </div>

      <Suspense fallback={<EnrollmentsListSkeleton />}>
        <EnrollmentsContent slug={slug} courseId={courseId} canManage={canManage} />
      </Suspense>
    </div>
  );
}
