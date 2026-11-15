/**
 * zoned-format.test.ts — Instants for people, in the zone the request resolved
 * (lib/zoned-format.ts).
 *
 * The bug these pin down: server-rendered pages formatted with the runtime's
 * zone, which is UTC on Vercel. A 16:30–18:00 CST checkout read "Nov 15, 2026,
 * 10:30 PM → Nov 16, 2026, 12:00 AM" on the aircraft page while the schedule
 * said 16:30–18:00; client components rendered UTC on the server and local
 * time in the browser (a hydration mismatch).
 *
 * No expectation depends on the process time zone. Run the file under several:
 *   for tz in UTC America/Chicago Pacific/Auckland; do
 *     TZ=$tz pnpm --filter @aeroops/web exec vitest run lib/__tests__/zoned-format.test.ts
 *   done
 *
 * Coverage:
 *   1. The same instant reads in the zone passed, not the runtime's.
 *   2. Date-only, date+time, short date+time and 24-hour clock shapes.
 *   3. Missing or unreadable instants → "—"; an unknown zone → UTC, no throw.
 *   4. Zone short names follow DST (CST / CDT).
 *   5. Plain ASCII spaces only, so Node and the browser render the same string.
 */
import { describe, it, expect } from 'vitest';
import {
  NO_TIME,
  formatInZone,
  formatZonedDate,
  formatZonedDateTime,
  formatZonedShortDateTime,
  formatZonedClock,
  zoneAbbreviation,
} from '../zoned-format';

// The live example: a 16:30–18:00 CST checkout on Nov 15, 2026.
const START = '2026-11-15T22:30:00.000Z';
const END = '2026-11-16T00:00:00.000Z';

describe('1. the zone passed decides the reading', () => {
  it('America/Chicago reads the checkout as 4:30 PM → 6:00 PM on Nov 15', () => {
    expect(formatZonedDateTime(START, 'America/Chicago')).toBe('Nov 15, 2026, 4:30 PM');
    expect(formatZonedDateTime(END, 'America/Chicago')).toBe('Nov 15, 2026, 6:00 PM');
  });

  it('UTC reads the same instants as 10:30 PM → 12:00 AM the next day', () => {
    expect(formatZonedDateTime(START, 'UTC')).toBe('Nov 15, 2026, 10:30 PM');
    expect(formatZonedDateTime(END, 'UTC')).toBe('Nov 16, 2026, 12:00 AM');
  });

  it('the calendar day follows the zone (an evening west of UTC)', () => {
    expect(formatZonedDate('2026-11-16T01:00:00Z', 'America/Chicago')).toBe('Nov 15, 2026');
    expect(formatZonedDate('2026-11-16T01:00:00Z', 'UTC')).toBe('Nov 16, 2026');
    expect(formatZonedDate('2026-11-15T12:00:00Z', 'Pacific/Auckland')).toBe('Nov 16, 2026');
  });

  it('accepts ISO strings, epoch ms and Dates alike', () => {
    const ms = Date.parse(START);
    expect(formatZonedClock(START, 'America/Chicago')).toBe('16:30');
    expect(formatZonedClock(ms, 'America/Chicago')).toBe('16:30');
    expect(formatZonedClock(new Date(ms), 'America/Chicago')).toBe('16:30');
  });
});

describe('2. shapes', () => {
  it('short date+time drops the year', () => {
    expect(formatZonedShortDateTime(START, 'America/Chicago')).toBe('Nov 15, 4:30 PM');
  });

  it('the clock is 24-hour with midnight as 00:00', () => {
    expect(formatZonedClock('2026-11-16T06:00:00Z', 'America/Chicago')).toBe('00:00');
    expect(formatZonedClock('2026-11-16T05:59:00Z', 'America/Chicago')).toBe('23:59');
    expect(formatZonedClock('2026-06-19T08:05:00Z', 'UTC')).toBe('08:05');
  });

  it('formatInZone takes any Intl options', () => {
    expect(formatInZone(START, 'America/Chicago', { month: 'short', day: 'numeric' })).toBe('Nov 15');
  });
});

describe('3. never throws', () => {
  it('missing or unreadable instants read as "—"', () => {
    for (const value of [null, undefined, '', 'not-a-date', Number.NaN, new Date('nope')]) {
      expect(formatZonedDateTime(value, 'America/Chicago')).toBe(NO_TIME);
      expect(formatZonedDate(value, 'UTC')).toBe(NO_TIME);
      expect(formatZonedClock(value, 'UTC')).toBe(NO_TIME);
    }
  });

  it('an unknown zone falls back to UTC instead of throwing', () => {
    expect(formatZonedDateTime(START, 'Mars/Olympus_Mons')).toBe('Nov 15, 2026, 10:30 PM');
    expect(zoneAbbreviation('Mars/Olympus_Mons', new Date(START))).toBe('UTC');
  });
});

describe('4. zone short names', () => {
  it('follow daylight saving', () => {
    expect(zoneAbbreviation('America/Chicago', new Date('2026-11-15T12:00:00Z'))).toBe('CST');
    expect(zoneAbbreviation('America/Chicago', new Date('2026-07-15T12:00:00Z'))).toBe('CDT');
    expect(zoneAbbreviation('UTC', new Date(START))).toBe('UTC');
  });
});

describe('5. plain spaces only', () => {
  it('no narrow or no-break spaces, whatever the ICU version', () => {
    const samples = [
      formatZonedDateTime(START, 'America/Chicago'),
      formatZonedShortDateTime(START, 'America/Chicago'),
      formatZonedDate(START, 'America/Chicago'),
      formatZonedClock(START, 'America/Chicago'),
    ];
    for (const s of samples) expect(s).not.toMatch(/[\u202f\u00a0]/);
  });
});
