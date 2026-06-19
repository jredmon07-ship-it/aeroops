/**
 * training/progress.ts — Pure progress ratio computation for the Training Hub.
 *
 * `progressRatioFromCounts` is the ONLY computed number in the Training API.
 * It is a CONTENT RATIO (completedLessons / totalLessons), NOT a regulatory
 * completion determination.
 *
 * COMPLIANCE POSTURE [VERIFY-T1-B]:
 *   - The percent value (0–100) is a content-coverage indicator only.
 *   - enrollment.status='completed' is an operator toggle, NOT a Part-141
 *     80%-completion-rate determination, graduation, or certificate.
 *   - This function has zero I/O and zero regulatory logic; it may be imported
 *     anywhere without compliance risk.
 *
 * UNIT-TESTED per spec §3 table:
 *   0/0 → 0%  (no div-by-zero)
 *   0/5 → 0%
 *   1/3 → 33%
 *   2/3 → 67%
 *   3/5 → 60%
 *   5/5 → 100%
 *   6/5 → clamp 100% (over-record-after-re-record edge case)
 *   negative completed → clamp 0% (defensive guard)
 *   negative total    → 0%  (treated as zero-lesson course)
 */

// ─── ProgressRatioResult ──────────────────────────────────────────────────────

/**
 * ProgressRatioResult — the complete progress snapshot.
 *
 * [VERIFY-T1-B]: ratio and percent are content-coverage indicators ONLY.
 * They are NOT a Part-141 completion-rate determination or graduation criterion.
 *
 * @field completed - The count of DISTINCT lessons with a 'recorded' lesson_record.
 *                    Voided records are excluded from the numerator.
 * @field total     - The count of course_lesson rows in the course (the denominator).
 * @field ratio     - completed/total, clamped to [0, 1]. 0.0 when total === 0.
 * @field percent   - Math.round(ratio * 100). Integer 0–100.
 */
export interface ProgressRatioResult {
  completed: number;
  total: number;
  ratio: number;
  /** Integer percent: Math.round(ratio * 100), range [0, 100]. */
  percent: number;
}

// ─── progressRatioFromCounts ──────────────────────────────────────────────────

/**
 * progressRatioFromCounts — compute the operator content-coverage progress ratio.
 *
 * Pure function: no I/O, deterministic, no FAA/regulatory logic.
 *
 * Contract:
 *   - total <= 0 (zero-lesson course or defensive negative) → ratio = 0, percent = 0.
 *   - completed <= 0 → ratio = 0 (defensive; negative inputs treated as 0).
 *   - completed > total → ratio = 1, percent = 100 (clamped; e.g. void+re-record).
 *   - Otherwise ratio = completed / total; percent = Math.round(ratio * 100).
 *
 * @param completed - Count of DISTINCT lessons with a 'recorded' record (numerator).
 *                    Must be a non-negative integer in practice; negative → clamped 0.
 * @param total     - Count of course_lesson rows (denominator).
 *                    Zero or negative → 0% (no div-by-zero). [VERIFY-T1-B]
 * @returns ProgressRatioResult with all four fields.
 */
export function progressRatioFromCounts(
  completed: number,
  total: number,
): ProgressRatioResult {
  // Defensive clamp: negative inputs treated as zero.
  const safeCompleted = Math.max(0, completed);
  const safeTotal = Math.max(0, total);

  // Guard: zero-lesson course → 0% (no div-by-zero). [VERIFY-T1-B]
  if (safeTotal === 0) {
    return { completed: safeCompleted, total: safeTotal, ratio: 0, percent: 0 };
  }

  // Ratio clamped to [0, 1].
  const ratio = Math.min(1, safeCompleted / safeTotal);
  const percent = Math.round(ratio * 100);

  return { completed: safeCompleted, total: safeTotal, ratio, percent };
}
