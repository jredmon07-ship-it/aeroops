/**
 * demo/demo-clock.ts — the wall clock the demo seed is staged in.
 *
 * Every seeded time is "N days from today at HH:MM". By default that is the
 * PROCESS's local time: a developer's laptop running `pnpm demo`, or the Mac a
 * maintainer runs `pnpm db:seed:demo` from. That behaviour is unchanged.
 *
 * A seed that runs on a server needs a fixed zone instead. Vercel functions run
 * in UTC, so "07:00 local" there is 07:00 UTC, which is the middle of the night
 * for the operator. AEROOPS_DEMO_TZ (an IANA zone) pins the seed to that wall
 * clock; the hosted demo's daily refresh (demo/scheduled-reset.ts) runs with it
 * set to America/Chicago. Rows that take an explicit zone follow the same clock
 * (demoWallClockZone). An invalid zone is ignored (process-local time).
 *
 * DEMO-ONLY, like the rest of demo/.
 */
import { makeApiZonedToUtcResolver, isValidIanaTz } from '../scheduling/internal.js';

const zonedToUtc = makeApiZonedToUtcResolver();

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** The configured demo zone, or null for process-local time. */
export function demoTimeZone(): string | null {
  const tz = (process.env['AEROOPS_DEMO_TZ'] ?? '').trim();
  return tz && isValidIanaTz(tz) ? tz : null;
}

/**
 * demoWallClockZone — the IANA zone the demo wall clock is in: AEROOPS_DEMO_TZ,
 * else the process's own zone. Seed rows that take an explicit zone (the
 * recurring series, operating hours) use it so every seeded time shares one
 * clock. A series pinned to some other zone lands at a different local hour
 * and can collide with the forward schedule: 17:00 Chicago is midday in
 * Auckland, the middle of the weekday Archer rentals.
 */
export function demoWallClockZone(): string {
  return demoTimeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
}

/** The calendar date, in `tz`, of the instant `now`. */
function civilDateIn(now: Date, tz: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/**
 * atLocal — a Date at `hour:minute` on the day `dayOffset` days from today, on
 * the demo wall clock (AEROOPS_DEMO_TZ, else process-local time). `now` is
 * injectable for tests.
 */
export function atLocal(dayOffset: number, hour: number, minute = 0, now: Date = new Date()): Date {
  const tz = demoTimeZone();
  if (!tz) {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, minute, 0, 0);
    return d;
  }
  const today = civilDateIn(now, tz);
  // Calendar arithmetic on the civil date; UTC is only the carrier here.
  const target = new Date(Date.UTC(today.year, today.month - 1, today.day + dayOffset));
  const { utcMs } = zonedToUtc({
    year: target.getUTCFullYear(),
    month: target.getUTCMonth() + 1,
    day: target.getUTCDate(),
    hour,
    minute,
    tz,
  });
  return new Date(utcMs);
}

/**
 * weekdayAt — day of week (0 = Sunday … 6 = Saturday) of the day `dayOffset`
 * days from today, on the demo wall clock. Read at noon, clear of any DST edge.
 */
export function weekdayAt(dayOffset: number, now: Date = new Date()): number {
  const noon = atLocal(dayOffset, 12, 0, now);
  const tz = demoTimeZone();
  if (!tz) return noon.getDay();
  const short = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(noon);
  return WEEKDAYS.indexOf(short as (typeof WEEKDAYS)[number]);
}
