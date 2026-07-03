/**
 * weather/get-metar-for-aircraft.ts — getMetarForAircraft: read-only current
 * METAR for one aircraft resource's home-base airport (Slice W1).
 *
 * FLOW:
 *   1. requireCapability('schedule:access') FIRST — the same base viewing
 *      capability the board + new-reservation surfaces already require.
 *   2. Resolve the resource's home-base ICAO via the resource → location join
 *      (RLS-scoped — mirrors loadTwilightContext's resource/location read in
 *      scheduling/internal.ts EXACTLY: LEFT JOIN on home_base_location_id,
 *      both tables under the tx's org GUC, so a cross-org resourceId or a
 *      non-aircraft resource is simply invisible/no-ICAO, never a 500, never
 *      a peek).
 *   3. No ICAO configured → return null (graceful empty state).
 *   4. Fetch + parse via the injected WeatherProvider — BEST EFFORT: any
 *      provider failure (already caught inside the provider, plus a defensive
 *      outer catch here) also resolves to null. A weather outage must NEVER
 *      break the caller (board / new-reservation form).
 *
 * GUARANTEES:
 *   - authz FIRST; org_id from session only; RLS-scoped throughout.
 *   - Read-only: no INSERT/UPDATE/DELETE, no audit row (mirrors previewTwilight
 *     — this is a passive display read, not a write-adjacent gate).
 *   - NEVER a go/no-go, airworthiness, or dispatch determination — see
 *     packages/core/src/weather/metar.ts + docs/specs/slice-weather-metar.md.
 *     Must NEVER be wired into a gate/block write path.
 *
 * TWO CALLING FORMS:
 *   getMetarForAircraft(session, { resourceId })                    — app code.
 *   getMetarForAircraftWithDb(db, session, { resourceId }, provider?) — tests
 *   (provider is always injectable so tests never make a real HTTP call).
 */
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import type { ParsedMetar } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { extractRows } from '../db-rows.js';
import { getWeatherProvider } from './provider.js';
import type { WeatherProvider } from './provider.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const getMetarForAircraftInputSchema = z.object({
  resourceId: z.string().regex(UUID_RE, { message: 'resourceId must be a UUID' }),
});

export type GetMetarForAircraftInput = z.infer<typeof getMetarForAircraftInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _getMetarForAircraftImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
  provider: WeatherProvider = getWeatherProvider(),
): Promise<ParsedMetar | null> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'schedule:access');

  // 2. VALIDATE.
  const parsed = getMetarForAircraftInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[weather] invalid getMetarForAircraft input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { resourceId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // Resolve home-base ICAO — RLS-scoped join, identical shape to
    // loadTwilightContext's resource/location read (scheduling/internal.ts).
    // Cross-org resourceId, a non-aircraft resource, or a home base with no
    // ICAO all converge on the same graceful `null` — no existence peek.
    const result = await tx.execute(sql`
      SELECT l.icao AS "icao"
      FROM resource r
      LEFT JOIN location l ON l.id = r.home_base_location_id
      WHERE r.id = ${resourceId}::uuid AND r.kind = 'aircraft'
    `);
    const rows = extractRows<{ icao: string | null }>(result);
    const icao = rows[0]?.icao ?? null;
    if (!icao) return null;

    try {
      return await provider.fetchMetar(icao);
    } catch {
      // Defense in depth — WeatherProvider.fetchMetar already never throws,
      // but a weather failure must NEVER break this read either way.
      return null;
    }
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getMetarForAircraft(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<ParsedMetar | null> {
  const db = await getDb();
  return _getMetarForAircraftImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getMetarForAircraftWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  provider?: WeatherProvider,
): Promise<ParsedMetar | null> {
  return _getMetarForAircraftImpl(db, session, input, provider);
}
