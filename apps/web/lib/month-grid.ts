/**
 * lib/month-grid.ts — Pure month-calendar grid math for the /schedule Month view.
 *
 * ALL functions here are pure: the grid is built from a (year, month) integer
 * pair, NEVER from Date.now(). Day arithmetic runs in UTC (Date.UTC + fixed
 * 86,400,000 ms steps), so the grid is immune to local DST transitions — a UTC
 * day is always exactly 24h. The calendar identity of a date (its day-of-week,
 * days-in-month) is timezone-independent, so UTC math yields the correct local
 * calendar for every viewer.
 *
 * Weeks are Sunday-first (matching en-US flight-school convention and the
 * Flight-Circle-style month calendar this backs).
 *
 * Unit tests: lib/__tests__/month-grid.test.ts (leap Feb, Sunday-start months,
 * DST months, year rollover).
 */

const DAY_MS = 86_400_000;

// ─── Types ────────────────────────────────────────────────────────────────────

/** One day cell in the padded month grid. */
export interface MonthDayCell {
  /** Calendar year of THIS cell (padding cells may differ from the grid month). */
  year: number;
  /** Calendar month of THIS cell, 1–12. */
  month: number;
  /** Day of month, 1–31. */
  day: number;
  /** "YYYY-MM-DD" — matches the ?date= param format used across /schedule. */
  iso: string;
  /** True when the cell belongs to the grid's month (false = leading/trailing pad). */
  inMonth: boolean;
  /** Day of week, 0 = Sunday … 6 = Saturday (grid column index). */
  dow: number;
}

/** A padded month grid: full weeks (rows of 7), Sunday-first. */
export interface MonthGrid {
  year: number;
  /** 1–12. */
  month: number;
  /** Weeks as rows; every week has exactly 7 cells. */
  weeks: MonthDayCell[][];
  /** iso of the 1st of the month (convenience). */
  firstOfMonthIso: string;
  /** iso of the first (possibly padding) cell. */
  gridStartIso: string;
  /** iso of the last (possibly padding) cell. */
  gridEndIso: string;
}

export interface YearMonth {
  year: number;
  /** 1–12. */
  month: number;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function assertYearMonth(year: number, month: number): void {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) {
    throw new RangeError(`month-grid: year out of range: ${year}`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new RangeError(`month-grid: month must be 1-12: ${month}`);
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function cellFromUtcMs(ms: number, gridMonth: number, gridYear: number): MonthDayCell {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return {
    year,
    month,
    day,
    iso: `${year}-${pad2(month)}-${pad2(day)}`,
    inMonth: year === gridYear && month === gridMonth,
    dow: d.getUTCDay(),
  };
}

// ─── Grid builder ─────────────────────────────────────────────────────────────

/**
 * buildMonthGrid — build the padded Sunday-first grid for (year, month).
 *
 * @param year  - full year, e.g. 2026 (integer, 1970–9999).
 * @param month - 1–12 (integer).
 * @returns MonthGrid whose weeks tile the month exactly (4–6 rows of 7).
 * @throws RangeError on non-integer / out-of-range input.
 */
export function buildMonthGrid(year: number, month: number): MonthGrid {
  assertYearMonth(year, month);

  const firstMs = Date.UTC(year, month - 1, 1);
  const firstDow = new Date(firstMs).getUTCDay();
  // Day 0 of the NEXT month = last day of this month (UTC-safe days-in-month).
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  const gridStartMs = firstMs - firstDow * DAY_MS;
  const totalCells = Math.ceil((firstDow + daysInMonth) / 7) * 7;

  const weeks: MonthDayCell[][] = [];
  let week: MonthDayCell[] = [];
  for (let i = 0; i < totalCells; i++) {
    week.push(cellFromUtcMs(gridStartMs + i * DAY_MS, month, year));
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }

  const firstWeek = weeks[0]!;
  const lastWeek = weeks[weeks.length - 1]!;
  return {
    year,
    month,
    weeks,
    firstOfMonthIso: `${year}-${pad2(month)}-01`,
    gridStartIso: firstWeek[0]!.iso,
    gridEndIso: lastWeek[6]!.iso,
  };
}

// ─── ?month= URL param helpers ────────────────────────────────────────────────

/**
 * parseMonthParam — parse a "YYYY-MM" query value. Returns null when absent,
 * malformed, or out of range (never throws — bad URLs degrade to the default).
 */
export function parseMonthParam(value: string | null | undefined): YearMonth | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < 1970 || year > 9999 || month < 1 || month > 12) return null;
  return { year, month };
}

/** formatMonthParam — "YYYY-MM" for the ?month= query param. */
export function formatMonthParam(year: number, month: number): string {
  assertYearMonth(year, month);
  return `${year}-${pad2(month)}`;
}

/**
 * addMonths — offset a (year, month) pair by `delta` months (may be negative);
 * rolls the year correctly across Dec/Jan.
 */
export function addMonths(year: number, month: number, delta: number): YearMonth {
  assertYearMonth(year, month);
  if (!Number.isInteger(delta)) {
    throw new RangeError(`month-grid: delta must be an integer: ${delta}`);
  }
  const total = year * 12 + (month - 1) + delta;
  const newYear = Math.floor(total / 12);
  const newMonth = (total % 12 + 12) % 12 + 1;
  assertYearMonth(newYear, newMonth);
  return { year: newYear, month: newMonth };
}

/** Representable month indices (year*12 + month-1) for the [1970-01, 9999-12] range. */
const MIN_MONTH_INDEX = 1970 * 12; // 1970-01
const MAX_MONTH_INDEX = 9999 * 12 + 11; // 9999-12

/**
 * addMonthsClamped — like addMonths, but NEVER throws at the representable
 * calendar boundary: a month whose neighbor would fall outside [1970-01,
 * 9999-12] clamps to the nearest representable month instead. The month view
 * computes both neighbors (prev/next) unconditionally at render, so a boundary
 * month like 1970-01 (whose 1969-12 predecessor is unrepresentable) or 9999-12
 * (whose 10000-01 successor is) would otherwise crash the render with a
 * RangeError. Clamping keeps the view renderable — the nav button simply
 * doesn't move past the boundary.
 */
export function addMonthsClamped(year: number, month: number, delta: number): YearMonth {
  assertYearMonth(year, month);
  if (!Number.isInteger(delta)) {
    throw new RangeError(`month-grid: delta must be an integer: ${delta}`);
  }
  const total = year * 12 + (month - 1) + delta;
  const clamped = Math.min(MAX_MONTH_INDEX, Math.max(MIN_MONTH_INDEX, total));
  return { year: Math.floor(clamped / 12), month: (clamped % 12) + 1 };
}

/**
 * monthLabel — human heading, e.g. "July 2026". Formats the 1st of the month
 * at UTC so the label can never shift into a neighboring month.
 */
export function monthLabel(year: number, month: number): string {
  assertYearMonth(year, month);
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

// ─── Reservation → day bucketing ─────────────────────────────────────────────

/**
 * localDayKey — "YYYY-MM-DD" of a Date in LOCAL time (matches the iso keys the
 * grid cells carry and the ?date= param the day views take).
 */
export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/**
 * groupByStartDay — bucket items by the LOCAL calendar day of their start time.
 * An item appears once, on its start day (multi-day spans are not tiled —
 * the chip shows the start; the day board shows the full span).
 */
export function groupByStartDay<T>(
  items: readonly T[],
  getStart: (item: T) => Date,
): Map<string, T[]> {
  const byDay = new Map<string, T[]>();
  for (const item of items) {
    const key = localDayKey(getStart(item));
    const bucket = byDay.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      byDay.set(key, [item]);
    }
  }
  return byDay;
}

// ─── Stable hash → palette index (per-resource chip color) ───────────────────

/**
 * stableHash — FNV-1a 32-bit over the string's UTF-16 code units. Deterministic
 * across sessions/platforms (same resource id → same color forever).
 */
export function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** paletteIndex — stable index into a palette of `size` entries (size >= 1). */
export function paletteIndex(id: string, size: number): number {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`month-grid: palette size must be >= 1: ${size}`);
  }
  return stableHash(id) % size;
}

// ─── Display helper ───────────────────────────────────────────────────────────

/**
 * shortName — compact "First L." form for chip copy ("Jonathan Redmon" →
 * "Jonathan R."). Single-token names pass through; empty input → ''.
 */
export function shortName(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]!} ${parts[parts.length - 1]![0]!.toUpperCase()}.`;
}
