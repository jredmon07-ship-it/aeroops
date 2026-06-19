/**
 * training-utils.test.ts — Pure unit tests for Training display helpers (Slice T1.3).
 *
 * Covers:
 *   1. formatProgress — content-coverage ratio string [VERIFY-T1-B]
 *   2. enrollmentStatusLabel — human-readable status labels
 *   3. courseStatusLabel — human-readable course status labels
 *
 * PURE: no DOM, no React, no Next.js, no DB, no I/O.
 *
 * COMPLIANCE NOTE [VERIFY-T1-B]: formatProgress returns a content-coverage
 * ratio only — NOT a Part-141 completion rate or regulatory determination.
 */

import { describe, it, expect } from 'vitest';
import {
  formatProgress,
  enrollmentStatusLabel,
  courseStatusLabel,
} from '../_components/training-utils';

// ═════════════════════════════════════════════════════════════════════════════
// 1. formatProgress — content-coverage ratio [VERIFY-T1-B]
// ═════════════════════════════════════════════════════════════════════════════

describe('1. formatProgress — content-coverage ratio [VERIFY-T1-B]', () => {
  it('0 / 0 → "0 / 0 — 0%" (zero-lesson course, no div-by-zero)', () => {
    expect(formatProgress(0, 0)).toBe('0 / 0 — 0%');
  });

  it('0 / 5 → "0 / 5 — 0%"', () => {
    expect(formatProgress(0, 5)).toBe('0 / 5 — 0%');
  });

  it('1 / 3 → "1 / 3 — 33%" (rounds down)', () => {
    expect(formatProgress(1, 3)).toBe('1 / 3 — 33%');
  });

  it('2 / 3 → "2 / 3 — 67%" (rounds up)', () => {
    expect(formatProgress(2, 3)).toBe('2 / 3 — 67%');
  });

  it('3 / 5 → "3 / 5 — 60%"', () => {
    expect(formatProgress(3, 5)).toBe('3 / 5 — 60%');
  });

  it('5 / 5 → "5 / 5 — 100%"', () => {
    expect(formatProgress(5, 5)).toBe('5 / 5 — 100%');
  });

  it('3 / 8 → "3 / 8 — 38%"', () => {
    expect(formatProgress(3, 8)).toBe('3 / 8 — 38%');
  });

  it('produces integer percent (Math.round)', () => {
    const result = formatProgress(1, 3);
    // Must not contain decimal points in the percent figure
    expect(result).toMatch(/\d+ \/ \d+ — \d+%/);
    expect(result).not.toContain('.');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. enrollmentStatusLabel — human-readable status labels [VERIFY-T1-B]
// ═════════════════════════════════════════════════════════════════════════════

describe('2. enrollmentStatusLabel [VERIFY-T1-B]', () => {
  it("'active' → 'Active'", () => {
    expect(enrollmentStatusLabel('active')).toBe('Active');
  });

  it("'completed' → 'Completed' (operator flag, NOT Part-141 graduation) [VERIFY-T1-B]", () => {
    expect(enrollmentStatusLabel('completed')).toBe('Completed');
  });

  it("'withdrawn' → 'Withdrawn'", () => {
    expect(enrollmentStatusLabel('withdrawn')).toBe('Withdrawn');
  });

  it('unknown status → passthrough (defensive)', () => {
    expect(enrollmentStatusLabel('unknown_future_status')).toBe('unknown_future_status');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. courseStatusLabel — human-readable course status labels
// ═════════════════════════════════════════════════════════════════════════════

describe('3. courseStatusLabel', () => {
  it("'active' → 'Active'", () => {
    expect(courseStatusLabel('active')).toBe('Active');
  });

  it("'archived' → 'Archived'", () => {
    expect(courseStatusLabel('archived')).toBe('Archived');
  });

  it('unknown status → passthrough (defensive)', () => {
    expect(courseStatusLabel('future_status')).toBe('future_status');
  });
});
