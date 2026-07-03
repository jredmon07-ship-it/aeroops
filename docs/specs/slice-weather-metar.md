# Slice W1 — METAR weather (display-only, informational)

## Scope

Fetch the CURRENT METAR for an aircraft's home-base airport (by ICAO) from the free, keyless
AWC (Aviation Weather Center) Data API, parse it into a small set of plain values, and show a
weather chip on the new-reservation aircraft picker. **NO persistence** — this is a live read
on every request (no cache table, no migration). No ICAO configured, or any fetch/parse
failure, both converge on a graceful empty state — never an error, never a blocked form.

This mirrors the house pattern set by civil twilight (Slice 4a) and grounding (Slice 3b):
computed/fetched data can inform, can WARN, but is never wired into a write gate.

## COMPLIANCE — hard line (verbatim posture, matches twilight/grounding)

**Weather here is INFORMATIONAL ONLY. It is NEVER a go/no-go, airworthiness, or dispatch
determination.** The pilot in command makes that call, always — using this data as one input
among many (official weather briefings, NOTAMs, personal minimums, etc.), never as a substitute
for one. This module:

- computes NO recommendation, NO pass/fail, NO block/allow decision;
- is NOT wired into `openDispatch`, `gatedCreateOccurrence`, or any other write/gate path;
- surfaces plain derived values (flight category, wind, visibility, ceiling, raw text, observed
  time) — never a raw, uninterpreted provider blob passed straight to the UI as "the answer."

The flight-category derivation (`deriveFlightCategory`) uses the same VFR/MVFR/IFR/LIFR
ceiling+visibility thresholds AWC itself publishes and that FAA weather briefings use as a
common shorthand — but computing that shorthand here does not make it a regulatory or
dispatch-authority determination. `[VERIFY-W1-A]`: confirm this framing holds if a future slice
ever considers surfacing weather more prominently (e.g. a dashboard widget) — the disclaimer
must travel with it verbatim.

## Provider — the AWC Data API (confirmed 2026-07)

- **Endpoint:** `GET https://aviationweather.gov/api/data/metar?ids={ICAO}&format=json`
- **Auth:** none — free, keyless, public. No secret to configure, no env var, no Stripe/QBO-style
  "unconfigured stub" arm (unlike other integrations in this codebase, there is nothing to be
  unconfigured).
- **Response:** a JSON array (empty when the station id is unknown, or has no recent
  observation). Confirmed field shape used by `parseMetarJson` (packages/core):
  `icaoId`, `obsTime` (unix seconds), `wdir`, `wspd`, `wgst?`, `visib` (number, or a string like
  `"10+"`/a fraction), `vertVis`, `clouds: [{ cover, base }]`, `rawOb`, `fltCat`.
- Source: `aviationweather.gov/data/schema/openapi.yaml` (the published OpenAPI schema) + a live
  sample fetch performed during this build (KJFK/KACV/KBOS/etc.) to confirm exact field names
  and value shapes (e.g. `visib` can be a bare number OR a `"10+"` string).

## Architecture

### `packages/core/src/weather/metar.ts` (PURE, no I/O)

- `deriveFlightCategory(ceilingFt, visibilitySM): FlightCategory` — standard thresholds:
  - VFR: ceiling > 3000 ft AND vis > 5 sm
  - MVFR: ceiling 1000–3000 ft OR vis 3–5 sm
  - IFR: ceiling 500–1000 ft OR vis 1–3 sm
  - LIFR: below IFR
  The WORSE of the ceiling-implied and visibility-implied category governs. Both unknown →
  `'UNKNOWN'` (never guesses VFR). Property-tested for monotonicity: worsening either input
  never improves the resulting category.
- `parseMetarJson(json: unknown): ParsedMetar` — the PRIMARY path; parses one AWC JSON array
  element into `{ flightCategory, windKt, gustKt, visibilitySM, ceilingFt, rawText, observedAt }`.
  Malformed-safe (never throws — property-tested with `fc.anything()`).
- `parseMetarText(rawText: unknown, opts?: { referenceUtcMs? }): ParsedMetar` — a defensive
  raw-text tokenizer fallback (wind/gust/visibility/cloud-layer/day-time groups). Round-trip
  property-tested (a synthetic METAR string built from known values parses back to those same
  values). The day/time group (`DDHHMMZ`) carries no year/month; `referenceUtcMs` is an OPTIONAL
  injected clock (mirrors civil-twilight's injected-clock discipline — never reads
  `Date.now()` internally) used only to resolve it to a full UTC instant; omitted → `null`.

### `packages/api/src/weather/`

- `provider.ts` — `WeatherProvider` interface + `AwcWeatherProvider` (real fetch client) +
  `getWeatherProvider()` factory (memoized, no env-gated stub since AWC needs no key).
  `fetchMetar` NEVER throws — any network/HTTP/parse failure resolves `null`.
- `get-metar-for-aircraft.ts` — `getMetarForAircraft(session, { resourceId })`:
  1. `requireCapability(session, 'schedule:access')` — the same base viewing capability the
     dispatch board and new-reservation form already require (mint no new cap).
  2. Resolve the resource's home-base ICAO via the RLS-scoped `resource ⟕ location` join —
     BYTE-IDENTICAL shape to `loadTwilightContext`'s resource/location read
     (`scheduling/internal.ts`). A cross-org `resourceId`, a non-aircraft resource, or a home
     base with no ICAO all converge on the same `null` — no existence peek, no 500.
  3. Fetch + parse via the injected `WeatherProvider`; any failure (already caught inside the
     provider, plus a defensive outer catch here) also resolves `null`.
  Read-only: no INSERT/UPDATE/DELETE, no audit row (mirrors `previewTwilight` — a passive
  display read, not a write-adjacent gate).

### Web — `apps/web/.../schedule/new/_components/weather-chip.tsx`

A small chip on the new-reservation aircraft picker: flight-category color + wind/gust +
visibility + "as of HH:MM" + the raw METAR text behind an expand toggle, plus the verbatim
advisory disclaimer. Empty states (`idle`/`error`/`weather===null`) render a muted hint, never
an error banner. Wired via `getMetarForAircraftAction` (`schedule/actions.ts`) — fires once per
aircraft selection (independent of date/time; this is a "now" snapshot, not a forecast).

## Testing

- `packages/core/src/__tests__/metar.test.ts` — reference-threshold tests, monotonicity
  property tests (fast-check), `parseMetarJson` confirmed-shape tests + malformed-safe
  (`fc.anything()`), `parseMetarText` token-extraction + synthetic round-trip property test +
  malformed-safe (`fc.string()`).
- `packages/api/src/__tests__/weather-api.test.ts` — integration suite against a FAKE
  `WeatherProvider` (recorded/synthetic responses) — **NO real HTTP anywhere in this suite**.
  Covers: happy path, no-home-base → null, non-aircraft resource → null, unknown resourceId →
  null, malformed resourceId → `ValidationError`, provider-throws → best-effort `null` (never
  rejects), capability gate (unauthenticated/forbidden/allowed roles), tenant isolation
  (cross-org id → null + provider never called; each org resolves only its own ICAO).
- `apps/web/.../schedule/new/_components/__tests__/weather-chip.test.ts` — pure display-logic
  mirror tests (same convention as `twilight-indicator.test.ts`): idle/loading/error/empty/
  per-category mapping, no DOM/React rendering.

## Deferred (explicitly NOT built — would cross the determination line, or is simply out of scope)

- **TAF forecasts.** Only the current METAR is fetched; no forward-looking forecast data.
- **Winds aloft.** Not fetched.
- **Weather at destination.** Only the aircraft's configured home base is looked up — no
  route/destination concept exists in scheduling yet.
- **Historical / trend weather.** No time-series, no "conditions over the last N hours."
- **A go/no-go gate.** No write path anywhere consumes this data as a block/allow signal. If a
  future slice ever proposes wiring weather into a gate (e.g. "block dispatch below X ceiling"),
  that is a NEW, separately-specced, compliance-reviewed decision — this slice deliberately does
  not open that door.
- **Caching / a cache table.** Every call is a live fetch. If provider latency or AWC rate
  limits ever become a problem, a short-TTL in-memory (or Redis) cache is a candidate follow-up
  — no DB migration is needed for that (a cache is not a system-of-record table), and any
  future addition should stay display-only just like this slice.
