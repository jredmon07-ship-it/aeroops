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
 *   formatFlightStart ("Today's flights", in the viewer's zone):
 *    11. A start on the viewer's today → 24-hour "HH:MM" in that zone
 *    12. An evening start west of UTC stays on today (UTC would say tomorrow)
 *    13. An overnight booking from yesterday → "Yesterday HH:MM"
 *    14. Earlier starts → "Mon D HH:MM"
 *    15. Invalid / empty ISO string → '—'
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
  formatFlightStart,
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
// 11–15. formatFlightStart
// ═════════════════════════════════════════════════════════════════════════════

describe('formatFlightStart', () => {
  // The hosted demo's Bravo card at 10:55 CST on Nov 15, 2026 listed these
  // starts as UTC clock times (21:00, 16:00, 18:30, 20:00, 22:30).
  const TODAY = '2026-11-15';
  const CHICAGO = 'America/Chicago';

  it('a start on the viewer\'s today reads as the local 24-hour clock', () => {
    expect(formatFlightStart('2026-11-15T16:00:00.000Z', TODAY, CHICAGO)).toBe('10:00');
    expect(formatFlightStart('2026-11-15T18:30:00.000Z', TODAY, CHICAGO)).toBe('12:30');
    expect(formatFlightStart('2026-11-15T20:00:00.000Z', TODAY, CHICAGO)).toBe('14:00');
    expect(formatFlightStart('2026-11-15T22:30:00.000Z', TODAY, CHICAGO)).toBe('16:30');
  });

  it('a 19:00 CST start is still today (its UTC day is tomorrow)', () => {
    expect(formatFlightStart('2026-11-16T01:00:00.000Z', TODAY, CHICAGO)).toBe('19:00');
  });

  it('an overnight booking that began yesterday says so', () => {
    expect(formatFlightStart('2026-11-14T21:00:00.000Z', TODAY, CHICAGO)).toBe('Yesterday 15:00');
  });

  it('a booking that began before yesterday shows its date', () => {
    expect(formatFlightStart('2026-11-13T21:00:00.000Z', TODAY, CHICAGO)).toBe('Nov 13 15:00');
  });

  it('UTC viewers see UTC clock times, midnight as 00:00', () => {
    expect(formatFlightStart('2026-06-19T00:00:00.000Z', '2026-06-19', 'UTC')).toBe('00:00');
    expect(formatFlightStart('2026-06-19T14:37:00.000Z', '2026-06-19', 'UTC')).toBe('14:37');
    expect(formatFlightStart('2026-06-19T08:05:00.000Z', '2026-06-19', 'UTC')).toBe('08:05');
  });

  it('invalid / empty ISO string → "—"', () => {
    expect(formatFlightStart('not-a-date', TODAY, CHICAGO)).toBe('—');
    expect(formatFlightStart('', TODAY, CHICAGO)).toBe('—');
    expect(formatFlightStart('hello world', TODAY, CHICAGO)).toBe('—');
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
