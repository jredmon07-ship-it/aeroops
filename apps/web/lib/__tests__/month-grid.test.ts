/**
 * month-grid.test.ts — Unit tests for the pure month-calendar grid math.
 *
 * Boundary coverage per slice spec:
 *   - February leap year (2024-02) vs non-leap (2026-02).
 *   - A month starting on Sunday (Feb 2026 — zero leading pad, exactly 4 weeks).
 *   - DST months (Mar 2026 spring-forward, Nov 2026 fall-back — UTC math must
 *     keep every week at exactly 7 correctly-labeled days).
 *   - Year rollover in addMonths (Dec→Jan, Jan→Dec).
 *   - ?month= param parse/format round-trip + malformed inputs.
 *   - stableHash / paletteIndex determinism + range.
 */
import { describe, it, expect } from 'vitest';
import {
  buildMonthGrid,
  parseMonthParam,
  formatMonthParam,
  addMonths,
  addMonthsClamped,
  monthLabel,
  localDayKey,
  groupByStartDay,
  stableHash,
  paletteIndex,
  shortName,
} from '../month-grid';

// ─── buildMonthGrid ───────────────────────────────────────────────────────────

describe('buildMonthGrid', () => {
  it('February leap year (2024): 29 in-month days, pads Jan 28 → Mar 2', () => {
    const grid = buildMonthGrid(2024, 2);
    const cells = grid.weeks.flat();
    expect(cells.filter((c) => c.inMonth)).toHaveLength(29);
    // Feb 1 2024 is a Thursday (dow 4) → 4 leading pad days.
    expect(grid.gridStartIso).toBe('2024-01-28');
    expect(grid.weeks).toHaveLength(5);
    expect(grid.gridEndIso).toBe('2024-03-02');
    expect(cells.some((c) => c.iso === '2024-02-29' && c.inMonth)).toBe(true);
  });

  it('February non-leap starting on Sunday (2026): exactly 4 weeks, zero padding', () => {
    const grid = buildMonthGrid(2026, 2);
    const cells = grid.weeks.flat();
    expect(grid.weeks).toHaveLength(4);
    expect(cells).toHaveLength(28);
    expect(cells.every((c) => c.inMonth)).toBe(true);
    expect(grid.gridStartIso).toBe('2026-02-01');
    expect(grid.gridEndIso).toBe('2026-02-28');
    expect(cells.some((c) => c.iso === '2026-02-29')).toBe(false);
  });

  it('DST spring-forward month (Mar 2026): every week has exactly 7 aligned days', () => {
    const grid = buildMonthGrid(2026, 3);
    expect(grid.weeks.every((w) => w.length === 7)).toBe(true);
    // Column index always equals day-of-week (Sunday-first) — a DST-broken
    // "23-hour day" implementation would skew this.
    for (const week of grid.weeks) {
      week.forEach((cell, col) => expect(cell.dow).toBe(col));
    }
    expect(grid.weeks.flat().filter((c) => c.inMonth)).toHaveLength(31);
    expect(grid.gridStartIso).toBe('2026-03-01'); // Mar 1 2026 is a Sunday
  });

  it('DST fall-back month (Nov 2026): 30 in-month days, no duplicated day', () => {
    const grid = buildMonthGrid(2026, 11);
    const cells = grid.weeks.flat();
    expect(cells.filter((c) => c.inMonth)).toHaveLength(30);
    const isos = cells.map((c) => c.iso);
    expect(new Set(isos).size).toBe(isos.length); // no repeats (fall-back trap)
    expect(grid.gridStartIso).toBe('2026-11-01'); // Nov 1 2026 is a Sunday
    expect(grid.gridEndIso).toBe('2026-12-05');
  });

  it('mid-week-start month (Jul 2026, starts Wednesday): pad cells flagged out-of-month', () => {
    const grid = buildMonthGrid(2026, 7);
    expect(grid.gridStartIso).toBe('2026-06-28');
    const firstWeek = grid.weeks[0]!;
    expect(firstWeek.slice(0, 3).every((c) => !c.inMonth)).toBe(true);
    expect(firstWeek[3]!.iso).toBe('2026-07-01');
    expect(firstWeek[3]!.inMonth).toBe(true);
    expect(grid.firstOfMonthIso).toBe('2026-07-01');
  });

  it('cells are strictly consecutive calendar days', () => {
    const cells = buildMonthGrid(2026, 3).weeks.flat();
    for (let i = 1; i < cells.length; i++) {
      const prev = Date.UTC(cells[i - 1]!.year, cells[i - 1]!.month - 1, cells[i - 1]!.day);
      const cur = Date.UTC(cells[i]!.year, cells[i]!.month - 1, cells[i]!.day);
      expect(cur - prev).toBe(86_400_000);
    }
  });

  it('rejects out-of-range input', () => {
    expect(() => buildMonthGrid(2026, 0)).toThrow(RangeError);
    expect(() => buildMonthGrid(2026, 13)).toThrow(RangeError);
    expect(() => buildMonthGrid(2026, 7.5)).toThrow(RangeError);
    expect(() => buildMonthGrid(1969, 1)).toThrow(RangeError);
  });
});

// ─── ?month= param helpers ───────────────────────────────────────────────────

describe('parseMonthParam / formatMonthParam', () => {
  it('round-trips a valid value', () => {
    expect(parseMonthParam('2026-07')).toEqual({ year: 2026, month: 7 });
    expect(formatMonthParam(2026, 7)).toBe('2026-07');
    expect(parseMonthParam(formatMonthParam(2024, 12))).toEqual({ year: 2024, month: 12 });
  });

  it('returns null for malformed or out-of-range values (never throws)', () => {
    expect(parseMonthParam(undefined)).toBeNull();
    expect(parseMonthParam(null)).toBeNull();
    expect(parseMonthParam('')).toBeNull();
    expect(parseMonthParam('2026-13')).toBeNull();
    expect(parseMonthParam('2026-00')).toBeNull();
    expect(parseMonthParam('26-07')).toBeNull();
    expect(parseMonthParam('2026-7')).toBeNull();
    expect(parseMonthParam('2026-07-01')).toBeNull();
    expect(parseMonthParam('garbage')).toBeNull();
  });
});

describe('addMonths', () => {
  it('rolls the year across Dec → Jan and Jan → Dec', () => {
    expect(addMonths(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
  });

  it('handles multi-year deltas in both directions', () => {
    expect(addMonths(2026, 7, 18)).toEqual({ year: 2028, month: 1 });
    expect(addMonths(2026, 7, -19)).toEqual({ year: 2024, month: 12 });
    expect(addMonths(2026, 7, 0)).toEqual({ year: 2026, month: 7 });
  });
});

describe('addMonthsClamped', () => {
  it('matches addMonths away from the representable boundary', () => {
    expect(addMonthsClamped(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonthsClamped(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonthsClamped(2026, 7, 0)).toEqual({ year: 2026, month: 7 });
  });

  it('clamps instead of throwing at the calendar boundary (parseMonthParam accepts these)', () => {
    // 1970-01 → prev (1969-12) is unrepresentable → clamp to 1970-01.
    expect(addMonthsClamped(1970, 1, -1)).toEqual({ year: 1970, month: 1 });
    // 9999-12 → next (10000-01) is unrepresentable → clamp to 9999-12.
    expect(addMonthsClamped(9999, 12, 1)).toEqual({ year: 9999, month: 12 });
    // A representable neighbor at the near edge still moves.
    expect(addMonthsClamped(1970, 1, 1)).toEqual({ year: 1970, month: 2 });
    expect(addMonthsClamped(9999, 12, -1)).toEqual({ year: 9999, month: 11 });
  });

  it('never throws for the boundary months parseMonthParam admits', () => {
    for (const { year, month } of [parseMonthParam('1970-01')!, parseMonthParam('9999-12')!]) {
      expect(() => addMonthsClamped(year, month, -1)).not.toThrow();
      expect(() => addMonthsClamped(year, month, 1)).not.toThrow();
    }
  });
});

describe('monthLabel', () => {
  it('includes the year and is non-empty (formatted at UTC — never shifts months)', () => {
    const label = monthLabel(2026, 7);
    expect(label).toContain('2026');
    expect(label.length).toBeGreaterThan(4);
  });
});

// ─── Day bucketing ────────────────────────────────────────────────────────────

describe('localDayKey / groupByStartDay', () => {
  it('keys by the local calendar day of the start time', () => {
    // Constructed in local time → key must match the same local calendar date.
    const d = new Date(2026, 6, 5, 9, 30); // Jul 5 2026 09:30 local
    expect(localDayKey(d)).toBe('2026-07-05');
  });

  it('buckets items on their start day only, preserving order within a day', () => {
    const items = [
      { id: 'a', startAt: new Date(2026, 6, 5, 9, 0) },
      { id: 'b', startAt: new Date(2026, 6, 5, 14, 0) },
      { id: 'c', startAt: new Date(2026, 6, 6, 8, 0) },
    ];
    const byDay = groupByStartDay(items, (i) => i.startAt);
    expect(byDay.get('2026-07-05')?.map((i) => i.id)).toEqual(['a', 'b']);
    expect(byDay.get('2026-07-06')?.map((i) => i.id)).toEqual(['c']);
    expect(byDay.get('2026-07-07')).toBeUndefined();
  });
});

// ─── Hash / palette ───────────────────────────────────────────────────────────

describe('stableHash / paletteIndex', () => {
  it('is deterministic and non-negative', () => {
    expect(stableHash('resource-123')).toBe(stableHash('resource-123'));
    expect(stableHash('resource-123')).toBeGreaterThanOrEqual(0);
    expect(stableHash('a')).not.toBe(stableHash('b'));
  });

  it('paletteIndex stays within [0, size)', () => {
    for (const id of ['x', 'y', 'z', 'resource-1', 'resource-2', '']) {
      const idx = paletteIndex(id, 8);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(8);
    }
    expect(() => paletteIndex('x', 0)).toThrow(RangeError);
  });
});

// ─── shortName ────────────────────────────────────────────────────────────────

describe('shortName', () => {
  it('compacts to "First L."', () => {
    expect(shortName('Jonathan Redmon')).toBe('Jonathan R.');
    expect(shortName('  Mary Jane Watson ')).toBe('Mary W.');
  });

  it('passes single tokens and empties through', () => {
    expect(shortName('Cher')).toBe('Cher');
    expect(shortName('')).toBe('');
    expect(shortName('   ')).toBe('');
  });
});
