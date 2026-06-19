/**
 * training/page.tsx — Training / Courses list page (RSC).
 *
 * Route: /o/[slug]/training
 * Capability gate: training:access (page-level requireCapability → redirect).
 *
 * States:
 *   Loading           — Suspense skeleton.
 *   Populated         — table: Title, Status chip, # Lessons, # Active enrollments.
 *   Empty             — "No courses yet" + Build course CTA if manage.
 *   Error             — destructive Alert + Retry link.
 *   Permission-denied — redirect to no-access via requireCapability.
 *
 * Primary action: Build course dialog (title + description) → createCourse.
 * Manage actions gated by training:manage.
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 * [VERIFY-T1-B]: course status 'active'/'archived' = operator lifecycle flag.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { GraduationCap, AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { listCoursesAction } from './actions';
import { CoursesTable } from './_components/courses-table';
import { BuildCourseDialog } from './_components/build-course-dialog';

// ─── Loading skeleton ──────────────────────────────────────────────────────────

function TrainingListSkeleton() {
  return (
    <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading courses">
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-9 w-36" />
      </div>
      <div className="rounded-lg border border-slate-200 overflow-hidden">
        <div className="h-10 bg-slate-50 border-b border-slate-200" />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-14 border-b border-slate-100 bg-white" />
        ))}
      </div>
    </div>
  );
}

// ─── Inner async component ─────────────────────────────────────────────────────

interface TrainingContentProps {
  slug: string;
  canManage: boolean;
}

async function TrainingContent({ slug, canManage }: TrainingContentProps) {
  const result = await listCoursesAction();

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load courses. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/training`}>Retry</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const courses = result.courses;

  if (courses.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-16 text-center space-y-3"
        role="status"
      >
        <GraduationCap className="h-10 w-10 text-slate-300" aria-hidden="true" />
        <p className="text-slate-500 font-medium">No courses yet.</p>
        {canManage ? (
          <>
            <p className="text-sm text-slate-400">Create your first course to get started.</p>
            <BuildCourseDialog slug={slug} />
          </>
        ) : (
          <p className="text-sm text-slate-400">
            No courses have been created for this organization.
          </p>
        )}
      </div>
    );
  }

  return <CoursesTable courses={courses} slug={slug} />;
}

// ─── Page ──────────────────────────────────────────────────────────────────────

interface TrainingPageProps {
  params: Promise<{ slug: string }>;
}

export default async function TrainingPage({ params }: TrainingPageProps) {
  const { slug } = await params;
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
        <h1 className="text-2xl font-bold text-slate-900">Training</h1>
        {canManage && <BuildCourseDialog slug={slug} />}
      </div>

      <Suspense fallback={<TrainingListSkeleton />}>
        <TrainingContent slug={slug} canManage={canManage} />
      </Suspense>
    </div>
  );
}
