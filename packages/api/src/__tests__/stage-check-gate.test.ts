/**
 * stage-check-gate.test.ts — PURE gate tests for Slice P2-SC1 stage-check
 * enforcement (evaluateStageCheckGate). No I/O, no DB.
 *
 * Property invariants (fast-check):
 *   (ii)  no stage-check lessons ⇒ never blocks.
 *   (iii) all stage checks passed (non-voided stageCheckPassed=true records)
 *         ⇒ never blocks.
 *   (iv)  when it blocks, blockingLessonId is always the EARLIEST unpassed
 *         stage check strictly BEFORE the target.
 *   (v)   voided passing records never count — voiding every passing record
 *         re-blocks anything a pass had unlocked.
 *   (vi)  recording a stage-check lesson itself is allowed even when IT is
 *         unpassed (only EARLIER unpassed stage checks block it).
 *
 * (Invariant (i) — enforcement-off ⇒ never blocks — lives at the command
 * layer and is covered in stage-check-enforcement.test.ts: the gate is not
 * called at all when course.enforce_stage_checks is false.)
 *
 * COMPLIANCE: the gate enforces the OPERATOR's configured course structure
 * ONLY — NOT a Part-61/141 stage check of record or any FAA determination.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  evaluateStageCheckGate,
  type StageCheckGateLesson,
  type StageCheckGateRecord,
} from '../training/stage-check-gate.js';

// ─── Arbitraries ──────────────────────────────────────────────────────────────

/** A course: 1–12 lessons with distinct ids and distinct sortOrders. */
const arbCourse = fc
  .array(fc.boolean(), { minLength: 1, maxLength: 12 })
  .map((stageFlags): StageCheckGateLesson[] =>
    stageFlags.map((isStageCheck, i) => ({
      id: `lesson-${i}`,
      sortOrder: i,
      isStageCheck,
    })),
  );

/** A course together with records against its lessons and a target lesson. */
const arbScenario = arbCourse.chain((lessons) =>
  fc.record({
    lessons: fc.constant(lessons),
    // Shuffle to prove input order does not matter.
    shuffled: fc.shuffledSubarray(lessons, { minLength: lessons.length, maxLength: lessons.length }),
    records: fc.array(
      fc.record({
        lessonIndex: fc.integer({ min: 0, max: lessons.length - 1 }),
        voided: fc.boolean(),
        stageCheckPassed: fc.option(fc.boolean(), { nil: null }),
      }),
      { maxLength: 24 },
    ).map((rs): StageCheckGateRecord[] =>
      rs.map((r) => ({
        lessonId: `lesson-${r.lessonIndex}`,
        voided: r.voided,
        stageCheckPassed: r.stageCheckPassed,
      })),
    ),
    targetIndex: fc.integer({ min: 0, max: lessons.length - 1 }),
  }),
);

/** Reference predicate: the set of lesson ids passed by a non-voided pass record. */
function passedIds(records: StageCheckGateRecord[]): Set<string> {
  return new Set(
    records.filter((r) => !r.voided && r.stageCheckPassed === true).map((r) => r.lessonId),
  );
}

// ─── Unit cases ───────────────────────────────────────────────────────────────

describe('evaluateStageCheckGate — unit cases', () => {
  const lessons: StageCheckGateLesson[] = [
    { id: 'L0', sortOrder: 0, isStageCheck: false },
    { id: 'L1', sortOrder: 1, isStageCheck: true },  // stage check A
    { id: 'L2', sortOrder: 2, isStageCheck: false },
    { id: 'L3', sortOrder: 3, isStageCheck: true },  // stage check B
    { id: 'L4', sortOrder: 4, isStageCheck: false },
  ];

  it('a lesson before any stage check is never blocked', () => {
    expect(evaluateStageCheckGate(lessons, [], 'L0')).toEqual({ ok: true });
  });

  it('a lesson after an unpassed stage check is blocked by it', () => {
    expect(evaluateStageCheckGate(lessons, [], 'L2')).toEqual({
      ok: false,
      blockingLessonId: 'L1',
    });
  });

  it('recording the stage-check lesson ITSELF is always allowed', () => {
    expect(evaluateStageCheckGate(lessons, [], 'L1')).toEqual({ ok: true });
  });

  it('a later stage check is blocked by the earlier unpassed one (not itself)', () => {
    expect(evaluateStageCheckGate(lessons, [], 'L3')).toEqual({
      ok: false,
      blockingLessonId: 'L1',
    });
  });

  it('a non-voided pass record unlocks lessons past that stage check', () => {
    const records: StageCheckGateRecord[] = [
      { lessonId: 'L1', voided: false, stageCheckPassed: true },
    ];
    expect(evaluateStageCheckGate(lessons, records, 'L2')).toEqual({ ok: true });
    // …but the SECOND stage check still blocks L4.
    expect(evaluateStageCheckGate(lessons, records, 'L4')).toEqual({
      ok: false,
      blockingLessonId: 'L3',
    });
  });

  it('a FAILED stage-check record (stageCheckPassed=false) does NOT unlock', () => {
    const records: StageCheckGateRecord[] = [
      { lessonId: 'L1', voided: false, stageCheckPassed: false },
    ];
    expect(evaluateStageCheckGate(lessons, records, 'L2')).toEqual({
      ok: false,
      blockingLessonId: 'L1',
    });
  });

  it('a VOIDED passing record does NOT count (invariant v)', () => {
    const records: StageCheckGateRecord[] = [
      { lessonId: 'L1', voided: true, stageCheckPassed: true },
    ];
    expect(evaluateStageCheckGate(lessons, records, 'L2')).toEqual({
      ok: false,
      blockingLessonId: 'L1',
    });
  });

  it('a plain (NULL-outcome) record on the stage check does NOT unlock', () => {
    const records: StageCheckGateRecord[] = [
      { lessonId: 'L1', voided: false, stageCheckPassed: null },
    ];
    expect(evaluateStageCheckGate(lessons, records, 'L2')).toEqual({
      ok: false,
      blockingLessonId: 'L1',
    });
  });

  it('a target id not in the lesson list is the command layer’s concern → ok', () => {
    expect(evaluateStageCheckGate(lessons, [], 'not-a-lesson')).toEqual({ ok: true });
  });
});

// ─── Property invariants ──────────────────────────────────────────────────────

describe('evaluateStageCheckGate — property invariants', () => {
  it('(ii) no stage-check lessons ⇒ never blocks', () => {
    fc.assert(
      fc.property(arbScenario, ({ lessons, records, targetIndex }) => {
        const noStageChecks = lessons.map((l) => ({ ...l, isStageCheck: false }));
        const result = evaluateStageCheckGate(noStageChecks, records, `lesson-${targetIndex}`);
        expect(result).toEqual({ ok: true });
      }),
    );
  });

  it('(iii) all stage checks passed (non-voided pass records) ⇒ never blocks', () => {
    fc.assert(
      fc.property(arbScenario, ({ lessons, records, targetIndex }) => {
        const passes: StageCheckGateRecord[] = lessons
          .filter((l) => l.isStageCheck)
          .map((l) => ({ lessonId: l.id, voided: false, stageCheckPassed: true }));
        const result = evaluateStageCheckGate(
          lessons,
          [...records, ...passes],
          `lesson-${targetIndex}`,
        );
        expect(result).toEqual({ ok: true });
      }),
    );
  });

  it('(iv) a block always names the EARLIEST unpassed stage check strictly before the target', () => {
    fc.assert(
      fc.property(arbScenario, ({ lessons, shuffled, records, targetIndex }) => {
        const targetId = `lesson-${targetIndex}`;
        // Feed the SHUFFLED lesson list — input order must not matter.
        const result = evaluateStageCheckGate(shuffled, records, targetId);

        const passed = passedIds(records);
        const expectedBlockers = lessons
          .filter((l) => l.isStageCheck && l.sortOrder < targetIndex && !passed.has(l.id))
          .sort((a, b) => a.sortOrder - b.sortOrder);

        if (expectedBlockers.length === 0) {
          expect(result).toEqual({ ok: true });
        } else {
          expect(result).toEqual({ ok: false, blockingLessonId: expectedBlockers[0]!.id });
        }
      }),
    );
  });

  it('(v) voiding every passing record never UNBLOCKS anything (monotone in passes)', () => {
    fc.assert(
      fc.property(arbScenario, ({ lessons, records, targetIndex }) => {
        const targetId = `lesson-${targetIndex}`;
        const withPasses = evaluateStageCheckGate(lessons, records, targetId);
        const allVoided = records.map((r) => ({ ...r, voided: true }));
        const withoutPasses = evaluateStageCheckGate(lessons, allVoided, targetId);
        // If it blocked WITH passes available, it must still block with all
        // records voided (voided passes never count; removing passes can only
        // block more, never less).
        if (!withPasses.ok) {
          expect(withoutPasses.ok).toBe(false);
        }
      }),
    );
  });

  it('(vi) a stage-check lesson is never blocked BY ITSELF', () => {
    fc.assert(
      fc.property(arbScenario, ({ lessons, records, targetIndex }) => {
        const targetId = `lesson-${targetIndex}`;
        const result = evaluateStageCheckGate(lessons, records, targetId);
        if (!result.ok) {
          expect(result.blockingLessonId).not.toBe(targetId);
        }
      }),
    );
  });

  it('determinism: same inputs ⇒ same verdict', () => {
    fc.assert(
      fc.property(arbScenario, ({ lessons, records, targetIndex }) => {
        const targetId = `lesson-${targetIndex}`;
        const a = evaluateStageCheckGate(lessons, records, targetId);
        const b = evaluateStageCheckGate(lessons, records, targetId);
        expect(a).toEqual(b);
      }),
    );
  });
});
