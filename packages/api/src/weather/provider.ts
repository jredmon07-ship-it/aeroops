/**
 * weather/provider.ts — the METAR weather provider SEAM (Slice W1).
 *
 * Mirrors the house pattern established by notifications/email-provider.ts:
 * a small interface + a real implementation behind a single factory. UNLIKE
 * that one, the AWC Aviation Weather Center
 * Data API is free and keyless (no signup, no secret to configure) — so there
 * is no "unconfigured stub" arm here; `getWeatherProvider()` always returns
 * the real (live-fetching) provider. Tests inject a FAKE WeatherProvider
 * directly into the `*WithDb` command form (see get-metar-for-aircraft.ts)
 * rather than making a real HTTP call.
 *
 * ── API SURFACE (confirmed 2026-07 against aviationweather.gov/data/schema/openapi.yaml
 *    + a live sample fetch) ──────────────────────────────────────────────────
 *   GET https://aviationweather.gov/api/data/metar?ids={ICAO}&format=json
 *   No auth, no API key. Returns a JSON ARRAY (empty when the station id is
 *   unknown / has no recent observation); each element carries (at least):
 *     icaoId, obsTime (unix seconds), wdir, wspd, wgst?, visib (number|string,
 *     e.g. "10+"), vertVis, clouds: [{ cover, base }], rawOb, fltCat.
 *   See packages/core/src/weather/metar.ts (parseMetarJson) for the exact
 *   field-by-field parse.
 *
 * ── COMPLIANCE — DISPLAY-ONLY ─────────────────────────────────────────────────
 *   This provider (and every caller of it) surfaces weather for situational
 *   awareness ONLY — NEVER a go/no-go, airworthiness, or dispatch
 *   determination. The pilot in command decides. See
 *   docs/specs/slice-weather-metar.md. [VERIFY-W1-A]
 *
 * ── BEST-EFFORT — NEVER THROWS ────────────────────────────────────────────────
 *   fetchMetar NEVER throws. Any failure (network error, non-2xx, malformed/
 *   empty JSON body, unknown station) resolves to `null`. A weather-provider
 *   outage must never break the dispatch board or the new-reservation form —
 *   this mirrors the "queue + retry / graceful outage" guardrail, simplified
 *   here to "degrade to no weather chip" since this is a pure display read
 *   with no write/queue semantics.
 */

import { parseMetarJson } from '@aeroops/core';
import type { ParsedMetar } from '@aeroops/core';

const AWC_METAR_BASE = 'https://aviationweather.gov/api/data/metar';

// ─── Interface ────────────────────────────────────────────────────────────────

/**
 * WeatherProvider — the abstraction boundary for fetching a station's current
 * METAR. Implementations MUST NEVER throw — `fetchMetar` resolves `null` on
 * any failure so callers can treat "no weather" as a normal, first-class
 * outcome (never a crash).
 */
export interface WeatherProvider {
  fetchMetar(icaoId: string): Promise<ParsedMetar | null>;
}

// ─── Real implementation (AWC — free, keyless) ───────────────────────────────

export class AwcWeatherProvider implements WeatherProvider {
  async fetchMetar(icaoId: string): Promise<ParsedMetar | null> {
    try {
      const url = `${AWC_METAR_BASE}?ids=${encodeURIComponent(icaoId)}&format=json`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;

      const json: unknown = await res.json();
      if (!Array.isArray(json) || json.length === 0) return null;

      return parseMetarJson(json[0]);
    } catch {
      // Network error, timeout, malformed JSON, etc. — best-effort, never throw.
      return null;
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

let _memoizedProvider: WeatherProvider | null = null;

/**
 * getWeatherProvider — returns the process-memoized WeatherProvider. Always
 * AwcWeatherProvider (no env-gated stub — AWC needs no key). Memoized like
 * getEmailProvider for consistency, though there is no per-
 * process config to re-resolve here.
 */
export function getWeatherProvider(): WeatherProvider {
  if (_memoizedProvider) return _memoizedProvider;
  _memoizedProvider = new AwcWeatherProvider();
  return _memoizedProvider;
}

/** Test-only: reset the memoized provider (e.g. after swapping global fetch mocks). */
export function __resetWeatherProviderForTests(): void {
  _memoizedProvider = null;
}
