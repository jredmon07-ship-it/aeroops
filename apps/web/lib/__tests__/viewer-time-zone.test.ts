/**
 * viewer-time-zone.test.ts — The server reads the viewer's zone from the
 * aeroops-tz cookie (lib/viewer-time-zone.ts).
 *
 * COVERAGE:
 *   1. A valid zone in the cookie is the viewer's zone, as sent.
 *   2. No cookie, an unknown zone, or a value smuggling cookie attributes →
 *      the server's own zone (what the schedule used before the cookie).
 *
 * next/headers is mocked: cookies() only works inside a Next request.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { cookiesMock } = vi.hoisted(() => ({ cookiesMock: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: cookiesMock }));

import { getViewerTimeZone } from '../viewer-time-zone';
import { VIEWER_TZ_COOKIE } from '../schedule-day';

/** A request cookie store holding `value` under the aeroops-tz name (or nothing). */
function cookieStore(value?: string) {
  return {
    get: (name: string) =>
      name === VIEWER_TZ_COOKIE && value !== undefined ? { name, value } : undefined,
  };
}

const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

beforeEach(() => {
  cookiesMock.mockReset();
});

describe('getViewerTimeZone', () => {
  it('1. returns the zone the browser reported', async () => {
    expect(VIEWER_TZ_COOKIE).toBe('aeroops-tz');
    for (const tz of ['America/Chicago', 'Pacific/Auckland', 'Etc/GMT+5']) {
      cookiesMock.mockResolvedValue(cookieStore(tz));
      expect(await getViewerTimeZone()).toBe(tz);
    }
  });

  it('2. falls back to the server zone without a usable cookie', async () => {
    for (const value of [undefined, '', 'Mars/Olympus_Mons', 'America/Chicago; Path=/']) {
      cookiesMock.mockResolvedValue(cookieStore(value));
      expect(await getViewerTimeZone()).toBe(serverZone);
    }
  });
});
