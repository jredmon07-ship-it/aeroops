/**
 * report-utils.test.ts — Pure unit tests for R1.2 display helpers.
 *
 * COVERAGE:
 *   1. resolveReportRangeKey — valid inputs, fallback, array, null/undefined
 *   2. reportRangeLabelFull  — all 5 keys
 *   3. formatBucketLabel     — day granularity, week granularity, invalid input
 *   4. clampReportBarWidth   — normal, zero max, full, clamped, negative
 *
 * PURE: no DOM, no Next.js, no DB, no I/O.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveReportRangeKey,
  reportRangeLabelFull,
  formatBucketLabel,
  clampReportBarWidth,
} from '../report-utils';

// ═════════════════════════════════════════════════════════════════════════════
// 1. resolveReportRangeKey
// ═════════════════════════════════════════════════════════════════════════════

describe('resolveReportRangeKey', () => {
  it('returns 7d for "7d"', () => {
    expect(resolveReportRangeKey('7d')).toBe('7d');
  });

  it('returns 30d for "30d"', () => {
    expect(resolveReportRangeKey('30d')).toBe('30d');
  });

  it('returns 90d for "90d"', () => {
    expect(resolveReportRangeKey('90d')).toBe('90d');
  });

  it('returns 180d for "180d"', () => {
    expect(resolveReportRangeKey('180d')).toBe('180d');
  });

  it('returns 365d for "365d"', () => {
    expect(resolveReportRangeKey('365d')).toBe('365d');
  });

  it('falls back to 30d for unknown string', () => {
    expect(resolveReportRangeKey('60d')).toBe('30d');
  });

  it('falls back to 30d for empty string', () => {
    expect(resolveReportRangeKey('')).toBe('30d');
  });

  it('falls back to 30d for null', () => {
    expect(resolveReportRangeKey(null)).toBe('30d');
  });

  it('falls back to 30d for undefined', () => {
    expect(resolveReportRangeKey(undefined)).toBe('30d');
  });

  it('uses first element of array when valid', () => {
    expect(resolveReportRangeKey(['90d', '7d'])).toBe('90d');
  });

  it('falls back to 30d when first array element is invalid', () => {
    expect(resolveReportRangeKey(['invalid'])).toBe('30d');
  });

  it('falls back to 30d for empty array', () => {
    expect(resolveReportRangeKey([])).toBe('30d');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. reportRangeLabelFull
// ═════════════════════════════════════════════════════════════════════════════

describe('reportRangeLabelFull', () => {
  it('returns "7 days" for 7d', () => {
    expect(reportRangeLabelFull('7d')).toBe('7 days');
  });

  it('returns "30 days" for 30d', () => {
    expect(reportRangeLabelFull('30d')).toBe('30 days');
  });

  it('returns "90 days" for 90d', () => {
    expect(reportRangeLabelFull('90d')).toBe('90 days');
  });

  it('returns "180 days" for 180d', () => {
    expect(reportRangeLabelFull('180d')).toBe('180 days');
  });

  it('returns "365 days" for 365d', () => {
    expect(reportRangeLabelFull('365d')).toBe('365 days');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. formatBucketLabel
// ═════════════════════════════════════════════════════════════════════════════

describe('formatBucketLabel', () => {
  it('formats day granularity as "Mon D" (UTC)', () => {
    // 2024-06-05T00:00:00.000Z is June 5, UTC
    const label = formatBucketLabel('2024-06-05T00:00:00.000Z', 'day');
    expect(label).toBe('Jun 5');
  });

  it('formats week granularity with trailing dash', () => {
    const label = formatBucketLabel('2024-06-03T00:00:00.000Z', 'week');
    expect(label).toBe('Jun 3–');
  });

  it('uses UTC month, not local month (Jan 1 UTC)', () => {
    const label = formatBucketLabel('2024-01-01T00:00:00.000Z', 'day');
    expect(label).toBe('Jan 1');
  });

  it('handles December correctly', () => {
    const label = formatBucketLabel('2024-12-25T00:00:00.000Z', 'day');
    expect(label).toBe('Dec 25');
  });

  it('handles single-digit days without padding', () => {
    const label = formatBucketLabel('2024-03-02T00:00:00.000Z', 'day');
    expect(label).toBe('Mar 2');
  });

  it('returns "—" for invalid ISO string', () => {
    const label = formatBucketLabel('not-a-date', 'day');
    expect(label).toBe('—');
  });

  it('returns "—" for empty string', () => {
    const label = formatBucketLabel('', 'day');
    expect(label).toBe('—');
  });

  it('handles week granularity at month boundary', () => {
    // Week starting Jan 29
    const label = formatBucketLabel('2024-01-29T00:00:00.000Z', 'week');
    expect(label).toBe('Jan 29–');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. clampReportBarWidth
// ═════════════════════════════════════════════════════════════════════════════

describe('clampReportBarWidth', () => {
  it('returns 100 when value equals maxValue', () => {
    expect(clampReportBarWidth(10, 10)).toBe(100);
  });

  it('returns 50 when value is half maxValue', () => {
    expect(clampReportBarWidth(5, 10)).toBe(50);
  });

  it('returns 0 when maxValue is 0', () => {
    expect(clampReportBarWidth(0, 0)).toBe(0);
  });

  it('returns 0 when value is 0 (regardless of maxValue)', () => {
    expect(clampReportBarWidth(0, 100)).toBe(0);
  });

  it('clamps to 100 when value exceeds maxValue', () => {
    expect(clampReportBarWidth(200, 100)).toBe(100);
  });

  it('returns 0 for negative value', () => {
    expect(clampReportBarWidth(-5, 10)).toBe(0);
  });

  it('returns 0 when maxValue is negative', () => {
    expect(clampReportBarWidth(5, -1)).toBe(0);
  });

  it('handles fractional values proportionally', () => {
    const result = clampReportBarWidth(2.5, 10);
    expect(result).toBe(25);
  });

  it('result is always in [0, 100]', () => {
    const cases: [number, number][] = [
      [0, 0], [0, 10], [10, 10], [5, 10], [15, 10], [-1, 10],
    ];
    for (const [v, m] of cases) {
      const r = clampReportBarWidth(v, m);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(100);
    }
  });
});
