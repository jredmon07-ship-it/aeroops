/**
 * training-utils.ts — Pure display helpers for the Training module (Slice T1.3).
 *
 * PURE: no DOM, no React, no Next.js, no I/O. Unit-testable.
 *
 * COMPLIANCE POSTURE:
 *   [VERIFY-T1-B]: formatProgress returns a content-coverage ratio string ONLY.
 *   It is NOT a Part-141 completion rate or regulatory determination.
 *   [VERIFY-T1-A]: grade_label is FREE-TEXT only — displayed as-is.
 */

import { formatZonedDate, formatZonedDateTime } from '@/lib/zoned-format';

// ─── formatProgress ────────────────────────────────────────────────────────────

/**
 * formatProgress — renders the completed/total ratio with percent.
 *
 * [VERIFY-T1-B]: content-coverage indicator ONLY. NOT a Part-141 80%-completion-rate.
 *
 * @param completed - DISTINCT 'recorded' lesson_record count (numerator).
 * @param total     - course_lesson count (denominator).
 * @returns         - e.g. "3 / 8 — 38%" or "0 / 0 — 0%"
 */
export function formatProgress(completed: number, total: number): string {
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);
  return `${completed} / ${total} — ${pct}%`;
}

// ─── enrollmentStatusLabel ────────────────────────────────────────────────────

/**
 * enrollmentStatusLabel — human-readable label for an enrollment status.
 *
 * [VERIFY-T1-B]: 'completed' = operator flag, NOT Part-141 graduation.
 */
export function enrollmentStatusLabel(status: string): string {
  switch (status) {
    case 'active':    return 'Active';
    case 'completed': return 'Completed';
    case 'withdrawn': return 'Withdrawn';
    default:          return status;
  }
}

// ─── courseStatusLabel ────────────────────────────────────────────────────────

export function courseStatusLabel(status: string): string {
  switch (status) {
    case 'active':   return 'Active';
    case 'archived': return 'Archived';
    default:         return status;
  }
}

// ─── formatDateTime / formatDate (ISO string → text in the viewer's zone) ────
// `timeZone` is the zone the page resolved (getViewerTimeZone): the client
// components render on the server first, where the runtime's zone is UTC.

export function formatDateTime(iso: string | null | undefined, timeZone: string): string {
  return formatZonedDateTime(iso, timeZone);
}

export function formatDate(iso: string | null | undefined, timeZone: string): string {
  return formatZonedDate(iso, timeZone);
}
