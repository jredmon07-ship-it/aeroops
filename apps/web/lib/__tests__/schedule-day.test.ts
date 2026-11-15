/**
 * schedule-day.test.ts — Unit tests for the schedule's ?date= day helpers.
 *
 * The bug these pin down: ?date= became a Date at the SERVER's local midnight
 * (UTC on Vercel) that the browser formatted and stepped in ITS zone. West of
 * UTC, ?date=2026-11-16 read "Sunday, November 15", Next day stayed on
 * 2026-11-16, Previous day jumped to 2026-11-14, and the board drew the day's
 * blocks off its track.
 *
 * No expectation here depends on the process time zone. Run the file under
 * several to prove it, e.g.:
 *   for tz in America/Chicago America/New_York Pacific/Auckland UTC; do
 *     TZ=$tz pnpm --filter @aeroops/web exec vitest run lib/__tests__/schedule-day.test.ts
 *   done
 *
 * Coverage:
 *   1. parseDayParam / splitDay — real calendar days only; never throws on input.
 *   2. addDays — month and year ends, leap years, DST days, the 1970–9999 clamp.
 *   3. dayLabel — the label is the URL's day; month-grid padding cells too.
 *   4. Server → browser hand-off — the live failure replayed: the page runs in
 *      UTC, the browser in the viewer's zone, and the heading, Next, Previous,
 *      the default "today" and the board's 00:00 all land on the right day.
 *   5. dayInZone — the calendar day of an instant near midnight.
 *   6. dayWindow — normal, DST (23 h / 25 h), a skipped or doubled midnight,
 *      far east / west; every 2026 day in nine zones against a brute-force oracle.
 *   7. isValidTimeZone / resolveTimeZone — the cookie value is validated.
 *   8. Page wiring (source scan, like action-auth.test.ts): both schedule pages
 *      resolve ?date= with these helpers, and key the client components that
 *      seed state from the day's reservations by that day — without the key,
 *      Next / Previous kept showing the day you came from.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseDayParam,
  splitDay,
  addDays,
  dayLabel,
  dayInZone,
  dayWindow,
  isValidTimeZone,
  resolveTimeZone,
} from '../schedule-day';
import { buildMonthGrid } from '../month-grid';
import { blockPositionFromReservation } from '../../app/o/[slug]/(shell)/schedule/board/_utils/board-layout';

const HOUR_MS = 3_600_000;

/** The four zones the live bug was checked in (two west of UTC, one east, UTC). */
const VIEWER_ZONES = ['America/Chicago', 'America/New_York', 'Pacific/Auckland', 'UTC'] as const;

/** Run `fn` with the process (i.e. Date's "local") zone switched to `tz`. */
function inZone<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

/** The calendar day a browser in the process zone shows for `d`. */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const iso = (d: Date) => d.toISOString();

// ─── 1. parseDayParam / splitDay ──────────────────────────────────────────────

describe('1. parseDayParam / splitDay', () => {
  it('accepts real calendar days and returns them unchanged', () => {
    for (const day of ['2026-11-16', '2024-02-29', '2026-12-31', '1970-01-01', '9999-12-31']) {
      expect(parseDayParam(day)).toBe(day);
    }
  });

  it('returns null for absent, malformed, impossible or out-of-range values (never throws)', () => {
    const bad: unknown[] = [
      undefined,
      null,
      '',
      '2026-02-29', // 2026 is not a leap year
      '2026-02-30',
      '2026-04-31',
      '2026-13-01',
      '2026-00-10',
      '2026-11-00',
      '2026-11-16T00:00',
      ' 2026-11-16',
      '2026/11/16',
      '20261116',
      '1969-12-31',
      '10000-01-01',
      '01970-01-01',
      ['2026-11-16'], // a repeated ?date=
    ];
    for (const value of bad) {
      expect(parseDayParam(value as string)).toBeNull();
    }
  });

  it('splitDay returns the parts and throws RangeError on a non-day', () => {
    expect(splitDay('2026-11-16')).toEqual({ year: 2026, month: 11, day: 16 });
    expect(() => splitDay('2026-02-30')).toThrow(RangeError);
    expect(() => splitDay('garbage')).toThrow(RangeError);
  });
});

// ─── 2. addDays ───────────────────────────────────────────────────────────────

describe('2. addDays', () => {
  it('steps exactly one calendar day each way', () => {
    expect(addDays('2026-11-15', 1)).toBe('2026-11-16');
    expect(addDays('2026-11-16', 1)).toBe('2026-11-17');
    expect(addDays('2026-11-16', -1)).toBe('2026-11-15');
  });

  it('rolls month and year ends, including leap February', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('is untouched by DST: Chicago spring-forward and fall-back days step normally', () => {
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-03-09', -1)).toBe('2026-03-08');
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(addDays('2026-11-02', -1)).toBe('2026-11-01');
  });

  it('a year of Next clicks visits every day once and lands on the next New Year', () => {
    let day = '2026-01-01';
    const seen = new Set<string>();
    for (let i = 0; i < 365; i++) {
      expect(seen.has(day)).toBe(false);
      seen.add(day);
      const next = addDays(day, 1);
      expect(addDays(next, -1)).toBe(day);
      day = next;
    }
    expect(day).toBe('2027-01-01');
    expect(seen.has('2026-02-28') && seen.has('2026-12-31')).toBe(true);
  });

  it('handles multi-day deltas', () => {
    expect(addDays('2026-11-16', 45)).toBe('2026-12-31');
    expect(addDays('2026-11-16', -320)).toBe('2025-12-31');
  });

  it('clamps at the 1970–9999 ?date= span and rejects a fractional delta', () => {
    expect(addDays('1970-01-01', -1)).toBe('1970-01-01');
    expect(addDays('9999-12-31', 1)).toBe('9999-12-31');
    expect(addDays('2026-11-16', 1e12)).toBe('9999-12-31');
    expect(addDays('2026-11-16', -1e12)).toBe('1970-01-01');
    expect(() => addDays('2026-11-16', 0.5)).toThrow(RangeError);
  });
});

// ─── 3. dayLabel ──────────────────────────────────────────────────────────────

describe('3. dayLabel', () => {
  it('labels the day the URL names, whatever the process zone', () => {
    expect(dayLabel('2026-11-15', 'en-US')).toBe('Sunday, November 15, 2026');
    expect(dayLabel('2026-11-16', 'en-US')).toBe('Monday, November 16, 2026');
    expect(dayLabel('2026-07-16', 'en-US')).toBe('Thursday, July 16, 2026');
    expect(dayLabel('2026-03-08', 'en-US')).toBe('Sunday, March 8, 2026');
    expect(dayLabel('2026-11-01', 'en-US')).toBe('Sunday, November 1, 2026');
    expect(dayLabel('2026-12-31', 'en-US')).toBe('Thursday, December 31, 2026');
  });

  it('is the same in every viewer zone', () => {
    const labels = VIEWER_ZONES.map((tz) => inZone(tz, () => dayLabel('2026-11-16', 'en-US')));
    expect(new Set(labels)).toEqual(new Set(['Monday, November 16, 2026']));
  });

  it('labels the month grid’s padding cells at the 1970-01 / 9999-12 boundary', () => {
    expect(dayLabel('1969-12-28', 'en-US')).toBe('Sunday, December 28, 1969');
    for (const [y, m] of [[1970, 1], [9999, 12]] as const) {
      for (const cell of buildMonthGrid(y, m).weeks.flat()) {
        expect(() => dayLabel(cell.iso)).not.toThrow();
        expect(() => dayWindow(cell.iso, 'America/Chicago')).not.toThrow();
      }
    }
  });
});

// ─── 4. Server → browser hand-off ─────────────────────────────────────────────

describe('4. server (UTC) → browser (viewer zone) hand-off', () => {
  it.each(VIEWER_ZONES)(
    '%s: ?date=2026-11-16 heads, steps and windows as Monday, November 16',
    (viewerTz) => {
      // The RSC page, on a UTC server: resolve ?date= and the day's window.
      const { day, window } = inZone('UTC', () => {
        const d = parseDayParam('2026-11-16')!;
        return { day: d, window: dayWindow(d, viewerTz) };
      });
      // The browser: DateNav labels and steps the same day string, and the
      // window runs from the viewer's midnight to the next.
      inZone(viewerTz, () => {
        expect(dayLabel(day, 'en-US')).toBe('Monday, November 16, 2026');
        expect(addDays(day, 1)).toBe('2026-11-17');
        expect(addDays(day, -1)).toBe('2026-11-15');
        expect(localDay(window.from)).toBe('2026-11-16');
        expect(window.from.getHours()).toBe(0);
        expect(localDay(new Date(window.from.getTime() - 1))).toBe('2026-11-15');
        expect(localDay(new Date(window.to.getTime() - 1))).toBe('2026-11-16');
        expect(localDay(window.to)).toBe('2026-11-17');
      });
    },
  );

  it.each(VIEWER_ZONES)('%s: three Next clicks then one Previous move one day each', (viewerTz) => {
    const visited = inZone(viewerTz, () => {
      const days = ['2026-11-15'];
      for (let i = 0; i < 3; i++) days.push(addDays(days[days.length - 1]!, 1));
      days.push(addDays(days[days.length - 1]!, -1));
      return days.map((d) => [d, dayLabel(d, 'en-US')]);
    });
    expect(visited).toEqual([
      ['2026-11-15', 'Sunday, November 15, 2026'],
      ['2026-11-16', 'Monday, November 16, 2026'],
      ['2026-11-17', 'Tuesday, November 17, 2026'],
      ['2026-11-18', 'Wednesday, November 18, 2026'],
      ['2026-11-17', 'Tuesday, November 17, 2026'],
    ]);
  });

  it('the default day (no ?date=) is today on the viewer’s calendar, not the server’s', () => {
    // 2026-11-16 01:30 UTC is still Sunday evening in the US.
    const lateUsEvening = new Date('2026-11-16T01:30:00.000Z');
    const today = (tz: string) => inZone('UTC', () => dayInZone(lateUsEvening, tz));
    expect(today('America/Chicago')).toBe('2026-11-15');
    expect(today('America/New_York')).toBe('2026-11-15');
    expect(today('Pacific/Auckland')).toBe('2026-11-16');
    expect(today('UTC')).toBe('2026-11-16');
    // 2026-11-15 12:30 UTC is already Monday 01:30 in Auckland.
    expect(inZone('UTC', () => dayInZone(new Date('2026-11-15T12:30:00.000Z'), 'Pacific/Auckland'))).toBe(
      '2026-11-16',
    );
  });

  it('the board track starts at the viewer’s midnight: an 08:00 local block sits at 8am', () => {
    const eightLocal: Record<(typeof VIEWER_ZONES)[number], string> = {
      'America/Chicago': '2026-11-16T14:00:00.000Z', // CST
      'America/New_York': '2026-11-16T13:00:00.000Z', // EST
      'Pacific/Auckland': '2026-11-15T19:00:00.000Z', // NZDT
      UTC: '2026-11-16T08:00:00.000Z',
    };
    for (const tz of VIEWER_ZONES) {
      const startAt = new Date(eightLocal[tz]);
      const endAt = new Date(startAt.getTime() + HOUR_MS);
      const dayStartMs = inZone('UTC', () => dayWindow('2026-11-16', tz).from.getTime());
      const pos = blockPositionFromReservation({ startAt, endAt }, dayStartMs);
      expect(pos.leftPct).toBeCloseTo((8 / 24) * 100, 6);
      expect(pos.widthPct).toBeCloseTo((1 / 24) * 100, 6);
    }
  });
});

// ─── 5. dayInZone ─────────────────────────────────────────────────────────────

describe('5. dayInZone', () => {
  it('names the calendar day of an instant near midnight in each zone', () => {
    const t = new Date('2026-11-16T05:30:00.000Z');
    expect(dayInZone(t, 'America/Chicago')).toBe('2026-11-15'); // 23:30 CST
    expect(dayInZone(t, 'America/New_York')).toBe('2026-11-16'); // 00:30 EST
    expect(dayInZone(t, 'Pacific/Auckland')).toBe('2026-11-16'); // 18:30 NZDT
    expect(dayInZone(t, 'UTC')).toBe('2026-11-16');
    expect(dayInZone(new Date('2026-12-31T23:59:59.999Z'), 'Pacific/Kiritimati')).toBe('2027-01-01');
    expect(dayInZone(new Date('2027-01-01T00:00:00.000Z'), 'America/Chicago')).toBe('2026-12-31');
  });
});

// ─── 6. dayWindow ─────────────────────────────────────────────────────────────

describe('6. dayWindow', () => {
  const cases: Array<[tz: string, day: string, from: string, to: string, hours: number]> = [
    ['America/Chicago', '2026-11-16', '2026-11-16T06:00:00.000Z', '2026-11-17T06:00:00.000Z', 24],
    ['America/Chicago', '2026-03-08', '2026-03-08T06:00:00.000Z', '2026-03-09T05:00:00.000Z', 23],
    ['America/Chicago', '2026-11-01', '2026-11-01T05:00:00.000Z', '2026-11-02T06:00:00.000Z', 25],
    ['America/New_York', '2026-11-16', '2026-11-16T05:00:00.000Z', '2026-11-17T05:00:00.000Z', 24],
    ['Pacific/Auckland', '2026-11-16', '2026-11-15T11:00:00.000Z', '2026-11-16T11:00:00.000Z', 24],
    ['Pacific/Auckland', '2026-09-27', '2026-09-26T12:00:00.000Z', '2026-09-27T11:00:00.000Z', 23],
    ['Pacific/Auckland', '2026-04-05', '2026-04-04T11:00:00.000Z', '2026-04-05T12:00:00.000Z', 25],
    ['UTC', '2026-11-16', '2026-11-16T00:00:00.000Z', '2026-11-17T00:00:00.000Z', 24],
    // Midnight skipped by the DST jump: the day starts at the jump.
    ['America/Havana', '2026-03-08', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z', 23],
    ['America/Santiago', '2026-09-06', '2026-09-06T04:00:00.000Z', '2026-09-07T03:00:00.000Z', 23],
    ['Asia/Beirut', '2026-03-29', '2026-03-28T22:00:00.000Z', '2026-03-29T21:00:00.000Z', 23],
    // Midnight happens twice: the day starts at the first one.
    ['America/Havana', '2026-11-01', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z', 25],
    ['America/Santiago', '2026-04-04', '2026-04-04T03:00:00.000Z', '2026-04-05T04:00:00.000Z', 25],
    // The far ends of the offset range.
    ['Pacific/Kiritimati', '2026-11-16', '2026-11-15T10:00:00.000Z', '2026-11-16T10:00:00.000Z', 24],
    ['Pacific/Pago_Pago', '2026-11-16', '2026-11-16T11:00:00.000Z', '2026-11-17T11:00:00.000Z', 24],
  ];

  it.each(cases)('%s %s → [%s, %s) (%i h)', (tz, day, from, to, hours) => {
    const w = dayWindow(day, tz);
    expect(iso(w.from)).toBe(from);
    expect(iso(w.to)).toBe(to);
    expect((w.to.getTime() - w.from.getTime()) / HOUR_MS).toBe(hours);
  });

  it('month and year ends: the window crosses into the next month cleanly', () => {
    expect(iso(dayWindow('2026-11-30', 'America/Chicago').to)).toBe('2026-12-01T06:00:00.000Z');
    expect(iso(dayWindow('2026-12-31', 'America/Chicago').to)).toBe('2027-01-01T06:00:00.000Z');
    expect(iso(dayWindow('2026-02-28', 'Pacific/Auckland').to)).toBe('2026-02-28T11:00:00.000Z');
  });

  // Brute-force oracle: the first whole minute whose local day is `day` or later.
  const oracleFormatters = new Map<string, Intl.DateTimeFormat>();
  function oracleLocalDay(ms: number, tz: string): string {
    let fmt = oracleFormatters.get(tz);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
      oracleFormatters.set(tz, fmt);
    }
    const parts = fmt.formatToParts(new Date(ms));
    const get = (type: string) => parts.find((p) => p.type === type)!.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
  function oracleDayStart(day: string, tz: string): number {
    const { year, month, day: d } = splitDay(day);
    let lo = Date.UTC(year, month - 1, d) / 60_000 - 16 * 60;
    let hi = lo + 32 * 60;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (oracleLocalDay(mid * 60_000, tz) >= day) hi = mid;
      else lo = mid + 1;
    }
    return lo * 60_000;
  }

  it.each([
    ...VIEWER_ZONES,
    'America/Havana',
    'America/Santiago',
    'Asia/Beirut',
    'Australia/Lord_Howe', // half-hour DST
    'Asia/Kathmandu', // +05:45
  ])('%s: every 2026 day starts where the oracle says, back to back, 23–25 h long', (tz) => {
    let day = '2026-01-01';
    let prev: { to: Date } | null = null;
    for (let i = 0; i < 365; i++) {
      const w = dayWindow(day, tz);
      expect(w.from.getTime(), `${tz} ${day}`).toBe(oracleDayStart(day, tz));
      if (prev) expect(w.from.getTime(), `${tz} ${day} follows the previous day`).toBe(prev.to.getTime());
      const hours = (w.to.getTime() - w.from.getTime()) / HOUR_MS;
      expect([23, 23.5, 24, 24.5, 25], `${tz} ${day} is ${hours} h`).toContain(hours);
      prev = w;
      day = addDays(day, 1);
    }
  });
});

// ─── 7. Time-zone validation ──────────────────────────────────────────────────

describe('7. isValidTimeZone / resolveTimeZone', () => {
  it('accepts IANA zones this runtime knows', () => {
    for (const tz of ['America/Chicago', 'UTC', 'Etc/GMT+5', 'America/Argentina/Buenos_Aires', 'America/Port-au-Prince']) {
      expect(isValidTimeZone(tz)).toBe(true);
    }
  });

  it('rejects unknown zones, cookie-attribute smuggling, paths and oversized values', () => {
    for (const tz of ['', 'Mars/Olympus_Mons', 'America/Chicago; path=/', '../../etc/passwd', 'A'.repeat(65)]) {
      expect(isValidTimeZone(tz)).toBe(false);
    }
  });

  it('resolveTimeZone keeps a valid cookie value as sent, else the fallback', () => {
    expect(resolveTimeZone('Pacific/Auckland', 'UTC')).toBe('Pacific/Auckland');
    expect(resolveTimeZone(undefined, 'UTC')).toBe('UTC');
    expect(resolveTimeZone(null, 'America/Chicago')).toBe('America/Chicago');
    expect(resolveTimeZone('nope/never', 'America/Chicago')).toBe('America/Chicago');
  });
});

// ─── 8. Page wiring ───────────────────────────────────────────────────────────

const shellDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'o', '[slug]', '(shell)');
const source = (file: string) => readFileSync(join(shellDir, file), 'utf8');

/** The JSX opening tag `<Component … />` in `src`, props included. */
function openingTag(src: string, component: string): string {
  const start = src.indexOf(`<${component}`);
  expect(start, `<${component}> is rendered`).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf('/>', start));
}

describe('8. the schedule pages use the day helpers end to end', () => {
  it.each(['schedule/page.tsx', 'schedule/board/page.tsx'])(
    '%s resolves ?date= as a calendar day and queries the viewer-zone window',
    (file) => {
      const src = source(file);
      expect(src).toContain('await getViewerTimeZone()');
      expect(src).toContain('parseDayParam(dateParam)');
      expect(src).toContain('dayWindow(dateStr, timeZone)');
      expect(src).toContain('<ViewerTimeZoneSync serverTimeZone={timeZone} />');
    },
  );

  it.each([
    ['schedule/page.tsx', 'ReservationList'],
    ['schedule/board/page.tsx', 'DispatchBoardAny'],
  ])('%s keys <%s> by the day and the zone it was fetched for', (file, component) => {
    expect(openingTag(source(file), component)).toContain('key={`${dateStr}@${timeZone}`}');
  });

  it('the board lays blocks out from the window the page queried', () => {
    const tag = openingTag(source('schedule/board/page.tsx'), 'DispatchBoardAny');
    expect(tag).toContain('day={dateStr}');
    expect(tag).toContain('dayStartMs={dayWin.from.getTime()}');
  });
});
