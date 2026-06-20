/**
 * activity-utils.test.ts — Pure unit tests for lib/activity-utils.ts (Slice A1.2).
 *
 * COVERAGE:
 *
 *   formatRelativeTime:
 *     1.  delta < 60 s → "just now"
 *     2.  exactly 1 min → "1m ago"
 *     3.  59 min → "59m ago"
 *     4.  1 hour → "1h ago"
 *     5.  23 hours → "23h ago"
 *     6.  1 day → "1d ago"
 *     7.  29 days → "29d ago"
 *     8.  30 days → "4wk ago"   (floor(30*24/7/24) = floor(30/7) = 4)
 *     9.  51 weeks → "51wk ago"
 *     10. 52 weeks → "1yr ago"
 *     11. 2 years → "2yr ago"
 *     12. invalid ISO string → "—"
 *     13. empty string → "—"
 *     14. future timestamp → "just now" (defensive)
 *     15. exactly 0 delta → "just now"
 *
 * These are PURE unit tests — no DOM, no Next.js, no DB.
 */

import { describe, it, expect } from 'vitest';
import { formatRelativeTime } from '../activity-utils';

// Fixed "now" reference for deterministic tests.
const NOW = new Date('2026-06-20T12:00:00.000Z');

/**
 * Returns the ISO string for a timestamp that is `seconds` seconds before NOW.
 */
function ago(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1000).toISOString();
}

// ═════════════════════════════════════════════════════════════════════════════
// 1–5: sub-hour thresholds
// ═════════════════════════════════════════════════════════════════════════════

describe('formatRelativeTime — sub-minute → "just now"', () => {
  it('0 seconds ago → "just now"', () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe('just now');
  });

  it('30 seconds ago → "just now"', () => {
    expect(formatRelativeTime(ago(30), NOW)).toBe('just now');
  });

  it('59 seconds ago → "just now"', () => {
    expect(formatRelativeTime(ago(59), NOW)).toBe('just now');
  });
});

describe('formatRelativeTime — minutes', () => {
  it('60 seconds (1 min) ago → "1m ago"', () => {
    expect(formatRelativeTime(ago(60), NOW)).toBe('1m ago');
  });

  it('90 seconds (1 min floor) → "1m ago"', () => {
    expect(formatRelativeTime(ago(90), NOW)).toBe('1m ago');
  });

  it('59 minutes ago → "59m ago"', () => {
    expect(formatRelativeTime(ago(59 * 60), NOW)).toBe('59m ago');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// hours
// ═════════════════════════════════════════════════════════════════════════════

describe('formatRelativeTime — hours', () => {
  it('1 hour ago → "1h ago"', () => {
    expect(formatRelativeTime(ago(60 * 60), NOW)).toBe('1h ago');
  });

  it('2 hours ago → "2h ago"', () => {
    expect(formatRelativeTime(ago(2 * 60 * 60), NOW)).toBe('2h ago');
  });

  it('23 hours ago → "23h ago"', () => {
    expect(formatRelativeTime(ago(23 * 60 * 60), NOW)).toBe('23h ago');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// days
// ═════════════════════════════════════════════════════════════════════════════

describe('formatRelativeTime — days', () => {
  it('1 day (24h) ago → "1d ago"', () => {
    expect(formatRelativeTime(ago(24 * 60 * 60), NOW)).toBe('1d ago');
  });

  it('7 days ago → "7d ago"', () => {
    expect(formatRelativeTime(ago(7 * 24 * 60 * 60), NOW)).toBe('7d ago');
  });

  it('29 days ago → "29d ago"', () => {
    expect(formatRelativeTime(ago(29 * 24 * 60 * 60), NOW)).toBe('29d ago');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// weeks
// ═════════════════════════════════════════════════════════════════════════════

describe('formatRelativeTime — weeks', () => {
  it('30 days ago → "4wk ago" (30d / 7 = 4.28 → floor 4)', () => {
    expect(formatRelativeTime(ago(30 * 24 * 60 * 60), NOW)).toBe('4wk ago');
  });

  it('51 weeks ago → "51wk ago"', () => {
    expect(formatRelativeTime(ago(51 * 7 * 24 * 60 * 60), NOW)).toBe('51wk ago');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// years
// ═════════════════════════════════════════════════════════════════════════════

describe('formatRelativeTime — years', () => {
  it('365 days (1 year) ago → "1yr ago"', () => {
    // floor(365 / 365) = 1; also weeks = floor(365/7) = 52 → transitions to yr bucket.
    expect(formatRelativeTime(ago(365 * 24 * 60 * 60), NOW)).toBe('1yr ago');
  });

  it('730 days (2 years) ago → "2yr ago"', () => {
    expect(formatRelativeTime(ago(730 * 24 * 60 * 60), NOW)).toBe('2yr ago');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Edge cases / error handling
// ═════════════════════════════════════════════════════════════════════════════

describe('formatRelativeTime — edge cases', () => {
  it('invalid ISO string → "—"', () => {
    expect(formatRelativeTime('not-a-date', NOW)).toBe('—');
  });

  it('empty string → "—"', () => {
    expect(formatRelativeTime('', NOW)).toBe('—');
  });

  it('random text → "—"', () => {
    expect(formatRelativeTime('hello world', NOW)).toBe('—');
  });

  it('future timestamp → "just now" (defensive; delta < 0)', () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    expect(formatRelativeTime(future, NOW)).toBe('just now');
  });

  it('uses real Date() when now is not provided (smoke — verifies no throw)', () => {
    const recentIso = new Date(Date.now() - 5000).toISOString();
    const result = formatRelativeTime(recentIso);
    expect(result).toBe('just now');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Return type is always a string
// ═════════════════════════════════════════════════════════════════════════════

describe('formatRelativeTime — always returns a string', () => {
  const cases: string[] = [
    ago(0),
    ago(90),
    ago(3600),
    ago(86400),
    ago(86400 * 30),
    ago(86400 * 365 * 2),
    'bad-input',
    '',
  ];
  for (const input of cases) {
    it(`result is string for input "${input.slice(0, 20)}"`, () => {
      const result = formatRelativeTime(input, NOW);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  }
});
