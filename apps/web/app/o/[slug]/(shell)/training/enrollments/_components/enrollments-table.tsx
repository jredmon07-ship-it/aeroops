/**
 * enrollments-table.tsx — Table of enrollments (Slice T1.3).
 *
 * Columns: Student, Course, Status chip, Progress (ratio + bar).
 *
 * [VERIFY-T1-B]: progress bar is a content-coverage indicator ONLY.
 * NOT a Part-141 completion rate or regulatory determination.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import type { EnrollmentListRow, CourseListRow } from '@aeroops/api';
import { EnrollMemberDialog } from './enroll-member-dialog';
import { enrollmentStatusLabel, formatProgress } from '../../_components/training-utils';

interface EnrollmentsTableProps {
  enrollments: EnrollmentListRow[];
  slug: string;
  canManage: boolean;
  courses: CourseListRow[];
  initialCourseId?: string;
}

function EnrollmentStatusChip({ status }: { status: string }) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center rounded-sm border border-brand/30 bg-brand/8 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-brand-ink">
        {enrollmentStatusLabel(status)}
      </span>
    );
  }
  if (status === 'completed') {
    return (
      <span
        className="inline-flex items-center rounded-sm border border-green-200 bg-green-50 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-green-800"
        title="Operator content flag — not a regulatory completion [VERIFY-T1-B]"
      >
        {enrollmentStatusLabel(status)}
      </span>
    );
  }
  if (status === 'withdrawn') {
    return (
      <span className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-slate-500">
        {enrollmentStatusLabel(status)}
      </span>
    );
  }
  return <span className="text-xs text-slate-400">{status}</span>;
}

/**
 * ProgressBar — visual content-coverage bar.
 * [VERIFY-T1-B]: NOT a Part-141 completion indicator.
 */
function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div
      className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden"
      role="presentation"
      aria-hidden="true"
    >
      <div
        className="h-full rounded-full bg-brand transition-all"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

export function EnrollmentsTable({
  enrollments,
  slug,
  canManage,
  courses,
  initialCourseId,
}: EnrollmentsTableProps) {
  return (
    <div className="space-y-3">
      {canManage && (
        <div className="flex justify-end">
          <EnrollMemberDialog slug={slug} courses={courses} initialCourseId={initialCourseId} />
        </div>
      )}

      <div className="rounded-md border border-slate-200 overflow-x-auto">
        <table className="w-full text-sm" aria-label="Enrollments">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                Student
              </th>
              <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden sm:table-cell">
                Course
              </th>
              <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                Status
              </th>
              <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden md:table-cell">
                Progress
              </th>
            </tr>
          </thead>
          <tbody>
            {enrollments.map((enrollment) => (
              <tr
                key={enrollment.enrollmentId}
                className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors"
              >
                <td className="px-4 py-3">
                  <Link
                    href={`/o/${slug}/training/enrollments/${enrollment.enrollmentId}`}
                    className="font-medium text-brand hover:text-brand-ink hover:underline underline-offset-2"
                  >
                    {enrollment.studentName}
                  </Link>
                  {/* Course shown inline on mobile */}
                  <p className="text-xs text-slate-400 mt-0.5 sm:hidden line-clamp-1">
                    {enrollment.courseTitle}
                  </p>
                </td>
                <td className="px-4 py-3 hidden sm:table-cell">
                  <Link
                    href={`/o/${slug}/training/${enrollment.courseId}`}
                    className="text-slate-700 hover:text-brand hover:underline underline-offset-2"
                  >
                    {enrollment.courseTitle}
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <EnrollmentStatusChip status={enrollment.status} />
                </td>
                <td className="px-4 py-3 hidden md:table-cell">
                  {/* [VERIFY-T1-B]: content-coverage indicator, NOT Part-141 determination */}
                  <div className="space-y-1 min-w-[120px]">
                    <span className="nums text-xs text-slate-700">
                      {formatProgress(enrollment.completedCount, enrollment.totalLessons)}
                    </span>
                    <ProgressBar percent={enrollment.progressPercent} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
