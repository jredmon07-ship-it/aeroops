/**
 * courses-table.tsx — Table of courses for the Training list page (Slice T1.3).
 *
 * Columns: Title (link to detail), Status chip, # Lessons, Status.
 *
 * [VERIFY-T1-B]: course status = operator lifecycle flag, NOT a regulatory status.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import type { CourseListRow } from '@aeroops/api';
import { courseStatusLabel } from './training-utils';

interface CoursesTableProps {
  courses: CourseListRow[];
  slug: string;
}

function CourseStatusChip({ status }: { status: string }) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center rounded-sm border border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-950/40 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-green-800 dark:text-green-200">
        {courseStatusLabel(status)}
      </span>
    );
  }
  if (status === 'archived') {
    return (
      <span className="inline-flex items-center rounded-sm border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-slate-500 dark:text-slate-400">
        {courseStatusLabel(status)}
      </span>
    );
  }
  return <span className="text-xs text-slate-400 dark:text-slate-500">{status}</span>;
}

export function CoursesTable({ courses, slug }: CoursesTableProps) {
  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-x-auto">
      <table className="w-full text-sm" aria-label="Courses">
        <thead>
          <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
            <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Title
            </th>
            <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Status
            </th>
            <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Lessons
            </th>
          </tr>
        </thead>
        <tbody>
          {courses.map((course) => (
            <tr
              key={course.courseId}
              className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              <td className="px-4 py-3">
                <Link
                  href={`/o/${slug}/training/${course.courseId}`}
                  className="font-medium text-brand hover:text-brand-ink hover:underline underline-offset-2"
                >
                  {course.title}
                </Link>
                {course.description && (
                  <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5 line-clamp-1">{course.description}</p>
                )}
              </td>
              <td className="px-4 py-3">
                <CourseStatusChip status={course.status} />
              </td>
              <td className="px-4 py-3 text-right">
                <span className="nums text-slate-700 dark:text-slate-300">{course.lessonCount}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
