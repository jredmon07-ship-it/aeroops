/**
 * book-request-utils.test.ts — Pure unit tests for buildIsoDateTime (lib/book-request-utils.ts).
 *
 * COVERAGE:
 *   1. Valid date + time → produces a valid ISO-8601 string (parseable back to same local moment)
 *   2. Valid date + empty time → defaults to "00:00" (start of day)
 *   3. Empty date → returns null
 *   4. Whitespace-only date → returns null
 *   5. Invalid date string (out-of-range month) → returns null
 *   6. Invalid time string combined with valid date → returns null (Date("YYYY-MM-DDTbad") is NaN)
 *   7. Output is always a string ending in "Z" (UTC) when non-null
 *   8. buildIsoDateTime never throws on any input
 *
 * These tests are PURE — no DOM, no Next.js, no DB.
 */

import { describe, it, expect } from 'vitest';
import { buildIsoDateTime } from '../book-request-utils';

// ═════════════════════════════════════════════════════════════════════════════
// 1. Valid date + time → valid ISO string (round-trip parseable)
// ═════════════════════════════════════════════════════════════════════════════

describe('1. valid date + time → ISO-8601 UTC string', () => {
  it('returns a non-null string for a valid date and time', () => {
    const result = buildIsoDateTime('2025-08-15', '14:30');
    expect(result).not.toBeNull();
    expect(typeof result).toBe('string');
  });

  it('returned string ends with "Z" (UTC)', () => {
    const result = buildIsoDateTime('2025-08-15', '14:30');
    expect(result).toMatch(/Z$/);
  });

  it('returned string is parseable as a Date without NaN', () => {
    const result = buildIsoDateTime('2025-08-15', '14:30');
    expect(result).not.toBeNull();
    const reparsed = new Date(result!);
    expect(isNaN(reparsed.getTime())).toBe(false);
  });

  it('ISO string matches the local moment (same UTC point)', () => {
    const date = '2025-03-01';
    const time = '09:00';
    const result = buildIsoDateTime(date, time);
    expect(result).not.toBeNull();

    // The UTC milliseconds must match what "new Date('2025-03-01T09:00')" gives locally.
    const expected = new Date(`${date}T${time}`).toISOString();
    expect(result).toBe(expected);
  });

  it('works for midnight (00:00)', () => {
    const result = buildIsoDateTime('2024-12-31', '00:00');
    expect(result).not.toBeNull();
    expect(result).toMatch(/Z$/);
  });

  it('works for end-of-day (23:59)', () => {
    const result = buildIsoDateTime('2024-01-01', '23:59');
    expect(result).not.toBeNull();
    expect(result).toMatch(/Z$/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Valid date + empty time → defaults to "00:00"
// ═════════════════════════════════════════════════════════════════════════════

describe('2. valid date + empty/blank time → defaults to start of day', () => {
  it('empty string for time → returns same as "00:00"', () => {
    const withEmpty = buildIsoDateTime('2025-06-15', '');
    const withMidnight = buildIsoDateTime('2025-06-15', '00:00');
    expect(withEmpty).toBe(withMidnight);
  });

  it('whitespace-only time → returns same as "00:00"', () => {
    const withSpaces = buildIsoDateTime('2025-06-15', '   ');
    const withMidnight = buildIsoDateTime('2025-06-15', '00:00');
    expect(withSpaces).toBe(withMidnight);
  });

  it('empty time result is a valid ISO string', () => {
    const result = buildIsoDateTime('2025-06-15', '');
    expect(result).not.toBeNull();
    expect(result).toMatch(/Z$/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Empty date → returns null
// ═════════════════════════════════════════════════════════════════════════════

describe('3. empty date → null', () => {
  it('empty string date → null', () => {
    expect(buildIsoDateTime('', '14:30')).toBeNull();
  });

  it('empty string date + empty time → null', () => {
    expect(buildIsoDateTime('', '')).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Whitespace-only date → null
// ═════════════════════════════════════════════════════════════════════════════

describe('4. whitespace-only date → null', () => {
  it('spaces-only date → null', () => {
    expect(buildIsoDateTime('   ', '14:30')).toBeNull();
  });

  it('tab-only date → null', () => {
    expect(buildIsoDateTime('\t', '08:00')).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Invalid date string → null
// ═════════════════════════════════════════════════════════════════════════════

describe('5. invalid date strings → null', () => {
  it('out-of-range month (13) → null', () => {
    expect(buildIsoDateTime('2024-13-01', '10:00')).toBeNull();
  });

  it('non-date string → null', () => {
    expect(buildIsoDateTime('not-a-date', '10:00')).toBeNull();
  });

  it('partial YYYY-MM date: V8 may accept it; if non-null the output is still a valid ISO Z string', () => {
    // V8 parses "2024-06T10:00" as 2024-06-01T10:00 (first of the month).
    // HTML date inputs always emit "YYYY-MM-DD" so partial strings won't reach
    // the helper from the real form. We assert it never throws and any non-null
    // result ends in "Z".
    const result = buildIsoDateTime('2024-06', '10:00');
    if (result !== null) {
      expect(result).toMatch(/Z$/);
    }
  });

  it('random text → null', () => {
    expect(buildIsoDateTime('tomorrow', '10:00')).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Invalid time combined with valid date → null
// ═════════════════════════════════════════════════════════════════════════════

describe('6. invalid time + valid date → null', () => {
  it('non-time string → null', () => {
    expect(buildIsoDateTime('2025-08-15', 'noon')).toBeNull();
  });

  it('out-of-range hour (25:00) → null', () => {
    // "2025-08-15T25:00" → NaN in V8
    expect(buildIsoDateTime('2025-08-15', '25:00')).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Output shape: always ends in "Z" when non-null
// ═════════════════════════════════════════════════════════════════════════════

describe('7. non-null outputs always end in "Z"', () => {
  const validCases: Array<[string, string]> = [
    ['2025-01-01', '00:00'],
    ['2025-06-21', '12:00'],
    ['2025-12-31', '23:59'],
    ['2025-03-10', ''],
  ];

  for (const [date, time] of validCases) {
    it(`buildIsoDateTime('${date}', '${time}') ends in Z`, () => {
      const result = buildIsoDateTime(date, time);
      expect(result).not.toBeNull();
      expect(result!.endsWith('Z')).toBe(true);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Never throws on any input
// ═════════════════════════════════════════════════════════════════════════════

describe('8. buildIsoDateTime never throws', () => {
  const edgeCases: Array<[string, string]> = [
    ['', ''],
    ['   ', '   '],
    ['not-a-date', 'not-a-time'],
    ['2024-13-99', '99:99'],
    ['2025-08-15', '14:30'],
    ['2025-08-15', ''],
  ];

  for (const [date, time] of edgeCases) {
    it(`does not throw for ('${date}', '${time}')`, () => {
      expect(() => buildIsoDateTime(date, time)).not.toThrow();
    });
  }
});
