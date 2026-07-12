/**
 * stage-check-gate.ts — PURE stage-check enforcement gate (Slice P2-SC1).
 *
 * evaluateStageCheckGate — decides whether a lesson record may be created
 * for a target lesson, given the course's ordered lessons and the
 * enrollment's existing records. NO I/O; deterministic; property-tested.
 *
 * RULE (only evaluated when the operator has opted the course in via
 * course.enforce_stage_checks — the CALLER checks that flag; this function
 * assumes enforcement is on):
 *   A record may NOT be created for a lesson whose sortOrder is AFTER a
 *   stage-check lesson that has no non-voided record with
 *   stageCheckPassed === true. Recording the stage-check lesson ITSELF is
 *   always allowed — that is how it gets passed.
 *
 * On refusal, blockingLessonId is the EARLIEST (lowest sortOrder) unpassed
 * stage-check lesson strictly before the target.
 *
 * COMPLIANCE HARD LINE: this gate enforces the OPERATOR's configured
 * course structure ONLY. It is NOT a Part-61/141 stage check of record,
 * NOT an FAA milestone/graduation/curriculum determination, and computes
 * NO regulatory verdict — a human still makes every regulatory call.
 * (Mirrors [VERIFY-T1-A/B/G].)
 *
 * INVARIANTS (property-tested in __tests__/stage-check-gate.test.ts):
 *   (i)   enforcement-off ⇒ never blocks (command-layer: the gate is not
 *         even called when course.enforce_stage_checks is false).
 *   (ii)  no stage-check lessons ⇒ never blocks.
 *   (iii) all stage checks passed ⇒ never blocks.
 *   (iv)  blockingLessonId is always the EARLIEST unpassed stage check
 *         strictly before the target.
 *   (v)   voided passing records do not count.
 *   (vi)  recording a stage-check lesson itself is allowed even when IT is
 *         unpassed (only EARLIER unpassed stage checks block it).
 */

// ─── Types ─────────────────────────────────────────────────────────────────────

/** One course lesson as seen by the gate. sortOrder = course_lesson.position. */
export interface StageCheckGateLesson {
  id: string;
  sortOrder: number;
  /** Operator flag — NOT a Part-61/141 stage check of record. */
  isStageCheck: boolean;
}

/** One existing lesson record for the enrollment, as seen by the gate. */
export interface StageCheckGateRecord {
  lessonId: string;
  /** true when status='voided' — voided records never count as passing. */
  voided: boolean;
  /** Instructor-entered outcome; NULL on non-stage-check records. */
  stageCheckPassed: boolean | null;
}

/** Gate verdict. ok:false carries the EARLIEST blocking stage-check lesson id. */
export type StageCheckGateResult =
  | { ok: true }
  | { ok: false; blockingLessonId: string };

// ─── evaluateStageCheckGate ────────────────────────────────────────────────────

/**
 * evaluateStageCheckGate — pure verdict for "may a record be created for
 * targetLessonId?" under operator stage-check enforcement.
 *
 * @param orderedLessons the course's lessons (any order; sorted internally
 *                       by sortOrder ascending).
 * @param records        the enrollment's existing lesson records.
 * @param targetLessonId the lesson a record is about to be created for.
 *
 * A target lesson id not present in orderedLessons returns { ok: true } —
 * lesson-membership is the command layer's concern (lesson_not_in_course),
 * not the gate's.
 */
export function evaluateStageCheckGate(
  orderedLessons: StageCheckGateLesson[],
  records: StageCheckGateRecord[],
  targetLessonId: string,
): StageCheckGateResult {
  const target = orderedLessons.find((l) => l.id === targetLessonId);
  if (!target) return { ok: true };

  // Lesson ids with at least one NON-VOIDED record with stageCheckPassed=true.
  // Voided passing records do NOT count (invariant v).
  const passedLessonIds = new Set(
    records
      .filter((r) => !r.voided && r.stageCheckPassed === true)
      .map((r) => r.lessonId),
  );

  // Earliest (lowest sortOrder) unpassed stage check STRICTLY BEFORE the
  // target. Recording the stage-check lesson itself is always allowed
  // (invariant vi) — strict '<' excludes the target's own slot.
  const blocking = orderedLessons
    .filter(
      (l) =>
        l.isStageCheck &&
        l.sortOrder < target.sortOrder &&
        !passedLessonIds.has(l.id),
    )
    .sort((a, b) => a.sortOrder - b.sortOrder)[0];

  if (blocking) return { ok: false, blockingLessonId: blocking.id };
  return { ok: true };
}
