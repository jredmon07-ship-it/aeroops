/**
 * training-progress.test.ts — Unit tests for progressRatioFromCounts.
 *
 * Spec §3 table coverage:
 *   0/0  → 0%  (no div-by-zero — zero-lesson course)
 *   0/5  → 0%
 *   1/3  → 33% (Math.round)
 *   2/3  → 67% (Math.round)
 *   3/5  → 60%
 *   5/5  → 100%
 *   6/5  → 100% (clamp; over-record after void+re-record edge case)
 *   negative completed → clamp 0%
 *   negative total    → 0%
 *
 * COMPLIANCE: These tests verify a CONTENT RATIO only. The function computes
 * NO FAA/Part-141 determination. [VERIFY-T1-B]
 */

import { describe, it, expect } from 'vitest';
import { progressRatioFromCounts } from '../training/progress.js';

describe('progressRatioFromCounts', () => {
  // ── §3 table cases ──────────────────────────────────────────────────────────

  it('0/0 → ratio=0, percent=0 (zero-lesson course; no div-by-zero)', () => {
    const r = progressRatioFromCounts(0, 0);
    expect(r.completed).toBe(0);
    expect(r.total).toBe(0);
    expect(r.ratio).toBe(0);
    expect(r.percent).toBe(0);
  });

  it('0/5 → ratio=0, percent=0', () => {
    const r = progressRatioFromCounts(0, 5);
    expect(r.completed).toBe(0);
    expect(r.total).toBe(5);
    expect(r.ratio).toBe(0);
    expect(r.percent).toBe(0);
  });

  it('1/3 → ratio≈0.333, percent=33 (Math.round)', () => {
    const r = progressRatioFromCounts(1, 3);
    expect(r.completed).toBe(1);
    expect(r.total).toBe(3);
    expect(r.ratio).toBeCloseTo(1 / 3, 10);
    expect(r.percent).toBe(33);
  });

  it('2/3 → ratio≈0.667, percent=67 (Math.round)', () => {
    const r = progressRatioFromCounts(2, 3);
    expect(r.completed).toBe(2);
    expect(r.total).toBe(3);
    expect(r.ratio).toBeCloseTo(2 / 3, 10);
    expect(r.percent).toBe(67);
  });

  it('3/5 → ratio=0.6, percent=60', () => {
    const r = progressRatioFromCounts(3, 5);
    expect(r.completed).toBe(3);
    expect(r.total).toBe(5);
    expect(r.ratio).toBeCloseTo(0.6, 10);
    expect(r.percent).toBe(60);
  });

  it('5/5 → ratio=1, percent=100', () => {
    const r = progressRatioFromCounts(5, 5);
    expect(r.completed).toBe(5);
    expect(r.total).toBe(5);
    expect(r.ratio).toBe(1);
    expect(r.percent).toBe(100);
  });

  it('6/5 → ratio clamped to 1, percent=100 (over-record after void+re-record)', () => {
    const r = progressRatioFromCounts(6, 5);
    expect(r.completed).toBe(6);
    expect(r.total).toBe(5);
    expect(r.ratio).toBe(1);
    expect(r.percent).toBe(100);
  });

  // ── Defensive cases ────────────────────────────────────────────────────────

  it('negative completed → clamp to 0, percent=0', () => {
    const r = progressRatioFromCounts(-1, 5);
    expect(r.completed).toBe(0);
    expect(r.total).toBe(5);
    expect(r.ratio).toBe(0);
    expect(r.percent).toBe(0);
  });

  it('negative total → 0% (treated as zero-lesson course)', () => {
    const r = progressRatioFromCounts(3, -1);
    expect(r.completed).toBe(3);
    expect(r.total).toBe(0);
    expect(r.ratio).toBe(0);
    expect(r.percent).toBe(0);
  });

  it('both negative → 0/0 case, ratio=0, percent=0', () => {
    const r = progressRatioFromCounts(-2, -3);
    expect(r.completed).toBe(0);
    expect(r.total).toBe(0);
    expect(r.ratio).toBe(0);
    expect(r.percent).toBe(0);
  });

  // ── Invariant: ratio is always in [0, 1] ──────────────────────────────────

  it('ratio is always between 0 and 1 (inclusive)', () => {
    const cases = [
      [0, 0], [0, 1], [1, 1], [5, 3], [100, 100], [0, 10],
    ] as const;
    for (const [c, t] of cases) {
      const r = progressRatioFromCounts(c, t);
      expect(r.ratio).toBeGreaterThanOrEqual(0);
      expect(r.ratio).toBeLessThanOrEqual(1);
    }
  });

  // ── Invariant: percent === Math.round(ratio * 100) ────────────────────────

  it('percent always equals Math.round(ratio * 100)', () => {
    const cases = [
      [0, 0], [0, 5], [1, 3], [2, 3], [3, 5], [5, 5], [6, 5],
      [1, 7], [3, 7], [5, 7],
    ] as const;
    for (const [c, t] of cases) {
      const r = progressRatioFromCounts(c, t);
      expect(r.percent).toBe(Math.round(r.ratio * 100));
    }
  });

  // ── Invariant: returned completed/total match clamped inputs ──────────────

  it('returned completed is max(0, input)', () => {
    expect(progressRatioFromCounts(-5, 10).completed).toBe(0);
    expect(progressRatioFromCounts(3, 10).completed).toBe(3);
  });

  it('returned total is max(0, input)', () => {
    expect(progressRatioFromCounts(3, -10).total).toBe(0);
    expect(progressRatioFromCounts(3, 10).total).toBe(10);
  });
});
