/**
 * demo-scheduled-reset.test.ts — the daily refresh's gates (demo/scheduled-reset.ts).
 *
 * The reset itself is covered by demo-reset.test.ts; here it is injected, so
 * these tests prove only who may trigger it: nobody unless the flag is on, and
 * then only the CRON_SECRET bearer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runScheduledDemoReset } from '../demo/scheduled-reset.js';

const SECRET = 'test-cron-secret-0123456789';
const saved: Record<string, string | undefined> = {};
const KEYS = ['AEROOPS_DEMO_DAILY_RESET', 'CRON_SECRET'] as const;

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  process.env['AEROOPS_DEMO_DAILY_RESET'] = '1';
  process.env['CRON_SECRET'] = SECRET;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('demo daily reset — gates', () => {
  it('answers 404 and never resets when the flag is off', async () => {
    delete process.env['AEROOPS_DEMO_DAILY_RESET'];
    const reset = vi.fn();
    const res = await runScheduledDemoReset(`Bearer ${SECRET}`, reset);
    expect(res.status).toBe(404);
    expect(reset).not.toHaveBeenCalled();
  });

  it('answers 401 when CRON_SECRET is unset, even with a bearer', async () => {
    delete process.env['CRON_SECRET'];
    const reset = vi.fn();
    expect((await runScheduledDemoReset('Bearer ', reset)).status).toBe(401);
    expect((await runScheduledDemoReset(`Bearer ${SECRET}`, reset)).status).toBe(401);
    expect(reset).not.toHaveBeenCalled();
  });

  it('answers 401 for a missing, wrong, or near-miss bearer', async () => {
    const reset = vi.fn();
    for (const header of [null, '', SECRET, `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(0, -1)}`, `bearer ${SECRET}`]) {
      expect((await runScheduledDemoReset(header, reset)).status).toBe(401);
    }
    expect(reset).not.toHaveBeenCalled();
  });

  it('resets the demo orgs for the right bearer', async () => {
    const reset = vi.fn().mockResolvedValue({ reset: true });
    const res = await runScheduledDemoReset(`Bearer ${SECRET}`, reset);
    expect(res).toEqual({ status: 200, body: { reset: true } });
    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith('alpha');
  });

  it('reports a throttled or locked-out run as reset: false', async () => {
    const reset = vi.fn().mockResolvedValue({ reset: false });
    expect(await runScheduledDemoReset(`Bearer ${SECRET}`, reset)).toEqual({
      status: 200,
      body: { reset: false },
    });
  });

  it('turns a failure into a generic 500 without leaking detail', async () => {
    const reset = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED owner@db-host'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await runScheduledDemoReset(`Bearer ${SECRET}`, reset);
    expect(res).toEqual({ status: 500, body: { error: 'reset failed' } });
    spy.mockRestore();
  });
});
