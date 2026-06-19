/**
 * training/[courseId]/page.tsx — Course detail page (RSC).
 *
 * Route: /o/[slug]/training/[courseId]
 * Capability gate: training:access (page-level requireCapability → redirect).
 *
 * States:
 *   Loading           — Suspense skeleton.
 *   Populated         — header (title/description/status); ordered lessons list
 *                       (position, title, stage_label chip, description).
 *   Empty             — zero lessons hint.
 *   Not-found         — not_found → notFound().
 *   Error             — destructive Alert + Retry link.
 *   Permission-denied — redirect to no-access.
 *
 * Primary action: Add lesson dialog → addCourseLesson.
 * Secondary (manage): Remove lesson (confirm) → removeCourseLesson.
 *   has_records → inline "This lesson has recorded completions and cannot be removed."
 *
 * [VERIFY-T1-G]: stage_label is FREE-TEXT operator grouping, NOT a Part-141 stage.
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, BookOpen, AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { getCourseDetailAction } from '../actions';
import { CourseDetailClient } from '../_components/course-detail-client';

// ─── Loading skeleton ──────────────────────────────────────────────────────────

function CourseDetailSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading course detail">
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
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

interface CourseDetailContentProps {
  courseId: string;
  slug: string;
  canManage: boolean;
}

async function CourseDetailContent({ courseId, slug, canManage }: CourseDetailContentProps) {
  const result = await getCourseDetailAction({ courseId });

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load course. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/training/${courseId}`}>Retry</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!result.ok) {
    // not_found → Next.js 404
    notFound();
  }

  return (
    <CourseDetailClient
      course={result.course}
      slug={slug}
      canManage={canManage}
    />
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

interface CourseDetailPageProps {
  params: Promise<{ slug: string; courseId: string }>;
}

export default async function CourseDetailPage({ params }: CourseDetailPageProps) {
  const { slug, courseId } = await params;
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
      <div>
        <Link
          href={`/o/${slug}/training`}
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Training
        </Link>
      </div>

      <Suspense fallback={<CourseDetailSkeleton />}>
        <CourseDetailContent courseId={courseId} slug={slug} canManage={canManage} />
      </Suspense>
    </div>
  );
}
