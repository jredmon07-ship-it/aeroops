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
import { useParams } from 'next/navigation';
import type { CourseListRow } from '@aeroops/api';
import { courseStatusLabel } from './training-utils';

interface CoursesTableProps {
  courses: CourseListRow[];
  slug: string;
}

function CourseStatusChip({ status }: { status: string }) {
  if (status === 'active') {
    return (
      <span className="inline-flex items-center rounded-sm border border-green-200 bg-green-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-green-800">
        {courseStatusLabel(status)}
      </span>
    );
  }
  if (status === 'archived') {
    return (
      <span className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-slate-500">
        {courseStatusLabel(status)}
      </span>
    );
  }
  return <span className="text-xs text-slate-400">{status}</span>;
}

export function CoursesTable({ courses, slug }: CoursesTableProps) {
  return (
    <div className="rounded-md border border-slate-200 overflow-hidden">
      <table className="w-full text-sm" aria-label="Courses">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200">
            <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
              Title
            </th>
            <th scope="col" className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
              Status
            </th>
            <th scope="col" className="px-4 py-3 text-right text-xs font-medium text-slate-500 uppercase tracking-wide">
              Lessons
            </th>
          </tr>
        </thead>
        <tbody>
          {courses.map((course) => (
            <tr
              key={course.courseId}
              className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors"
            >
              <td className="px-4 py-3">
                <Link
                  href={`/o/${slug}/training/${course.courseId}`}
                  className="font-medium text-brand hover:text-brand-ink hover:underline underline-offset-2"
                >
                  {course.title}
                </Link>
                {course.description && (
                  <p className="text-xs text-slate-400 mt-0.5 line-clamp-1">{course.description}</p>
                )}
              </td>
              <td className="px-4 py-3">
                <CourseStatusChip status={course.status} />
              </td>
              <td className="px-4 py-3 text-right">
                <span className="nums text-slate-700">{course.lessonCount}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
