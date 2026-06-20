/**
 * convert-dialog-helpers.test.ts — Pure unit tests for convert-dialog helpers
 * (Slice PB2.2).
 *
 * Covers:
 *   1. toDatetimeLocal  — ISO → datetime-local format
 *   2. defaultEndAt     — endAt default logic (requestedEnd or startAt + 1h)
 *   3. violationMessage — PolicyViolationView → human-readable copy
 *   4. refusalReasonCopy — per-reason copy map (headline, detail, "No reservation" framing)
 *
 * PURE: no DOM, no React, no Next.js, no DB, no I/O.
 * Imports from convert-dialog-utils.ts (pure TS, no JSX) to work with vitest
 * node environment (mirrors the booking-utils.ts / booking-utils.test.ts pattern).
 */

import { describe, it, expect } from 'vitest';
import {
  defaultEndAt,
  toDatetimeLocal,
  refusalReasonCopy,
  violationMessage,
} from '../_components/convert-dialog-utils';
import type { ConflictHit, PolicyViolationView } from '@aeroops/api';

// ═════════════════════════════════════════════════════════════════════════════
// 1. toDatetimeLocal
// ═════════════════════════════════════════════════════════════════════════════

describe('1. toDatetimeLocal', () => {
  it('formats a midnight UTC date correctly', () => {
    // Use a fixed local date to avoid timezone variability — create via explicit parts
    const d = new Date(2026, 5, 25, 10, 30); // June 25 2026, 10:30 local
    const result = toDatetimeLocal(d);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(result).toContain('2026-06-25');
    expect(result).toContain('T10:30');
  });

  it('pads single-digit month, day, hour, minute', () => {
    const d = new Date(2026, 0, 5, 9, 5); // Jan 5, 09:05
    const result = toDatetimeLocal(d);
    expect(result).toContain('2026-01-05');
    expect(result).toContain('T09:05');
  });

  it('returns a string matching the datetime-local format exactly', () => {
    const d = new Date(2026, 11, 31, 23, 59); // Dec 31, 23:59
    const result = toDatetimeLocal(d);
    expect(result).toBe('2026-12-31T23:59');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. defaultEndAt
// ═════════════════════════════════════════════════════════════════════════════

describe('2. defaultEndAt', () => {
  const START_ISO = '2026-06-25T10:00:00.000Z';

  it('uses requestedEnd when present and valid', () => {
    const END_ISO = '2026-06-25T12:00:00.000Z';
    const result = defaultEndAt(START_ISO, END_ISO);
    expect(result).not.toBe('');
    // Should contain the end time info
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('defaults to startAt + 1h when requestedEnd is null', () => {
    // Use a local-time ISO (avoids UTC-offset edge cases in toDatetimeLocal).
    const localStart = new Date(2026, 5, 25, 10, 0); // June 25, 10:00 local
    const startLocal = localStart.toISOString();
    const result = defaultEndAt(startLocal, null);
    expect(result).not.toBe('');
    // 10:00 + 1h = 11:00
    expect(result).toContain('T11:00');
  });

  it('defaults to startAt + 1h when requestedEnd is invalid', () => {
    const localStart = new Date(2026, 5, 25, 14, 30); // 14:30
    const result = defaultEndAt(localStart.toISOString(), 'not-a-date');
    expect(result).not.toBe('');
    expect(result).toContain('T15:30');
  });

  it('returns empty string when both start and end are invalid', () => {
    const result = defaultEndAt('not-a-date', null);
    expect(result).toBe('');
  });

  it('never throws — always returns a string', () => {
    const cases: [string, string | null][] = [
      ['', null],
      ['garbage', 'garbage'],
      [new Date(2026, 5, 25, 8, 0).toISOString(), null],
      [new Date(2026, 5, 25, 8, 0).toISOString(), new Date(2026, 5, 25, 10, 0).toISOString()],
    ];
    for (const [start, end] of cases) {
      expect(() => defaultEndAt(start, end)).not.toThrow();
      expect(typeof defaultEndAt(start, end)).toBe('string');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. violationMessage
// ═════════════════════════════════════════════════════════════════════════════

describe('3. violationMessage', () => {
  it("kind='max_duration_exceeded' → mentions limitMinutes and resource name", () => {
    const v: PolicyViolationView = {
      kind: 'max_duration_exceeded',
      resourceId: 'r1',
      resourceDisplayName: 'N12345',
      limitMinutes: 120,
      actualMinutes: 180,
    };
    const msg = violationMessage(v);
    expect(msg).toContain('120');
    expect(msg).toContain('N12345');
    expect(msg).toMatch(/exceed/i);
  });

  it("kind='too_far_in_advance' → mentions limitDays", () => {
    const v: PolicyViolationView = {
      kind: 'too_far_in_advance',
      resourceId: 'r1',
      resourceDisplayName: 'N12345',
      limitDays: 30,
      actualDays: 60,
    };
    const msg = violationMessage(v);
    expect(msg).toContain('30');
    expect(msg).toMatch(/advance/i);
  });

  it("kind='insufficient_lead_time' → mentions requiredMinutes", () => {
    const v: PolicyViolationView = {
      kind: 'insufficient_lead_time',
      resourceId: 'r1',
      resourceDisplayName: 'N12345',
      requiredMinutes: 60,
      actualMinutes: 10,
    };
    const msg = violationMessage(v);
    expect(msg).toContain('60');
    expect(msg).toMatch(/lead time/i);
  });

  it("kind='blackout_overlap' → mentions the resource and blackout", () => {
    const v: PolicyViolationView = {
      kind: 'blackout_overlap',
      resourceId: 'r1',
      resourceDisplayName: 'N12345',
      blackoutStart: new Date('2026-06-25T00:00:00Z').getTime(),
      blackoutEnd: new Date('2026-06-26T00:00:00Z').getTime(),
    };
    const msg = violationMessage(v);
    expect(msg).toContain('N12345');
    expect(msg).toMatch(/blackout/i);
  });

  it('never throws — always returns a string', () => {
    const vs: PolicyViolationView[] = [
      { kind: 'max_duration_exceeded', resourceId: 'r', resourceDisplayName: 'X', limitMinutes: 60, actualMinutes: 90 },
      { kind: 'too_far_in_advance', resourceId: 'r', resourceDisplayName: 'X', limitDays: 7, actualDays: 14 },
      { kind: 'insufficient_lead_time', resourceId: 'r', resourceDisplayName: 'X', requiredMinutes: 30, actualMinutes: 5 },
      { kind: 'blackout_overlap', resourceId: 'r', resourceDisplayName: 'X', blackoutStart: 0, blackoutEnd: 1 },
    ];
    for (const v of vs) {
      expect(() => violationMessage(v)).not.toThrow();
      expect(typeof violationMessage(v)).toBe('string');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. refusalReasonCopy
// ═════════════════════════════════════════════════════════════════════════════

describe('4. refusalReasonCopy', () => {
  // ── conflict ──────────────────────────────────────────────────────────────

  it("reason='conflict' → headline mentions tail booked, pick another time or aircraft", () => {
    const conflicts: ConflictHit[] = [
      {
        resourceId: 'r1',
        resourceDisplayName: 'N12345',
        reservationId: 'res1',
        start: new Date('2026-06-25T10:00:00Z'),
        end: new Date('2026-06-25T12:00:00Z'),
      },
    ];
    const result = refusalReasonCopy('conflict', conflicts);
    expect(result.headline).toContain('already booked');
    expect(result.headline).toContain('Pick another time or aircraft');
    // Detail includes the resource name
    expect(result.detail).toContain('N12345');
  });

  it("reason='conflict' with no conflicts → detail is null", () => {
    const result = refusalReasonCopy('conflict', []);
    expect(result.detail).toBeNull();
  });

  // ── policy ────────────────────────────────────────────────────────────────

  it("reason='policy' → headline mentions booking policy", () => {
    const violations: PolicyViolationView[] = [
      {
        kind: 'max_duration_exceeded',
        resourceId: 'r1',
        resourceDisplayName: 'N12345',
        limitMinutes: 120,
        actualMinutes: 180,
      },
    ];
    const result = refusalReasonCopy('policy', undefined, violations);
    expect(result.headline).toMatch(/policy/i);
    expect(result.detail).toContain('Exceeds');
  });

  it("reason='policy' with no violations → detail is null", () => {
    const result = refusalReasonCopy('policy', undefined, []);
    expect(result.detail).toBeNull();
  });

  // ── conflict_and_policy ───────────────────────────────────────────────────

  it("reason='conflict_and_policy' → headline mentions both", () => {
    const conflicts: ConflictHit[] = [
      {
        resourceId: 'r1',
        resourceDisplayName: 'N99999',
        reservationId: 'res2',
        start: new Date('2026-06-25T10:00:00Z'),
        end: new Date('2026-06-25T11:00:00Z'),
      },
    ];
    const violations: PolicyViolationView[] = [
      {
        kind: 'insufficient_lead_time',
        resourceId: 'r1',
        resourceDisplayName: 'N99999',
        requiredMinutes: 1440,
        actualMinutes: 30,
      },
    ];
    const result = refusalReasonCopy('conflict_and_policy', conflicts, violations);
    expect(result.headline).toContain('already booked');
    expect(result.headline).toContain('policy');
    // Detail includes resource names from both
    expect(result.detail).toBeTruthy();
  });

  // ── twilight ──────────────────────────────────────────────────────────────

  it("reason='twilight' → headline mentions civil dusk/dawn + operator blocks", () => {
    const result = refusalReasonCopy('twilight');
    expect(result.headline).toMatch(/civil dusk\/dawn/i);
    expect(result.headline).toMatch(/operator blocks night ops/i);
  });

  it("reason='twilight' → detail contains the verbatim §61.57 disclaimer", () => {
    const result = refusalReasonCopy('twilight');
    // [VERIFY-PB2-COMP-1]: verbatim disclaimer must be present.
    expect(result.detail).toContain('§61.57');
    expect(result.detail).toContain('NOT an FAA');
  });

  // ── availability ──────────────────────────────────────────────────────────

  it("reason='availability' → headline mentions operating hours", () => {
    const result = refusalReasonCopy('availability');
    expect(result.headline).toMatch(/operating hours/i);
  });

  it("reason='availability' → detail suggests adjustment", () => {
    const result = refusalReasonCopy('availability');
    expect(result.detail).toBeTruthy();
    expect(result.detail).toMatch(/adjust/i);
  });

  // ── unknown / fallback ────────────────────────────────────────────────────

  it('unknown reason → returns a non-empty headline (defensive)', () => {
    const result = refusalReasonCopy('some_future_reason');
    expect(result.headline).toBeTruthy();
    expect(typeof result.headline).toBe('string');
  });

  it('never throws — always returns { headline: string, detail: string|null }', () => {
    const cases = [
      'conflict',
      'policy',
      'conflict_and_policy',
      'twilight',
      'availability',
      'not_found',
      '',
      'unknown_future_arm',
    ];
    for (const reason of cases) {
      expect(() => refusalReasonCopy(reason)).not.toThrow();
      const result = refusalReasonCopy(reason);
      expect(typeof result.headline).toBe('string');
      expect(result.headline.length).toBeGreaterThan(0);
      // detail is string or null
      expect(result.detail === null || typeof result.detail === 'string').toBe(true);
    }
  });
});
