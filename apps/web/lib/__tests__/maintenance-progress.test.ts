/**
 * maintenance-progress.test.ts — unit tests for the pure FC-style maintenance
 * progress-bar math (lib/maintenance-progress.ts).
 *
 * Boundaries under test:
 *   - remaining <= 0        ⇒ EXPIRED (full red bar, label 'EXPIRED').
 *   - pct remaining <= 20   ⇒ 'warn' (amber); 21+ ⇒ 'ok' (green).
 *   - remaining undefined   ⇒ 'unknown' (no bar), sorts last.
 *   - display interval: common-reminder titles (case-insensitive) use their
 *     nominal interval; anything else falls back to 100 hrs / 365 days.
 *   - pct clamps to 0–100 (remaining beyond one full interval never overflows).
 */
import { describe, it, expect } from 'vitest';
import {
  computeMaintenanceProgress,
  resolveDisplayInterval,
  COMMON_REMINDER_INTERVALS,
  DEFAULT_INTERVAL_HOURS,
  DEFAULT_INTERVAL_DAYS,
  WARN_PCT,
} from '../maintenance-progress';

describe('resolveDisplayInterval', () => {
  it('resolves the six common reminders (case-insensitive) to their nominal intervals', () => {
    expect(resolveDisplayInterval('hours', '50 Hour Oil Change')).toBe(50);
    expect(resolveDisplayInterval('hours', '100 hour inspection')).toBe(100);
    expect(resolveDisplayInterval('date', 'Annual Inspection')).toBe(365);
    expect(resolveDisplayInterval('date', 'ELT BATTERY')).toBe(365);
    expect(resolveDisplayInterval('date', 'Transponder Check')).toBe(730);
    expect(resolveDisplayInterval('date', 'Pitot/Static Check')).toBe(730);
  });

  it('falls back to the defaults for unknown titles', () => {
    expect(resolveDisplayInterval('hours', 'Prop overhaul')).toBe(DEFAULT_INTERVAL_HOURS);
    expect(resolveDisplayInterval('date', 'Insurance renewal')).toBe(DEFAULT_INTERVAL_DAYS);
  });

  it('a common title on the WRONG basis falls back (hours title as date item)', () => {
    expect(resolveDisplayInterval('date', '50 Hour Oil Change')).toBe(DEFAULT_INTERVAL_DAYS);
  });

  it('every common reminder has a positive interval on its own basis', () => {
    for (const c of COMMON_REMINDER_INTERVALS) {
      expect(resolveDisplayInterval(c.trackBy, c.title)).toBeGreaterThan(0);
    }
  });
});

describe('computeMaintenanceProgress — EXPIRED', () => {
  it('remaining 0 ⇒ expired: FULL bar with the EXPIRED label', () => {
    const p = computeMaintenanceProgress({ trackBy: 'hours', title: '50 Hour Oil Change', remaining: 0 });
    expect(p.tone).toBe('expired');
    expect(p.fillPct).toBe(100);
    expect(p.pctRemaining).toBe(0);
    expect(p.label).toBe('EXPIRED');
  });

  it('remaining negative ⇒ expired; further past due sorts MORE urgent', () => {
    const past5 = computeMaintenanceProgress({ trackBy: 'date', title: 'Annual Inspection', remaining: -5 });
    const past50 = computeMaintenanceProgress({ trackBy: 'date', title: 'Annual Inspection', remaining: -50 });
    expect(past5.tone).toBe('expired');
    expect(past50.tone).toBe('expired');
    expect(past50.sortKey).toBeLessThan(past5.sortKey);
  });
});

describe('computeMaintenanceProgress — warn/ok boundary (<=20% amber)', () => {
  it('exactly 20% remaining ⇒ warn; just above ⇒ ok (50-hr interval)', () => {
    // 10 of 50 hrs = 20%.
    const atBoundary = computeMaintenanceProgress({ trackBy: 'hours', title: '50 Hour Oil Change', remaining: 10 });
    expect(atBoundary.pctRemaining).toBe(WARN_PCT);
    expect(atBoundary.tone).toBe('warn');

    // 11 of 50 = 22%.
    const above = computeMaintenanceProgress({ trackBy: 'hours', title: '50 Hour Oil Change', remaining: 11 });
    expect(above.tone).toBe('ok');
  });

  it('small positive remaining stays warn (never expired until <= 0)', () => {
    const p = computeMaintenanceProgress({ trackBy: 'hours', title: '100 Hour Inspection', remaining: 0.1 });
    expect(p.tone).toBe('warn');
    expect(p.fillPct).toBeGreaterThanOrEqual(0);
    expect(p.label).not.toBe('EXPIRED');
  });

  it('date items: 73 of 365 days = 20% ⇒ warn; 74 ⇒ ok', () => {
    expect(computeMaintenanceProgress({ trackBy: 'date', title: 'Annual Inspection', remaining: 73 }).tone).toBe('warn');
    expect(computeMaintenanceProgress({ trackBy: 'date', title: 'Annual Inspection', remaining: 74 }).tone).toBe('ok');
  });
});

describe('computeMaintenanceProgress — green + clamping', () => {
  it('a fresh item shows a (near-)full green bar', () => {
    const p = computeMaintenanceProgress({ trackBy: 'hours', title: '50 Hour Oil Change', remaining: 50 });
    expect(p.tone).toBe('ok');
    expect(p.fillPct).toBe(100);
    expect(p.label).toBe('100%');
  });

  it('remaining beyond one interval clamps to 100 (never overflows the bar)', () => {
    const p = computeMaintenanceProgress({ trackBy: 'date', title: 'Annual Inspection', remaining: 900 });
    expect(p.fillPct).toBe(100);
    expect(p.pctRemaining).toBe(100);
    // Sort key stays proportional (not clamped) so fresher still sorts later.
    expect(p.sortKey).toBeGreaterThan(1);
  });
});

describe('computeMaintenanceProgress — unknown', () => {
  it('undefined remaining (no recorded meter) ⇒ unknown, no bar, sorts last', () => {
    const p = computeMaintenanceProgress({ trackBy: 'hours', title: 'Prop overhaul', remaining: undefined });
    expect(p.tone).toBe('unknown');
    expect(p.fillPct).toBe(0);
    expect(p.label).toBe('');
    expect(p.sortKey).toBe(Number.POSITIVE_INFINITY);
  });

  it('non-finite remaining fails safe to unknown (never throws)', () => {
    const p = computeMaintenanceProgress({ trackBy: 'hours', title: 'X', remaining: Number.NaN });
    expect(p.tone).toBe('unknown');
  });
});
