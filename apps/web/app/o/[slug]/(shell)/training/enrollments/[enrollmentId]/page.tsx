/**
 * training/enrollments/[enrollmentId]/page.tsx — Enrollment detail page (RSC).
 *
 * Route: /o/[slug]/training/enrollments/[enrollmentId]
 * Capability gate: training:access (page-level requireCapability → redirect).
 *
 * States:
 *   Loading           — Suspense skeleton.
 *   Populated         — student + course header; progress summary (ratio + bar,
 *                       labeled "operator progress — NOT a regulatory completion");
 *                       per-lesson checklist (completed ✓/not, instructor/completed_at/grade/notes);
 *                       full record log (voided struck-through); status controls (Complete/Withdraw).
 *   Not-found         — not_found card.
 *   Error             — destructive Alert + Retry link.
 *   Permission-denied — redirect to no-access.
 *
 * Primary: Record lesson dialog (pick lesson + pick instructor + completedAt/grade/notes).
 * Secondary: Void a record (confirm + required reason).
 * Status: Complete / Withdraw → setEnrollmentStatus.
 *
 * COMPLIANCE:
 *   [VERIFY-T1-B]: progress % = content-coverage indicator ONLY, NOT Part-141 determination.
 *   [VERIFY-T1-A]: grade_label = FREE-TEXT only, NOT a computed ACS/Part-61/141 verdict.
 *   [VERIFY-T1-C]: lesson_record = DATA ENTRY, NOT an e-signature.
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 */
import * as React from 'react';
import { Suspense } from 'react';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, AlertCircle, Users } from 'lucide-react';
import { auth } from '@/auth';
import { requireCapability, hasCapability, getOrgFeatures } from '@aeroops/api';
import { mapAuthErrorToResponse } from '@/lib/auth-errors';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { getEnrollmentDetailAction } from '../../actions';
import { EnrollmentDetailClient } from '../../_components/enrollment-detail-client';

// ─── Loading skeleton ──────────────────────────────────────────────────────────

function EnrollmentDetailSkeleton() {
  return (
    <div className="space-y-6 animate-pulse" aria-busy="true" aria-label="Loading enrollment detail">
      <div className="space-y-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-8 w-64" />
      </div>
      <Skeleton className="h-20 w-full" />
      <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
        <div className="h-10 bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800" />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-12 border-b border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900" />
        ))}
      </div>
    </div>
  );
}

// ─── Inner async component ─────────────────────────────────────────────────────

interface EnrollmentDetailContentProps {
  enrollmentId: string;
  slug: string;
  canManage: boolean;
}

async function EnrollmentDetailContent({
  enrollmentId,
  slug,
  canManage,
}: EnrollmentDetailContentProps) {
  const result = await getEnrollmentDetailAction({ enrollmentId });

  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load enrollment. Please try again.</span>
          <Button asChild variant="outline" size="sm">
            <Link href={`/o/${slug}/training/enrollments/${enrollmentId}`}>Retry</Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!result.ok) {
    return (
      <div
        className="flex flex-col items-center justify-center py-16 text-center space-y-3"
        role="status"
      >
        <Users className="h-10 w-10 text-slate-300" aria-hidden="true" />
        <p className="text-slate-700 dark:text-slate-300 font-medium">Enrollment not found.</p>
        <p className="text-sm text-slate-400 dark:text-slate-500">
          It may have been removed or you may not have access.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href={`/o/${slug}/training/enrollments`}>
            <ArrowLeft className="h-4 w-4 mr-1" aria-hidden="true" />
            Back to Enrollments
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <EnrollmentDetailClient
      enrollment={result.enrollment}
      slug={slug}
      canManage={canManage}
    />
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

interface EnrollmentDetailPageProps {
  params: Promise<{ slug: string; enrollmentId: string }>;
}

export default async function EnrollmentDetailPage({ params }: EnrollmentDetailPageProps) {
  const { slug, enrollmentId } = await params;
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
        <Link
          href={`/o/${slug}/training/enrollments`}
          className="inline-flex items-center gap-1 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          Enrollments
        </Link>
      </div>

      <Suspense fallback={<EnrollmentDetailSkeleton />}>
        <EnrollmentDetailContent
          enrollmentId={enrollmentId}
          slug={slug}
          canManage={canManage}
        />
      </Suspense>
    </div>
  );
}
