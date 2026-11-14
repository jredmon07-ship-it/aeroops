/**
 * apps/web/app/api/cron/demo-reset/route.ts
 *
 * The hosted demo's daily refresh — GET only, Node runtime, called once a day
 * by Vercel Cron (apps/web/vercel.json).
 *
 * ── TRANSPORT ADAPTER ONLY ───────────────────────────────────────────────────
 * No SQL, no @aeroops/db import, no business logic. runScheduledDemoReset
 * (in @aeroops/api) does the gating and the reset:
 *   - 404 unless AEROOPS_DEMO_DAILY_RESET is on (set ONLY on the public demo),
 *   - 401 without `Authorization: Bearer <CRON_SECRET>`,
 *   - then the allowlisted wipe + re-seed of the demo orgs (demo/reset.ts).
 * Error detail goes to the function log, never into the response.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// One transaction re-seeds both demo orgs through the real write paths.
export const maxDuration = 300;

import { NextResponse } from 'next/server';
import { runScheduledDemoReset } from '@aeroops/api';

export async function GET(request: Request): Promise<NextResponse> {
  const { status, body } = await runScheduledDemoReset(request.headers.get('authorization'));
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
