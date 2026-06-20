/**
 * member-training-card.tsx — Training card on the People detail page (Slice T1.3).
 *
 * Renders this member's enrollments (course title, status chip, progress ratio),
 * each linking to the enrollment detail. Shows for people:access holders.
 *
 * Fetches via listEnrollmentsForMemberAction (training:access; the API enforces the
 * cap). If the session lacks training:access, the API will throw ForbiddenError and
 * this card will silently render empty (fail-closed for roles without training cap).
 *
 * COMPLIANCE:
 *   [VERIFY-T1-B]: progressRatio and status='completed' are operator content-state
 *   flags ONLY — NOT Part-141 graduation or regulatory completion.
 */
import * as React from 'react';
import Link from 'next/link';
import { GraduationCap } from 'lucide-react';
import { listEnrollmentsForMemberAction } from '../../training/actions';
import { enrollmentStatusLabel, formatProgress } from '../../training/_components/training-utils';

function EnrollmentStatusChip({ status }: { status: string }) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center rounded-sm border border-brand/30 bg-brand/8 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-brand-ink">
        {enrollmentStatusLabel(status)}
      </span>
    );
  }
  if (status === 'completed') {
    return (
      <span
        className="inline-flex items-center rounded-sm border border-green-200 bg-green-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-green-800"
        title="Operator content flag — not a regulatory completion [VERIFY-T1-B]"
      >
        {enrollmentStatusLabel(status)}
      </span>
    );
  }
  if (status === 'withdrawn') {
    return (
      <span className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-slate-500">
        {enrollmentStatusLabel(status)}
      </span>
    );
  }
  return <span className="text-xs text-slate-400">{status}</span>;
}

interface MemberTrainingCardProps {
  userId: string;
  slug: string;
}

export async function MemberTrainingCard({ userId, slug }: MemberTrainingCardProps) {
  // Fail-closed: if training:access not held, returns empty (API throws Forbidden
  // which the action converts to { error: 'forbidden' }).
  let enrollments: Array<{
    enrollmentId: string;
    courseTitle: string;
    status: string;
    completedCount: number;
    totalLessons: number;
  }> = [];

  try {
    const result = await listEnrollmentsForMemberAction({ userId });
    if (result && 'ok' in result && result.ok) {
      enrollments = result.enrollments;
    }
    // On auth error or server error: render empty (fail-closed, no crash)
  } catch {
    // fail-closed
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center gap-2">
        <GraduationCap className="h-4 w-4 text-slate-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-slate-700">Training</h2>
        <span className="nums text-xs text-slate-400">({enrollments.length})</span>
      </div>

      {/* [VERIFY-T1-B]: progress and status are operator content flags, NOT Part-141 */}
      {enrollments.length === 0 ? (
        <p className="text-sm text-slate-400 italic">No enrollments.</p>
      ) : (
        <div className="space-y-2">
          {enrollments.map((e) => (
            <div
              key={e.enrollmentId}
              className="flex items-center justify-between gap-3 rounded-md bg-slate-50 px-3 py-2"
            >
              <div className="min-w-0 space-y-0.5">
                <Link
                  href={`/o/${slug}/training/enrollments/${e.enrollmentId}`}
                  className="text-sm font-medium text-brand hover:text-brand-ink hover:underline underline-offset-2 block truncate"
                >
                  {e.courseTitle}
                </Link>
                {/* [VERIFY-T1-B]: NOT a Part-141 completion ratio */}
                <p className="nums text-xs text-slate-400">
                  {formatProgress(e.completedCount, e.totalLessons)}
                </p>
              </div>
              <EnrollmentStatusChip status={e.status} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
