/**
 * booking-utils.test.ts — Pure unit tests for booking-request display helpers
 * (Slice PB1.2).
 *
 * Covers:
 *   1. statusLabel — human-readable status labels
 *   2. statusBadgeConfig — correct visual config per status
 *   3. isTerminalStatus — terminal status detection
 *   4. formatRequestedDate — date formatting with optional end
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
  // Fixed date for deterministic tests: Jun 25 2026, 10:00 AM UTC.
  // We use a known ISO string and check the parts of the output.
  const START_ISO = '2026-06-25T14:00:00.000Z'; // 14:00 UTC

  it('start only (no end) → includes date and time', () => {
    const result = formatRequestedDate(START_ISO, null);
    expect(result).toContain('2026');
    expect(result).toContain('Jun');
    expect(result).toContain('25');
    expect(result).not.toBe('—');
  });

  it('with end on same day → includes "–" separator, no duplicate date', () => {
    const END_ISO = '2026-06-25T16:00:00.000Z'; // 2h later, same UTC date
    const result = formatRequestedDate(START_ISO, END_ISO);
    expect(result).toContain('–');
    expect(result).not.toBe('—');
  });

  it('with end on different day → includes full end date', () => {
    const END_ISO = '2026-06-26T14:00:00.000Z'; // next day
    const result = formatRequestedDate(START_ISO, END_ISO);
    expect(result).toContain('–');
    expect(result).not.toBe('—');
    // Should mention June 26 somewhere (as end date)
    const hasEndDateContext = result.includes('26') || result.includes('Jun');
    expect(hasEndDateContext).toBe(true);
  });

  it('invalid start ISO → "—"', () => {
    expect(formatRequestedDate('not-a-date', null)).toBe('—');
  });

  it('empty start string → "—"', () => {
    expect(formatRequestedDate('', null)).toBe('—');
  });

  it('invalid end ISO → falls back to start-only display', () => {
    const result = formatRequestedDate(START_ISO, 'invalid-end');
    // Should still show the start date, not crash
    expect(result).not.toBe('—');
    expect(result).toContain('2026');
  });

  it('null end → no "–" separator in output', () => {
    const result = formatRequestedDate(START_ISO, null);
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
      expect(() => formatRequestedDate(start, end)).not.toThrow();
      expect(typeof formatRequestedDate(start, end)).toBe('string');
    }
  });
});
