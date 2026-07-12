/**
 * weather/get-org-field-status.ts — getOrgFieldStatus: read-only current field
 * status for the org's primary/home-base airport (ops status bar).
 *
 * FLOW:
 *   1. requireCapability('app:access') FIRST — the baseline capability EVERY
 *      authenticated role holds (the status bar shows on every shell screen,
 *      for every role, renter/student included).
 *   2. Resolve the org's PRIMARY location inside the RLS-scoped org context:
 *      the location that is home base to the MOST active aircraft (ORDER BY
 *      aircraft count DESC, created_at ASC as a stable tiebreak) — the same
 *      resource → location join get-metar-for-aircraft.ts uses, aggregated
 *      org-wide. An org with no location, or a location with neither an ICAO
 *      nor coordinates, converges on { available: false } — never a 500.
 *   3. Sunrise/sunset for TODAY at the base coordinates via @aeroops/core's
 *      pure computeSolarEvents (NOAA/Meeus — the civil-twilight calc).
 *   4. Current METAR via the injected WeatherProvider, behind a SHORT
 *      IN-PROCESS CACHE (per-station TTL — METAR observations update roughly
 *      hourly; the bar renders on every navigation, so we must not hammer AWC).
 *      The provider seam + memoization mirror weather/provider.ts exactly.
 *
 * FAIL SOFT — NEVER THROWS TO THE UI (beyond authz):
 *   Any provider failure degrades to null weather fields; any unexpected
 *   failure inside the org context resolves to { available: false }. A
 *   weather/solar outage must NEVER break the app shell.
 *
 * COMPLIANCE — DISPLAY-ONLY, ADVISORY:
 *   Weather + flight category + sunrise/sunset here are ADVISORY situational
 *   data ONLY — NEVER a go/no-go, airworthiness, dispatch, weather-briefing,
 *   or FAA night-currency/§61.57 determination. The pilot in command decides,
 *   and verifies with official sources. Must NEVER be wired into a gate/block
 *   write path (same posture as get-metar-for-aircraft.ts + civil twilight).
 *
 * TWO CALLING FORMS:
 *   getOrgFieldStatus(session)                             — app code.
 *   getOrgFieldStatusWithDb(db, session, provider?, nowMs?) — tests (inject a
 *   fake provider — never a real HTTP call — and a deterministic clock).
 */
import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { computeSolarEvents } from '@aeroops/core';
import type { FlightCategory, ParsedMetar } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { extractRows } from '../db-rows.js';
import { getWeatherProvider } from './provider.js';
import type { WeatherProvider } from './provider.js';

// ─── Result types ─────────────────────────────────────────────────────────────

/**
 * OrgFieldStatusData — the available arm. Weather fields are INDIVIDUALLY
 * nullable: a base with coordinates but no ICAO still gets sunrise/sunset
 * (and vice versa), and a provider outage nulls only the METAR fields — the
 * status bar degrades to "just clocks", never an error state.
 */
export interface OrgFieldStatusData {
  available: true;
  /** The resolved primary/home-base location's display name. */
  locationName: string;
  /** The base airport's ICAO station id, or null when not configured. */
  stationId: string | null;
  /** Verbatim raw METAR text (advisory display only). */
  rawMetar: string | null;
  /** Standard AWC/FAA category derived from ceiling/visibility ('UNKNOWN' when indeterminable). */
  flightCategory: FlightCategory | null;
  tempC: number | null;
  windDirDeg: number | null;
  windKt: number | null;
  gustKt: number | null;
  /** Observation time, ISO-8601 UTC, or null. */
  observedAt: string | null;
  /** Today's sunrise/sunset at the base coords, ISO-8601 UTC (null: no coords / polar day-night). */
  sunriseUtc: string | null;
  sunsetUtc: string | null;
}

export type OrgFieldStatusResult = OrgFieldStatusData | { available: false };

// ─── Pure raw-METAR field helpers (exported for unit tests) ───────────────────
//
// ParsedMetar (core) does not carry temperature or wind direction — both are
// present in the verbatim rawOb text, so we read them here with small, pure,
// fail-soft tokenizers rather than widening the frozen-in-practice core parse
// shape. NEVER throw; unmatched/VRB/missing → null.

const RAW_WIND_RE = /(?:^|\s)(\d{3})\d{2,3}(?:G\d{2,3})?KT(?:\s|$)/;
const RAW_TEMP_RE = /(?:^|\s)(M?\d{2})\/(?:M?\d{2})?(?:\s|$)/;

/** Wind direction (deg true) from raw METAR text. VRB / calm-unparseable → null. PURE. */
export function parseWindDirDegFromRaw(rawText: string | null): number | null {
  if (typeof rawText !== 'string') return null;
  const m = RAW_WIND_RE.exec(rawText);
  if (!m) return null;
  const deg = Number(m[1]);
  return Number.isFinite(deg) && deg >= 0 && deg <= 360 ? deg : null;
}

/** Temperature (°C) from the raw METAR temp/dewpoint group ('M' prefix = negative). PURE. */
export function parseTempCFromRaw(rawText: string | null): number | null {
  if (typeof rawText !== 'string') return null;
  const m = RAW_TEMP_RE.exec(rawText);
  if (!m || m[1] === undefined) return null;
  const tok = m[1];
  const negative = tok.startsWith('M');
  const n = Number(negative ? tok.slice(1) : tok);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// ─── Short in-process METAR cache ─────────────────────────────────────────────
//
// Mirrors the weather provider's process-memoization posture: module-level,
// in-process only, no persistence. Keyed by station (METAR is public,
// non-tenant data — a station's observation is identical for every org, so
// sharing the cache across orgs leaks nothing). TTL 5 minutes — observations
// update ~hourly; this only exists so per-navigation renders don't refetch.

const METAR_CACHE_TTL_MS = 5 * 60_000;

interface MetarCacheEntry {
  expiresAtMs: number;
  value: ParsedMetar | null;
}

const _metarCache = new Map<string, MetarCacheEntry>();

/** Test-only: clear the in-process METAR cache. */
export function __resetOrgFieldStatusCacheForTests(): void {
  _metarCache.clear();
}

async function fetchMetarCached(
  provider: WeatherProvider,
  icao: string,
  nowMs: number,
): Promise<ParsedMetar | null> {
  const key = icao.toUpperCase();
  const hit = _metarCache.get(key);
  if (hit && hit.expiresAtMs > nowMs) return hit.value;

  let value: ParsedMetar | null = null;
  try {
    value = await provider.fetchMetar(icao);
  } catch {
    // Defense in depth — providers never throw by contract, but a weather
    // failure must NEVER break the shell either way.
    value = null;
  }
  _metarCache.set(key, { expiresAtMs: nowMs + METAR_CACHE_TTL_MS, value });
  return value;
}

// ─── Shared implementation ────────────────────────────────────────────────────

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function toIsoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

async function _getOrgFieldStatusImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  provider: WeatherProvider = getWeatherProvider(),
  nowMs: number = Date.now(),
): Promise<OrgFieldStatusResult> {
  // 1. AUTHZ FIRST — baseline capability, every authenticated role.
  requireCapability(session, 'app:access');

  // (No input to validate — org_id comes ONLY from the session.)

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    try {
      // 2. Resolve the org's PRIMARY location — the home base of the most
      //    active aircraft (stable tiebreak: oldest location first). Same
      //    RLS-scoped resource/location join as get-metar-for-aircraft.ts,
      //    aggregated org-wide. Cross-org rows are invisible under the GUC.
      const result = await tx.execute(sql`
        SELECT
          l.name      AS "name",
          l.icao      AS "icao",
          l.latitude  AS "latitude",
          l.longitude AS "longitude"
        FROM location l
        LEFT JOIN resource r
          ON r.home_base_location_id = l.id
         AND r.kind = 'aircraft'
         AND r.active = true
        GROUP BY l.id, l.name, l.icao, l.latitude, l.longitude, l.created_at
        ORDER BY COUNT(r.id) DESC, l.created_at ASC
        LIMIT 1
      `);
      const rows = extractRows<{
        name: string;
        icao: string | null;
        latitude: string | number | null;
        longitude: string | number | null;
      }>(result);
      const loc = rows[0];
      if (!loc) return { available: false } as const;

      const latitude = toFiniteNumber(loc.latitude);
      const longitude = toFiniteNumber(loc.longitude);
      const icao = typeof loc.icao === 'string' && loc.icao.trim() !== '' ? loc.icao.trim() : null;

      // Neither a station nor coordinates → nothing to show.
      if (!icao && (latitude === null || longitude === null)) {
        return { available: false } as const;
      }

      // 3. Sunrise/sunset for today at the base coords (pure NOAA/Meeus calc).
      let sunriseUtc: string | null = null;
      let sunsetUtc: string | null = null;
      if (latitude !== null && longitude !== null) {
        const events = computeSolarEvents({ latitude, longitude, dateUtcMs: nowMs });
        sunriseUtc = toIsoOrNull(events.sunriseUtcMs);
        sunsetUtc = toIsoOrNull(events.sunsetUtcMs);
      }

      // 4. Current METAR — short-cached, best-effort, never throws.
      const metar = icao ? await fetchMetarCached(provider, icao, nowMs) : null;

      return {
        available: true,
        locationName: loc.name,
        stationId: icao,
        rawMetar: metar?.rawText ?? null,
        flightCategory: metar?.flightCategory ?? null,
        tempC: parseTempCFromRaw(metar?.rawText ?? null),
        windDirDeg: parseWindDirDegFromRaw(metar?.rawText ?? null),
        windKt: metar?.windKt ?? null,
        gustKt: metar?.gustKt ?? null,
        observedAt: toIsoOrNull(metar?.observedAt ?? null),
        sunriseUtc,
        sunsetUtc,
      } as const;
    } catch {
      // FAIL SOFT: the status bar must never surface an error state.
      return { available: false } as const;
    }
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function getOrgFieldStatus(
  session: AppSession | null | undefined,
): Promise<OrgFieldStatusResult> {
  const db = await getDb();
  return _getOrgFieldStatusImpl(db, session);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function getOrgFieldStatusWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  provider?: WeatherProvider,
  nowMs?: number,
): Promise<OrgFieldStatusResult> {
  return _getOrgFieldStatusImpl(db, session, provider, nowMs);
}
