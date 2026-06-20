/**
 * availability-display.test.ts — Pure unit tests for availability window
 * display helpers (Slice AV1.3).
 *
 * Tests the pure functions in fleet/_utils/availability-display.ts.
 * No DOM, no React, no Next.js, no DB.
 *
 * Coverage:
 *   minutesToHHMM:
 *     1. 0 -> "00:00"
 *     2. 90 -> "01:30"
 *     3. 1439 -> "23:59"
 *     4. 1440 -> "24:00" (end-of-day sentinel)
 *     5. Values outside range are clamped
 *
 *   hhmmToMinutes:
 *     6. "00:00" -> 0
 *     7. "01:30" -> 90
 *     8. "23:59" -> 1439
 *     9. "24:00" -> 1440
 *     10. Invalid strings -> null
 *
 *   splitOvernightWindow:
 *     11. Same-day window -> one entry (endMinute > startMinute)
 *     12. Overnight 22:00-02:00 (1320->120) -> two entries
 *     13. Day 7 (Sunday) overnight -> Window B on day 1 (Monday)
 *     14. endMinute = startMinute -> treated as overnight
 *     15. endMinute = 0 -> Window B is 00:00-24:00 (full day)
 *
 *   dowLabel:
 *     16. 1 -> "Monday"
 *     17. 7 -> "Sunday"
 *     18. Unknown -> fallback
 *
 *   groupWindowsByDay:
 *     19. Empty array -> empty result
 *     20. Single window -> one group
 *     21. Multi-day -> sorted Mon-Sun
 *     22. Multiple windows same day -> grouped under one label
 */

import { describe, it, expect } from 'vitest';
import {
  minutesToHHMM,
  hhmmToMinutes,
  splitOvernightWindow,
  dowLabel,
  groupWindowsByDay,
} from '../_utils/availability-display';

// =============================================================================
// minutesToHHMM
// =============================================================================

describe('minutesToHHMM', () => {
  it('0 -> "00:00"', () => {
    expect(minutesToHHMM(0)).toBe('00:00');
  });

  it('90 -> "01:30"', () => {
    expect(minutesToHHMM(90)).toBe('01:30');
  });

  it('1439 -> "23:59"', () => {
    expect(minutesToHHMM(1439)).toBe('23:59');
  });

  it('1440 -> "24:00" (end-of-day sentinel)', () => {
    expect(minutesToHHMM(1440)).toBe('24:00');
  });

  it('negative values are clamped to 0 -> "00:00"', () => {
    expect(minutesToHHMM(-1)).toBe('00:00');
  });

  it('values over 1440 are clamped to 1440 -> "24:00"', () => {
    expect(minutesToHHMM(9999)).toBe('24:00');
  });

  it('midday 720 -> "12:00"', () => {
    expect(minutesToHHMM(720)).toBe('12:00');
  });

  it('rounds fractional minutes', () => {
    expect(minutesToHHMM(90.4)).toBe('01:30');
    expect(minutesToHHMM(90.6)).toBe('01:31');
  });
});

// =============================================================================
// hhmmToMinutes
// =============================================================================

describe('hhmmToMinutes', () => {
  it('"00:00" -> 0', () => {
    expect(hhmmToMinutes('00:00')).toBe(0);
  });

  it('"01:30" -> 90', () => {
    expect(hhmmToMinutes('01:30')).toBe(90);
  });

  it('"23:59" -> 1439', () => {
    expect(hhmmToMinutes('23:59')).toBe(1439);
  });

  it('"24:00" -> 1440 (end-of-day sentinel)', () => {
    expect(hhmmToMinutes('24:00')).toBe(1440);
  });

  it('invalid format returns null', () => {
    expect(hhmmToMinutes('abc')).toBeNull();
    expect(hhmmToMinutes('')).toBeNull();
    expect(hhmmToMinutes('25:00')).toBeNull();
    expect(hhmmToMinutes('10:60')).toBeNull();
    expect(hhmmToMinutes('10:5')).toBeNull();
    expect(hhmmToMinutes('10:')).toBeNull();
  });

  it('minutes over 59 return null', () => {
    expect(hhmmToMinutes('10:60')).toBeNull();
    expect(hhmmToMinutes('23:99')).toBeNull();
  });
});

// =============================================================================
// splitOvernightWindow
// =============================================================================

describe('splitOvernightWindow', () => {
  const TZ = 'America/Chicago';

  it('same-day window (end > start) returns one entry unchanged', () => {
    const result = splitOvernightWindow(420, 1260, 1, TZ); // 07:00-21:00
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ dayOfWeek: 1, startMinute: 420, endMinute: 1260, tz: TZ });
  });

  it('overnight 22:00-02:00 splits into two rows', () => {
    // startMinute=1320 (22:00), endMinute=120 (02:00), endMinute <= startMinute => overnight
    const result = splitOvernightWindow(1320, 120, 3, TZ); // Wednesday
    expect(result).toHaveLength(2);

    // Window A: same day, 22:00 -> 24:00
    expect(result[0]).toEqual({ dayOfWeek: 3, startMinute: 1320, endMinute: 1440, tz: TZ });

    // Window B: next day (Thursday=4), 00:00 -> 02:00
    expect(result[1]).toEqual({ dayOfWeek: 4, startMinute: 0, endMinute: 120, tz: TZ });
  });

  it('day 7 (Sunday) overnight wraps to day 1 (Monday)', () => {
    const result = splitOvernightWindow(1320, 120, 7, TZ); // Sunday overnight
    expect(result).toHaveLength(2);
    expect(result[0]!.dayOfWeek).toBe(7);
    expect(result[1]!.dayOfWeek).toBe(1); // wraps to Monday
  });

  it('endMinute === startMinute treated as overnight (zero-length => split)', () => {
    const result = splitOvernightWindow(600, 600, 2, TZ);
    expect(result).toHaveLength(2);
    expect(result[0]!.endMinute).toBe(1440);
    expect(result[1]!.startMinute).toBe(0);
    expect(result[1]!.endMinute).toBe(600);
  });

  it('endMinute=0 sets Window B endMinute to 1440 (full next day)', () => {
    const result = splitOvernightWindow(1200, 0, 5, TZ); // 20:00 -> midnight
    expect(result).toHaveLength(2);
    expect(result[0]!.endMinute).toBe(1440);
    expect(result[1]!.startMinute).toBe(0);
    expect(result[1]!.endMinute).toBe(1440); // 0 treated as midnight (full next day)
  });

  it('all windows inherit the original tz', () => {
    const result = splitOvernightWindow(1320, 120, 3, 'Europe/London');
    for (const w of result) {
      expect(w.tz).toBe('Europe/London');
    }
  });
});

// =============================================================================
// dowLabel
// =============================================================================

describe('dowLabel', () => {
  it('1 -> "Monday"', () => expect(dowLabel(1)).toBe('Monday'));
  it('2 -> "Tuesday"', () => expect(dowLabel(2)).toBe('Tuesday'));
  it('3 -> "Wednesday"', () => expect(dowLabel(3)).toBe('Wednesday'));
  it('4 -> "Thursday"', () => expect(dowLabel(4)).toBe('Thursday'));
  it('5 -> "Friday"', () => expect(dowLabel(5)).toBe('Friday'));
  it('6 -> "Saturday"', () => expect(dowLabel(6)).toBe('Saturday'));
  it('7 -> "Sunday"', () => expect(dowLabel(7)).toBe('Sunday'));

  it('unknown day -> fallback string', () => {
    const label = dowLabel(99);
    expect(label).toMatch(/99/);
  });
});

// =============================================================================
// groupWindowsByDay
// =============================================================================

describe('groupWindowsByDay', () => {
  it('empty array returns empty groups', () => {
    expect(groupWindowsByDay([])).toHaveLength(0);
  });

  it('single window produces one group with the correct day label', () => {
    const result = groupWindowsByDay([
      { id: 'w1', dayOfWeek: 3, startMinute: 420, endMinute: 1260, tz: 'UTC' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.dayOfWeek).toBe(3);
    expect(result[0]!.label).toBe('Wednesday');
    expect(result[0]!.windows).toHaveLength(1);
    expect(result[0]!.windows[0]!.range).toBe('07:00–21:00');
  });

  it('multiple windows on same day are grouped under one entry', () => {
    const result = groupWindowsByDay([
      { id: 'w1', dayOfWeek: 1, startMinute: 0, endMinute: 720, tz: 'UTC' },
      { id: 'w2', dayOfWeek: 1, startMinute: 840, endMinute: 1440, tz: 'UTC' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.windows).toHaveLength(2);
  });

  it('multiple days are sorted in ISO weekday order (Mon=1 first)', () => {
    const result = groupWindowsByDay([
      { id: 'w7', dayOfWeek: 7, startMinute: 0, endMinute: 1440, tz: 'UTC' },
      { id: 'w3', dayOfWeek: 3, startMinute: 0, endMinute: 1440, tz: 'UTC' },
      { id: 'w1', dayOfWeek: 1, startMinute: 0, endMinute: 1440, tz: 'UTC' },
    ]);
    expect(result.map((g) => g.dayOfWeek)).toEqual([1, 3, 7]);
  });

  it('range string is formatted as HH:MM-HH:MM', () => {
    const result = groupWindowsByDay([
      { id: 'w1', dayOfWeek: 5, startMinute: 480, endMinute: 1020, tz: 'UTC' },
    ]);
    // 480 min = 08:00, 1020 min = 17:00
    expect(result[0]!.windows[0]!.range).toBe('08:00–17:00');
  });
});
