/**
 * demo-clock.test.ts — the demo seed's wall clock (demo/demo-clock.ts).
 *
 * Default: process-local time, byte-identical to the seed's old inline helper.
 * With AEROOPS_DEMO_TZ: the operator's wall clock, regardless of the server's
 * own zone (Vercel functions run in UTC), including across a DST change.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { atLocal, weekdayAt, demoTimeZone, demoWallClockZone } from '../demo/demo-clock.js';

const prevTz = process.env['AEROOPS_DEMO_TZ'];
afterEach(() => {
  if (prevTz === undefined) delete process.env['AEROOPS_DEMO_TZ'];
  else process.env['AEROOPS_DEMO_TZ'] = prevTz;
});

/** The old inline helper: setDate + setHours on the process clock. */
function processLocal(now: Date, dayOffset: number, hour: number, minute: number): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

describe('demo clock — process-local by default', () => {
  it('matches setDate/setHours on the process clock when AEROOPS_DEMO_TZ is unset', () => {
    delete process.env['AEROOPS_DEMO_TZ'];
    const now = new Date('2026-11-14T03:30:00Z');
    expect(demoTimeZone()).toBeNull();
    for (const [day, h, m] of [[0, 7, 0], [2, 9, 15], [-28, 8, 0], [42, 16, 0]] as const) {
      expect(atLocal(day, h, m, now).getTime()).toBe(processLocal(now, day, h, m).getTime());
    }
    expect(weekdayAt(0, now)).toBe(processLocal(now, 0, 12, 0).getDay());
  });

  it('ignores an invalid zone', () => {
    process.env['AEROOPS_DEMO_TZ'] = 'Mars/Olympus_Mons';
    const now = new Date('2026-11-14T03:30:00Z');
    expect(demoTimeZone()).toBeNull();
    expect(atLocal(1, 7, 0, now).getTime()).toBe(processLocal(now, 1, 7, 0).getTime());
  });
});

describe('demo clock — AEROOPS_DEMO_TZ pins the wall clock', () => {
  it('uses the zone\'s own date for "today", not UTC\'s', () => {
    process.env['AEROOPS_DEMO_TZ'] = 'America/Chicago';
    // 03:30 UTC on Saturday the 14th is still Friday the 13th, 21:30, in Chicago.
    const now = new Date('2026-11-14T03:30:00Z');
    expect(atLocal(0, 7, 0, now).toISOString()).toBe('2026-11-13T13:00:00.000Z'); // 07:00 CST
    expect(atLocal(1, 7, 0, now).toISOString()).toBe('2026-11-14T13:00:00.000Z');
    expect(atLocal(-1, 18, 30, now).toISOString()).toBe('2026-11-13T00:30:00.000Z');
    expect(weekdayAt(0, now)).toBe(5); // Friday
    expect(weekdayAt(2, now)).toBe(0); // Sunday
  });

  it('keeps the wall-clock hour across the spring-forward change', () => {
    process.env['AEROOPS_DEMO_TZ'] = 'America/Chicago';
    // Saturday 7 March 2026, noon CST; DST starts at 02:00 on Sunday the 8th.
    const now = new Date('2026-03-07T18:00:00Z');
    expect(atLocal(0, 7, 0, now).toISOString()).toBe('2026-03-07T13:00:00.000Z'); // 07:00 CST (UTC-6)
    expect(atLocal(1, 7, 0, now).toISOString()).toBe('2026-03-08T12:00:00.000Z'); // 07:00 CDT (UTC-5)
  });
});

describe('demo clock — one zone for every seeded row', () => {
  it('is AEROOPS_DEMO_TZ when set, else the process zone', () => {
    process.env['AEROOPS_DEMO_TZ'] = 'Pacific/Auckland';
    expect(demoWallClockZone()).toBe('Pacific/Auckland');
    delete process.env['AEROOPS_DEMO_TZ'];
    expect(demoWallClockZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
