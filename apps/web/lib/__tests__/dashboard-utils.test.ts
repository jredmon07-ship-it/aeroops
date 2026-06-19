/**
 * dashboard-utils.test.ts — Pure unit tests for lib/dashboard-utils.ts (Slice 7.2).
 *
 * COVERAGE:
 *
 *   resolveRangeKey:
 *     1. '7d' → '7d'; '30d' → '30d'; '90d' → '90d'
 *     2. Undefined → '30d' (default)
 *     3. Null → '30d'
 *     4. Empty string → '30d'
 *     5. Invalid string (e.g. '60d', 'foo') → '30d'
 *     6. Array with valid first element → resolved value
 *     7. Array with invalid first element → '30d'
 *
 *   rangeLabelFull:
 *     8. '7d' → '7 days'
 *     9. '30d' → '30 days'
 *    10. '90d' → '90 days'
 *
 *   formatUtcTime:
 *    11. ISO string at midnight UTC → '00:00'
 *    12. ISO string at noon UTC → '12:00'
 *    13. ISO string with minutes → correct HH:MM
 *    14. Invalid ISO string → '—'
 *    15. Empty string → '—'
 *
 *   clampBarWidth:
 *    16. maxHours=0 → 0 (empty fleet / all-zero)
 *    17. flightHours=maxHours → 100
 *    18. flightHours < maxHours → proportion in [0,100)
 *    19. flightHours > maxHours → clamped to 100
 *    20. Negative flightHours → 0
 *
 * These are PURE unit tests — no DOM, no Next.js, no DB.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveRangeKey,
  rangeLabelFull,
  formatUtcTime,
  clampBarWidth,
} from '../dashboard-utils';
import type { DashboardRangeKey } from '../dashboard-utils';

// ═════════════════════════════════════════════════════════════════════════════
// 1–7. resolveRangeKey
// ═════════════════════════════════════════════════════════════════════════════

describe('resolveRangeKey — valid keys pass through', () => {
  const VALID: DashboardRangeKey[] = ['7d', '30d', '90d'];
  for (const key of VALID) {
    it(`'${key}' → '${key}'`, () => {
      expect(resolveRangeKey(key)).toBe(key);
    });
  }
});

describe('resolveRangeKey — fallback to 30d', () => {
  it('undefined → 30d', () => {
    expect(resolveRangeKey(undefined)).toBe('30d');
  });

  it('null → 30d', () => {
    expect(resolveRangeKey(null)).toBe('30d');
  });

  it('empty string → 30d', () => {
    expect(resolveRangeKey('')).toBe('30d');
  });

  it('"60d" (invalid) → 30d', () => {
    expect(resolveRangeKey('60d')).toBe('30d');
  });

  it('"foo" (invalid) → 30d', () => {
    expect(resolveRangeKey('foo')).toBe('30d');
  });

  it('"7D" (wrong case) → 30d', () => {
    expect(resolveRangeKey('7D')).toBe('30d');
  });

  it('" 7d" (leading space) → 30d', () => {
    expect(resolveRangeKey(' 7d')).toBe('30d');
  });
});

describe('resolveRangeKey — array input', () => {
  it('["7d", "30d"] — first element wins: 7d', () => {
    expect(resolveRangeKey(['7d', '30d'])).toBe('7d');
  });

  it('["90d"] — single valid element: 90d', () => {
    expect(resolveRangeKey(['90d'])).toBe('90d');
  });

  it('["foo"] — invalid first element → 30d', () => {
    expect(resolveRangeKey(['foo'])).toBe('30d');
  });

  it('[] — empty array first element is undefined → 30d', () => {
    expect(resolveRangeKey([])).toBe('30d');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8–10. rangeLabelFull
// ═════════════════════════════════════════════════════════════════════════════

describe('rangeLabelFull', () => {
  it('7d → "7 days"', () => {
    expect(rangeLabelFull('7d')).toBe('7 days');
  });

  it('30d → "30 days"', () => {
    expect(rangeLabelFull('30d')).toBe('30 days');
  });

  it('90d → "90 days"', () => {
    expect(rangeLabelFull('90d')).toBe('90 days');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 11–15. formatUtcTime
// ═════════════════════════════════════════════════════════════════════════════

describe('formatUtcTime', () => {
  it('midnight UTC → "00:00"', () => {
    expect(formatUtcTime('2026-06-19T00:00:00.000Z')).toBe('00:00');
  });

  it('noon UTC → "12:00"', () => {
    expect(formatUtcTime('2026-06-19T12:00:00.000Z')).toBe('12:00');
  });

  it('14:37 UTC → "14:37"', () => {
    expect(formatUtcTime('2026-06-19T14:37:00.000Z')).toBe('14:37');
  });

  it('23:59 UTC → "23:59"', () => {
    expect(formatUtcTime('2026-06-19T23:59:59.000Z')).toBe('23:59');
  });

  it('08:05 UTC → "08:05" (zero-padded)', () => {
    expect(formatUtcTime('2026-06-19T08:05:00.000Z')).toBe('08:05');
  });

  it('invalid ISO string → "—"', () => {
    expect(formatUtcTime('not-a-date')).toBe('—');
  });

  it('empty string → "—"', () => {
    expect(formatUtcTime('')).toBe('—');
  });

  it('random text → "—"', () => {
    expect(formatUtcTime('hello world')).toBe('—');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 16–20. clampBarWidth
// ═════════════════════════════════════════════════════════════════════════════

describe('clampBarWidth', () => {
  it('maxHours=0 → 0 (all-zero fleet; bars render empty track)', () => {
    expect(clampBarWidth(0, 0)).toBe(0);
    expect(clampBarWidth(5, 0)).toBe(0);
  });

  it('flightHours === maxHours → 100 (the "busiest" aircraft fills the bar)', () => {
    expect(clampBarWidth(10, 10)).toBe(100);
    expect(clampBarWidth(5.5, 5.5)).toBe(100);
  });

  it('flightHours < maxHours → proportion in (0, 100)', () => {
    expect(clampBarWidth(5, 10)).toBe(50);
    expect(clampBarWidth(2.5, 10)).toBe(25);
    expect(clampBarWidth(1, 10)).toBe(10);
  });

  it('flightHours > maxHours → clamped to 100', () => {
    // Edge: floating-point accumulation could exceed max; clamp protects the UI.
    expect(clampBarWidth(11, 10)).toBe(100);
    expect(clampBarWidth(1000, 1)).toBe(100);
  });

  it('negative flightHours → 0 (defensive; should not occur at runtime)', () => {
    expect(clampBarWidth(-1, 10)).toBe(0);
  });

  it('flightHours=0 with maxHours>0 → 0 (zero-flight tail at bottom of table)', () => {
    expect(clampBarWidth(0, 20)).toBe(0);
  });

  it('proportion is proportional (1/3 of max → ~33.33)', () => {
    const result = clampBarWidth(1, 3);
    expect(result).toBeCloseTo(33.33, 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Bonus: result type is always numeric and finite
// ═════════════════════════════════════════════════════════════════════════════

describe('clampBarWidth — always finite numeric result', () => {
  const cases: Array<[number, number]> = [
    [0, 0],
    [0, 10],
    [10, 10],
    [100, 50],
    [-5, 10],
    [Number.MAX_SAFE_INTEGER, 1],
  ];
  for (const [fh, mh] of cases) {
    it(`clampBarWidth(${fh}, ${mh}) is finite`, () => {
      const result = clampBarWidth(fh, mh);
      expect(Number.isFinite(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(100);
    });
  }
});
