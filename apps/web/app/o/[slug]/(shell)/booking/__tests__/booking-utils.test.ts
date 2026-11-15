/**
 * booking-utils.test.ts — Pure unit tests for booking-request display helpers
 * (Slice PB1.2).
 *
 * Covers:
 *   1. statusLabel — human-readable status labels
 *   2. statusBadgeConfig — correct visual config per status
 *   3. isTerminalStatus — terminal status detection
 *   4. formatRequestedDate — date formatting with optional end, in the zone passed
 *
 * PURE: no DOM, no React, no Next.js, no DB, no I/O.
 */

import { describe, it, expect } from 'vitest';
import {
  statusLabel,
  statusBadgeConfig,
  isTerminalStatus,
  formatRequestedDate,
} from '../_components/booking-utils';

// ═════════════════════════════════════════════════════════════════════════════
// 1. statusLabel
// ═════════════════════════════════════════════════════════════════════════════

describe('1. statusLabel', () => {
  it("'new' → 'New'", () => {
    expect(statusLabel('new')).toBe('New');
  });

  it("'contacted' → 'Contacted'", () => {
    expect(statusLabel('contacted')).toBe('Contacted');
  });

  it("'converted' → 'Converted'", () => {
    expect(statusLabel('converted')).toBe('Converted');
  });

  it("'declined' → 'Declined'", () => {
    expect(statusLabel('declined')).toBe('Declined');
  });

  it('unknown status → passthrough (defensive)', () => {
    expect(statusLabel('unknown_status')).toBe('unknown_status');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. statusBadgeConfig
// ═════════════════════════════════════════════════════════════════════════════

describe('2. statusBadgeConfig', () => {
  it("'new' has label 'New' and a brand-accent class", () => {
    const config = statusBadgeConfig('new');
    expect(config.label).toBe('New');
    expect(config.cls).toContain('brand');
  });

  it("'contacted' has label 'Contacted' and an amber class", () => {
    const config = statusBadgeConfig('contacted');
    expect(config.label).toBe('Contacted');
    expect(config.cls).toContain('amber');
  });

  it("'converted' has label 'Converted' and a green class", () => {
    const config = statusBadgeConfig('converted');
    expect(config.label).toBe('Converted');
    expect(config.cls).toContain('green');
  });

  it("'declined' has label 'Declined' and a slate class", () => {
    const config = statusBadgeConfig('declined');
    expect(config.label).toBe('Declined');
    expect(config.cls).toContain('slate');
  });

  it('unknown status → passthrough label + fallback slate classes', () => {
    const config = statusBadgeConfig('future_status');
    expect(config.label).toBe('future_status');
    expect(config.cls).toContain('slate');
  });

  it('all four known statuses return distinct cls values', () => {
    const classes = ['new', 'contacted', 'converted', 'declined'].map(
      (s) => statusBadgeConfig(s).cls,
    );
    const unique = new Set(classes);
    expect(unique.size).toBe(4);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. isTerminalStatus
// ═════════════════════════════════════════════════════════════════════════════

describe('3. isTerminalStatus', () => {
  it("'converted' is terminal (no further transitions)", () => {
    expect(isTerminalStatus('converted')).toBe(true);
  });

  it("'declined' is terminal (no further transitions)", () => {
    expect(isTerminalStatus('declined')).toBe(true);
  });

  it("'new' is NOT terminal", () => {
    expect(isTerminalStatus('new')).toBe(false);
  });

  it("'contacted' is NOT terminal", () => {
    expect(isTerminalStatus('contacted')).toBe(false);
  });

  it('unknown status → false (defensive; does not block display)', () => {
    expect(isTerminalStatus('unknown')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. formatRequestedDate
// ═════════════════════════════════════════════════════════════════════════════

describe('4. formatRequestedDate', () => {
  // The zone is passed in (the viewer's, resolved by the page), so no
  // expectation depends on the process zone the suite runs in.
  const START_ISO = '2026-06-25T10:00:00.000Z';

  it('start only (no end) → date and time in the zone passed', () => {
    expect(formatRequestedDate(START_ISO, null, 'UTC')).toBe('Jun 25, 2026 at 10:00 AM');
    expect(formatRequestedDate(START_ISO, null, 'America/Chicago')).toBe('Jun 25, 2026 at 5:00 AM');
  });

  it('with end on same day → includes "–" separator, no duplicate date', () => {
    const END_ISO = '2026-06-25T11:00:00.000Z';
    const result = formatRequestedDate(START_ISO, END_ISO, 'UTC');
    expect(result).toBe('Jun 25, 2026 at 10:00 AM – 11:00 AM');
    expect(result.match(/Jun 25, 2026/g)).toHaveLength(1);
  });

  it('with end on different day → includes full end date', () => {
    const END_ISO = '2026-06-26T10:00:00.000Z';
    const result = formatRequestedDate(START_ISO, END_ISO, 'UTC');
    expect(result).toBe('Jun 25, 2026 at 10:00 AM – Jun 26, 2026 at 10:00 AM');
  });

  it('an evening request west of UTC stays on its local day', () => {
    // 19:00–21:00 CDT on Jun 25 is Jun 26 00:00–02:00 UTC.
    const start = '2026-06-26T00:00:00.000Z';
    const end = '2026-06-26T02:00:00.000Z';
    expect(formatRequestedDate(start, end, 'America/Chicago')).toBe('Jun 25, 2026 at 7:00 PM – 9:00 PM');
    expect(formatRequestedDate(start, end, 'UTC')).toBe('Jun 26, 2026 at 12:00 AM – 2:00 AM');
  });

  it('invalid start ISO → "—"', () => {
    expect(formatRequestedDate('not-a-date', null, 'UTC')).toBe('—');
  });

  it('empty start string → "—"', () => {
    expect(formatRequestedDate('', null, 'UTC')).toBe('—');
  });

  it('invalid end ISO → falls back to start-only display', () => {
    expect(formatRequestedDate(START_ISO, 'invalid-end', 'UTC')).toBe('Jun 25, 2026 at 10:00 AM');
  });

  it('null end → no "–" separator in output', () => {
    const result = formatRequestedDate(START_ISO, null, 'UTC');
    expect(result).not.toContain('–');
  });

  it('never throws — always returns a string', () => {
    const cases = [
      ['', null],
      ['garbage', 'garbage'],
      [START_ISO, null],
      [START_ISO, '2026-06-26T10:00:00Z'],
    ] as [string, string | null][];

    for (const [start, end] of cases) {
      for (const zone of ['UTC', 'America/Chicago', 'not/a-zone']) {
        expect(() => formatRequestedDate(start, end, zone)).not.toThrow();
        expect(typeof formatRequestedDate(start, end, zone)).toBe('string');
      }
    }
  });
});
