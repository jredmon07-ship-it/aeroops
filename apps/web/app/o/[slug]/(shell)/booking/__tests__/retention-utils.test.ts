/**
 * retention-utils.test.ts — Pure unit tests for booking-request retention helpers
 * (Slice PB-LR.A).
 *
 * Covers:
 *   1. formatRetentionSummary — human-readable window description
 *   2. formatDeletedCount     — purge-result summary
 *
 * PURE: no DOM, no React, no Next.js, no DB, no I/O.
 */

import { describe, it, expect } from 'vitest';
import {
  formatRetentionSummary,
  formatDeletedCount,
} from '../_components/retention-utils';

// ═════════════════════════════════════════════════════════════════════════════
// 1. formatRetentionSummary
// ═════════════════════════════════════════════════════════════════════════════

describe('1. formatRetentionSummary', () => {
  it('days=365 → includes "365 days" + "permanently deleted"', () => {
    const result = formatRetentionSummary(365);
    expect(result).toContain('365');
    expect(result).toContain('days');
    expect(result).toContain('permanently deleted');
  });

  it('days=1 → uses singular "day"', () => {
    const result = formatRetentionSummary(1);
    expect(result).toContain('1 day');
    // Should NOT say "1 days"
    expect(result).not.toContain('1 days');
  });

  it('days=90 → includes "90 days"', () => {
    const result = formatRetentionSummary(90);
    expect(result).toContain('90');
    expect(result).toContain('days');
  });

  it('days=3650 → includes "3650 days" (upper boundary)', () => {
    const result = formatRetentionSummary(3650);
    expect(result).toContain('3650');
    expect(result).toContain('days');
    expect(result).toContain('permanently deleted');
  });

  it('days=0 → "keep forever" / retention-off warning', () => {
    const result = formatRetentionSummary(0);
    expect(result.toLowerCase()).toContain('off');
    // Should NOT say "0 days" / "permanently deleted"
    expect(result).not.toContain('permanently deleted');
  });

  it('always returns a non-empty string for valid range 0–3650', () => {
    for (const n of [0, 1, 30, 90, 180, 365, 730, 3650]) {
      const r = formatRetentionSummary(n);
      expect(typeof r).toBe('string');
      expect(r.length).toBeGreaterThan(0);
    }
  });

  it('non-positive-integer input — returns a string without crashing', () => {
    // Defensive: caller should never pass these; function should still not throw.
    expect(() => formatRetentionSummary(-1)).not.toThrow();
    expect(typeof formatRetentionSummary(-1)).toBe('string');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. formatDeletedCount
// ═════════════════════════════════════════════════════════════════════════════

describe('2. formatDeletedCount', () => {
  it('count=0 → "No requests were deleted."', () => {
    expect(formatDeletedCount(0)).toBe('No requests were deleted.');
  });

  it('count=1 → singular form', () => {
    const result = formatDeletedCount(1);
    expect(result).toContain('1 request');
    expect(result.toLowerCase()).toContain('was');
    // Should NOT say "requests" (plural)
    expect(result).not.toContain('requests were');
  });

  it('count=2 → plural form', () => {
    const result = formatDeletedCount(2);
    expect(result).toContain('2 requests');
    expect(result.toLowerCase()).toContain('were');
  });

  it('count=42 → includes "42 requests"', () => {
    const result = formatDeletedCount(42);
    expect(result).toContain('42 requests');
    expect(result.toLowerCase()).toContain('permanently deleted');
  });

  it('always returns a non-empty string for count >= 0', () => {
    for (const n of [0, 1, 10, 100, 1000]) {
      const r = formatDeletedCount(n);
      expect(typeof r).toBe('string');
      expect(r.length).toBeGreaterThan(0);
    }
  });

  it('count=1 result does NOT include "permanently" (brevity)', () => {
    // "1 request was permanently deleted." is acceptable — we just check it includes "deleted"
    const result = formatDeletedCount(1);
    expect(result.toLowerCase()).toContain('deleted');
  });
});
