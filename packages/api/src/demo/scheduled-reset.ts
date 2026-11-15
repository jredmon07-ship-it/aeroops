/**
 * demo/scheduled-reset.ts — the hosted demo's daily refresh.
 *
 * PROBLEM: the demo seed is anchored to the moment it runs (today's flights,
 * the last month of activity, the coming six weeks, recent announcements), so
 * a demo seeded once ages out of every window within weeks. The dashboard's
 * 30-day view then reads zero flights.
 *
 * SOLUTION: Vercel Cron calls GET /api/cron/demo-reset once a day
 * (apps/web/vercel.json), and this re-seeds BOTH demo orgs through the existing
 * reset (demo/reset.ts: hard slug allowlist, advisory lock, throttle, one
 * transaction, privileged AEROOPS_DEMO_OWNER_URL client), so the demo stays
 * current indefinitely.
 *
 * Unlike reset-on-open it runs OFF the login path: logins stay fast, and a
 * visitor is never reset mid-session by someone else's login. Sessions open at
 * the moment it runs are signed out (the orgs are recreated), which is why it
 * is scheduled for the middle of the night, US time: 09:00 UTC, 03:00 Chicago
 * (04:00 in summer). That is before the day's first flight, and the seed dates
 * nothing after the moment it runs (demo/seed.ts, flyAsOf), so each day starts
 * with today's flights booked and only Bravo's overnight trip out.
 *
 * GATES, all checked before any database work:
 *   1. AEROOPS_DEMO_DAILY_RESET is truthy. It is set ONLY on the public demo, so
 *      a self-hosted deployment of this repo answers 404 and never resets.
 *   2. CRON_SECRET is set and the request carries `Authorization: Bearer <it>`,
 *      which is exactly what Vercel Cron sends. Compared in constant time.
 * Then resetDemoTenant('alpha'), which rebuilds every allowlisted demo org.
 * Set AEROOPS_DEMO_TZ alongside it so the seed's times land on the operator's
 * wall clock rather than the server's UTC (demo/demo-clock.ts).
 */
import { timingSafeEqual } from 'node:crypto';
import { resetDemoTenant } from './reset.js';
import type { ResetResult } from './reset.js';

/** What the cron route answers. */
export interface ScheduledResetResponse {
  status: 200 | 401 | 404 | 500;
  body: { reset: boolean } | { error: string };
}

function dailyResetEnabled(): boolean {
  const v = (process.env['AEROOPS_DEMO_DAILY_RESET'] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function bearerMatches(authorization: string | null, secret: string): boolean {
  if (!authorization) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(authorization);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * runScheduledDemoReset — gate, then reset. `reset` is injectable for tests;
 * production uses resetDemoTenant. Never throws: failures become a 500 with a
 * generic body, and the detail goes to the function log.
 */
export async function runScheduledDemoReset(
  authorization: string | null,
  reset: (slug: string) => Promise<ResetResult> = resetDemoTenant,
): Promise<ScheduledResetResponse> {
  if (!dailyResetEnabled()) {
    return { status: 404, body: { error: 'not found' } };
  }
  const secret = (process.env['CRON_SECRET'] ?? '').trim();
  if (!secret || !bearerMatches(authorization, secret)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }
  try {
    const result = await reset('alpha');
    return { status: 200, body: { reset: result.reset } };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[demo-daily-reset] reset failed:', err);
    return { status: 500, body: { error: 'reset failed' } };
  }
}
