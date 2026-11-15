/**
 * clock-time-hydration.test.ts — The schedule's clock times are the same text
 * on the server and in the browser.
 *
 * The bug: formatTime / formatTimeRange (schedule/_utils/format-time.ts) read
 * the clock in the RUNTIME's zone. The server renders in UTC (Vercel), the
 * browser in the viewer's zone, so the server HTML said "14:00 – 15:00" where
 * the browser said "08:00 – 09:00": React logged #418 ("Hydration failed")
 * and the list cards, board blocks and month chips showed UTC times until it
 * re-rendered them. The helpers now take the viewer's zone explicitly.
 *
 * Each case formats one instant with the process zone set to UTC (the
 * server) and to the viewer's zone (the browser) and expects the same text.
 * The control case proves the switch really changes the runtime's zone.
 *
 * Lives in board/_utils because vitest.config.ts collects schedule tests only
 * from board/_utils, new/_components/__tests__ and auto/_components/__tests__.
 * Holds whatever the process zone is:
 *   for tz in America/Chicago America/New_York Pacific/Auckland UTC; do
 *     TZ=$tz pnpm --filter @aeroops/web exec vitest run clock-time-hydration
 *   done
 *
 * The last block scans the pages' source (like lib/__tests__/schedule-day
 * .test.ts): each schedule page resolves the viewer's zone and hands it to
 * the components that format times while rendering on the server. The board
 * page renders DispatchBoard through an `any` cast, so tsc cannot see a
 * dropped prop there.
 *
 * PURE: no DOM, no React, no Next.js.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatTime, formatTimeRange } from '../../_utils/format-time';

const SERVER_TZ = 'UTC';
const VIEWER_TZ = 'America/Chicago';

/** Run `fn` with the process (i.e. Date's and Intl's "local") zone switched to `tz`. */
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

// 2026-11-16 14:00 UTC = 08:00 CST, the board's morning.
const START = new Date('2026-11-16T14:00:00.000Z');
const END = new Date('2026-11-16T15:30:00.000Z');

describe('clock times: the server HTML matches the browser’s first render', () => {
  it('control: a zone-less format differs between a UTC server and a Chicago browser', () => {
    // What the helpers did before: this is the mismatch React reported.
    const zoneless = () =>
      new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(START);
    expect(inZone(SERVER_TZ, zoneless)).toBe('14:00');
    expect(inZone(VIEWER_TZ, zoneless)).toBe('08:00');
  });

  it('one instant formats identically on a UTC server and in a Chicago browser', () => {
    const onServer = inZone(SERVER_TZ, () => formatTime(START, VIEWER_TZ));
    const inBrowser = inZone(VIEWER_TZ, () => formatTime(START, VIEWER_TZ));
    expect(onServer).toBe('08:00');
    expect(inBrowser).toBe(onServer);

    const rangeOnServer = inZone(SERVER_TZ, () => formatTimeRange(START, END, VIEWER_TZ));
    const rangeInBrowser = inZone(VIEWER_TZ, () => formatTimeRange(START, END, VIEWER_TZ));
    expect(rangeOnServer).toBe('08:00 – 09:30');
    expect(rangeInBrowser).toBe(rangeOnServer);
  });

  it('every viewer zone reads its own clock, whatever zone the runtime is in', () => {
    const expected: Record<string, string> = {
      'America/Chicago': '08:00 – 09:30', // CST
      'America/New_York': '09:00 – 10:30', // EST
      'Pacific/Auckland': '03:00 – 04:30', // NZDT, already Nov 17
      UTC: '14:00 – 15:30',
    };
    for (const runtimeTz of Object.keys(expected)) {
      for (const [viewerTz, text] of Object.entries(expected)) {
        expect(inZone(runtimeTz, () => formatTimeRange(START, END, viewerTz))).toBe(text);
      }
    }
  });

  it('midnight reads 00:00, never 24:00', () => {
    const midnightChicago = new Date('2026-11-16T06:00:00.000Z');
    expect(inZone(SERVER_TZ, () => formatTime(midnightChicago, VIEWER_TZ))).toBe('00:00');
    expect(inZone(VIEWER_TZ, () => formatTime(midnightChicago, VIEWER_TZ))).toBe('00:00');
  });

  it('a zone the runtime does not know reads UTC instead of throwing', () => {
    expect(formatTime(START, 'Not/AZone')).toBe('14:00');
    expect(formatTimeRange(START, END, 'Not/AZone')).toBe('14:00 – 15:30');
  });

  it('on the fall-back day both 1:30s read 01:30 on both sides', () => {
    const firstOneThirty = new Date('2026-11-01T06:30:00.000Z'); // CDT
    const secondOneThirty = new Date('2026-11-01T07:30:00.000Z'); // CST
    for (const runtimeTz of [SERVER_TZ, VIEWER_TZ]) {
      expect(inZone(runtimeTz, () => formatTime(firstOneThirty, VIEWER_TZ))).toBe('01:30');
      expect(inZone(runtimeTz, () => formatTime(secondOneThirty, VIEWER_TZ))).toBe('01:30');
    }
  });
});

// ─── Page wiring (source scan) ────────────────────────────────────────────────

const scheduleDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = (file: string) => readFileSync(join(scheduleDir, file), 'utf8');

/** The JSX opening tag `<Component … />` in `src` (the first of `names` rendered). */
function openingTag(src: string, ...names: string[]): string {
  for (const name of names) {
    const start = src.search(new RegExp(`<${name}\\b`));
    if (start > -1) return src.slice(start, src.indexOf('/>', start));
  }
  throw new Error(`none of <${names.join('>, <')}> is rendered`);
}

describe('the schedule pages hand the viewer’s zone to everything that formats a time', () => {
  it.each(['page.tsx', 'board/page.tsx', 'series/[seriesId]/page.tsx', 'new/page.tsx'])(
    '%s resolves the viewer’s zone per request',
    (file) => {
      expect(source(file)).toContain('await getViewerTimeZone()');
    },
  );

  it.each([
    ['page.tsx', ['ReservationList'], ['timeZone={timeZone}']],
    ['page.tsx', ['MonthView'], ['timeZone={timeZone}']],
    [
      'board/page.tsx',
      ['DispatchBoardAny', 'DispatchBoard'],
      ['timeZone={timeZone}', 'dayStartMs={dayWin.from.getTime()}', 'dayEndMs={dayWin.to.getTime()}'],
    ],
    ['series/[seriesId]/page.tsx', ['SeriesContent'], ['timeZone={timeZone}']],
    ['series/[seriesId]/page.tsx', ['SeriesOccurrenceList'], ['timeZone={timeZone}']],
    // Keyed by the zone: the first visit's refresh restarts the form on the viewer's "today".
    ['new/page.tsx', ['NewReservationForm'], ['key={timeZone}', 'timeZone={timeZone}']],
  ])('%s passes %s the zone', (file, names, props) => {
    const tag = openingTag(source(file), ...names);
    for (const prop of props) expect(tag).toContain(prop);
  });
});
