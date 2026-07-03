/**
 * lesson-record-snapshot.test.ts — property tests for
 * canonicalLessonRecordSnapshot (Slice P2-ESIGN).
 *
 * COMPLIANCE [VERIFY-P2-A]: this function produces a TAMPER-EVIDENCE digest
 * input only — NOT a cryptographic/PKI signature, NOT an FAA-recognized
 * digital/electronic signature. These tests verify determinism/key-order
 * independence and change-sensitivity ONLY; no regulatory logic is tested
 * because none exists here.
 *
 * Coverage:
 *   - key-order independence: for arbitrary field values, building the input
 *     object with keys inserted in shuffled order yields a byte-identical
 *     canonical string.
 *   - change-sensitivity: any single-field change yields a different string.
 *   - null vs '' are distinct encodings for gradeLabel/notes.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  canonicalLessonRecordSnapshot,
  type LessonRecordSnapshotInput,
} from '../training/lesson-record-snapshot.js';

const snapshotArb = fc.record({
  id: fc.uuid(),
  enrollmentId: fc.uuid(),
  lessonId: fc.uuid(),
  instructorUserId: fc.uuid(),
  completedAt: fc
    .date({ min: new Date('2000-01-01'), max: new Date('2100-01-01'), noInvalidDate: true })
    .map((d) => d.toISOString()),
  gradeLabel: fc.option(fc.string({ maxLength: 30 }), { nil: null }),
  notes: fc.option(fc.string({ maxLength: 200 }), { nil: null }),
  status: fc.constantFrom('recorded', 'voided'),
});

describe('canonicalLessonRecordSnapshot', () => {
  it('is deterministic: same input twice → identical output', () => {
    fc.assert(
      fc.property(snapshotArb, (input) => {
        const a = canonicalLessonRecordSnapshot(input);
        const b = canonicalLessonRecordSnapshot(input);
        expect(a).toBe(b);
      }),
    );
  });

  it('key-order independence: building the input with keys in a shuffled order yields a byte-identical string', () => {
    fc.assert(
      fc.property(snapshotArb, (input) => {
        // Build a second object with a DIFFERENT (reverse) key insertion order.
        // Property access inside canonicalLessonRecordSnapshot is by name, not
        // iteration order, so this must be byte-identical to the original.
        const reordered: LessonRecordSnapshotInput = {
          status: input.status,
          notes: input.notes,
          gradeLabel: input.gradeLabel,
          completedAt: input.completedAt,
          instructorUserId: input.instructorUserId,
          lessonId: input.lessonId,
          enrollmentId: input.enrollmentId,
          id: input.id,
        };
        expect(canonicalLessonRecordSnapshot(reordered)).toBe(
          canonicalLessonRecordSnapshot(input),
        );
      }),
    );
  });

  it('any single-field change yields a different canonical string', () => {
    fc.assert(
      fc.property(
        snapshotArb,
        fc.constantFrom(
          'id',
          'enrollmentId',
          'lessonId',
          'instructorUserId',
          'completedAt',
          'gradeLabel',
          'notes',
          'status',
        ),
        (input, fieldToChange) => {
          const original = canonicalLessonRecordSnapshot(input);
          const mutated: LessonRecordSnapshotInput = { ...input };

          switch (fieldToChange) {
            case 'id':
              mutated.id = `${input.id}-x`;
              break;
            case 'enrollmentId':
              mutated.enrollmentId = `${input.enrollmentId}-x`;
              break;
            case 'lessonId':
              mutated.lessonId = `${input.lessonId}-x`;
              break;
            case 'instructorUserId':
              mutated.instructorUserId = `${input.instructorUserId}-x`;
              break;
            case 'completedAt':
              mutated.completedAt = new Date(
                new Date(input.completedAt).getTime() + 1000,
              ).toISOString();
              break;
            case 'gradeLabel':
              mutated.gradeLabel = input.gradeLabel === null ? 'X' : null;
              break;
            case 'notes':
              mutated.notes = input.notes === null ? 'X' : null;
              break;
            case 'status':
              mutated.status = input.status === 'recorded' ? 'voided' : 'recorded';
              break;
          }

          const changed = canonicalLessonRecordSnapshot(mutated);
          expect(changed).not.toBe(original);
        },
      ),
    );
  });

  it('gradeLabel=null and gradeLabel="" produce different strings (null is not treated as empty string)', () => {
    const base: LessonRecordSnapshotInput = {
      id: '11111111-1111-1111-1111-111111111111',
      enrollmentId: '22222222-2222-2222-2222-222222222222',
      lessonId: '33333333-3333-3333-3333-333333333333',
      instructorUserId: '44444444-4444-4444-4444-444444444444',
      completedAt: '2026-01-01T00:00:00.000Z',
      gradeLabel: null,
      notes: null,
      status: 'recorded',
    };
    const withNull = canonicalLessonRecordSnapshot(base);
    const withEmpty = canonicalLessonRecordSnapshot({ ...base, gradeLabel: '' });
    expect(withNull).not.toBe(withEmpty);
  });

  it('produces valid JSON with the fixed key order', () => {
    const input: LessonRecordSnapshotInput = {
      id: '11111111-1111-1111-1111-111111111111',
      enrollmentId: '22222222-2222-2222-2222-222222222222',
      lessonId: '33333333-3333-3333-3333-333333333333',
      instructorUserId: '44444444-4444-4444-4444-444444444444',
      completedAt: '2026-01-01T00:00:00.000Z',
      gradeLabel: 'S',
      notes: 'Great progress',
      status: 'recorded',
    };
    const out = canonicalLessonRecordSnapshot(input);
    expect(JSON.parse(out)).toEqual({
      id: input.id,
      enrollmentId: input.enrollmentId,
      lessonId: input.lessonId,
      instructorUserId: input.instructorUserId,
      completedAt: input.completedAt,
      gradeLabel: input.gradeLabel,
      notes: input.notes,
      status: input.status,
    });
    expect(out.indexOf('"id"')).toBeLessThan(out.indexOf('"enrollmentId"'));
    expect(out.indexOf('"enrollmentId"')).toBeLessThan(out.indexOf('"lessonId"'));
    expect(out.indexOf('"status"')).toBeGreaterThan(out.indexOf('"notes"'));
  });
});
