/**
 * weather/metar.ts — pure METAR parsing + flight-category derivation (Slice W1).
 *
 * The `@aeroops/core` half of the METAR weather slice. NO I/O, no fetch, no
 * `Date.now()`, no randomness — mirrors the civil-twilight module's purity
 * discipline (scheduling/civil-twilight.ts). The only "clock" input is an
 * OPTIONAL injected `referenceUtcMs`, used solely to resolve a raw METAR
 * text's `DDHHMMZ` day/time group (which carries no year/month) into a full
 * UTC instant. The AWC JSON path never needs it — `obsTime` is already a
 * full unix timestamp.
 *
 * ── COMPLIANCE — DISPLAY-ONLY, INFORMATIONAL ──────────────────────────────────
 * flightCategory / ceiling / visibility / wind here are ADVISORY weather data
 * for situational awareness ONLY. This is NEVER a go/no-go, airworthiness, or
 * dispatch determination — the pilot in command makes that call, always. This
 * module must NEVER be wired into a gate/block write path (mirrors the
 * civil-twilight / grounding gate posture: computed data can WARN, never
 * silently decide). [VERIFY-W1-A] — see docs/specs/slice-weather-metar.md.
 *
 * ── NEVER THROWS ───────────────────────────────────────────────────────────────
 * Any malformed / unexpected / partial input degrades gracefully: unresolved
 * fields fall back to `null`, and `flightCategory` falls back to `'UNKNOWN'`
 * only when NOTHING could be determined. This mirrors evaluateTwilightGate /
 * evaluateGroundingGate's "an undefined boundary is never a hard failure"
 * discipline — parsing bad weather data must never crash the caller.
 *
 * ── FLIGHT CATEGORY THRESHOLDS (standard AWC/FAA definitions) ─────────────────
 *   VFR    ceiling > 3000 ft  AND  visibility > 5 sm
 *   MVFR   ceiling 1000–3000 ft  OR  visibility 3–5 sm
 *   IFR    ceiling 500–1000 ft   OR  visibility 1–3 sm
 *   LIFR   below IFR (ceiling < 500 ft  OR  visibility < 1 sm)
 * Either dimension alone can restrict the category — the WORSE of the
 * ceiling-implied and visibility-implied category governs. No reported
 * ceiling (no BKN/OVC/OVX layer) is treated as unlimited (VFR-tier) for that
 * dimension; a wholly-unknown METAR (neither ceiling nor visibility could be
 * read) reports 'UNKNOWN' rather than guessing VFR.
 */

// ─── Public types ─────────────────────────────────────────────────────────────

export type FlightCategory = 'VFR' | 'MVFR' | 'IFR' | 'LIFR' | 'UNKNOWN';

export interface ParsedMetar {
  flightCategory: FlightCategory;
  windKt: number | null;
  gustKt: number | null;
  visibilitySM: number | null;
  ceilingFt: number | null;
  rawText: string | null;
  /** Observation time, epoch ms — null when it could not be resolved. */
  observedAt: number | null;
}

/** Options for parseMetarText's injected-clock day/time resolution (never Date.now() internally). */
export interface ParseMetarOptions {
  referenceUtcMs?: number;
}

// ─── Flight-category derivation (pure) ────────────────────────────────────────

const CATEGORY_RANK: Record<Exclude<FlightCategory, 'UNKNOWN'>, number> = {
  VFR: 0,
  MVFR: 1,
  IFR: 2,
  LIFR: 3,
};

/** Category implied by ceiling alone. null = no reported ceiling (unlimited) → VFR-tier. */
function categoryFromCeiling(ceilingFt: number | null): Exclude<FlightCategory, 'UNKNOWN'> {
  if (ceilingFt === null) return 'VFR';
  if (ceilingFt < 500) return 'LIFR';
  if (ceilingFt < 1000) return 'IFR';
  if (ceilingFt <= 3000) return 'MVFR';
  return 'VFR';
}

/** Category implied by visibility alone. null = not reported → VFR-tier (does not itself restrict). */
function categoryFromVisibility(visibilitySM: number | null): Exclude<FlightCategory, 'UNKNOWN'> {
  if (visibilitySM === null) return 'VFR';
  if (visibilitySM < 1) return 'LIFR';
  if (visibilitySM < 3) return 'IFR';
  if (visibilitySM <= 5) return 'MVFR';
  return 'VFR';
}

/**
 * deriveFlightCategory — standard AWC/FAA flight-category thresholds (see file
 * header). The WORSE of the ceiling-implied and visibility-implied category
 * governs. Both null (nothing known) → 'UNKNOWN'. PURE, never throws.
 *
 * Monotonic: worsening either input (lower ceiling, lower visibility) never
 * IMPROVES the resulting category (property-tested).
 */
export function deriveFlightCategory(
  ceilingFt: number | null,
  visibilitySM: number | null,
): FlightCategory {
  if (ceilingFt === null && visibilitySM === null) return 'UNKNOWN';
  const byCeiling = categoryFromCeiling(ceilingFt);
  const byVis = categoryFromVisibility(visibilitySM);
  return CATEGORY_RANK[byCeiling] >= CATEGORY_RANK[byVis] ? byCeiling : byVis;
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

interface CloudLayer {
  cover: string;
  base: number | null;
}

/** Ceiling = lowest BKN/OVC/OVX (obscured) layer base, or vertical visibility if present and lower. null = no ceiling reported. */
function ceilingFromClouds(clouds: CloudLayer[], vertVisFt: number | null): number | null {
  const CEILING_COVERS = new Set(['BKN', 'OVC', 'OVX']);
  let ceiling: number | null = vertVisFt !== null && Number.isFinite(vertVisFt) ? vertVisFt : null;
  for (const c of clouds) {
    if (CEILING_COVERS.has(c.cover) && typeof c.base === 'number' && Number.isFinite(c.base)) {
      if (ceiling === null || c.base < ceiling) ceiling = c.base;
    }
  }
  return ceiling;
}

function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function emptyParsedMetar(rawText: string | null): ParsedMetar {
  return {
    flightCategory: 'UNKNOWN',
    windKt: null,
    gustKt: null,
    visibilitySM: null,
    ceilingFt: null,
    rawText,
    observedAt: null,
  };
}

// ─── AWC JSON path (primary — used by the real provider) ─────────────────────

function parseFractionToken(tok: string): number | null {
  const m = /^M?(\d+)\/(\d+)$/.exec(tok);
  if (!m) return null;
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (den === 0) return null;
  return num / den;
}

/** Parses AWC's `visib` field: a plain number, a fraction string ("1/2", "M1/4"), a mixed number ("2 1/2"), or the "10+"/"6+" greater-than marker (reported as its numeric floor — a documented simplification; either way it is comfortably VFR-tier). */
function parseVisibilityToken(raw: string): number | null {
  const trimmed = raw.trim().replace(/SM$/i, '').trim();
  if (trimmed === '') return null;

  const plusMatch = /^(\d+(?:\.\d+)?)\+$/.exec(trimmed);
  if (plusMatch) return Number(plusMatch[1]);

  const parts = trimmed.split(/\s+/);
  if (parts.length === 2) {
    const whole = toFiniteNumber(parts[0]);
    const frac = parseFractionToken(parts[1]!);
    if (whole !== null && frac !== null) return whole + frac;
    return null;
  }

  const fracOnly = parseFractionToken(trimmed);
  if (fracOnly !== null) return fracOnly;

  return toFiniteNumber(trimmed);
}

function parseVisibilityField(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') return parseVisibilityToken(v);
  return null;
}

function parseCloudsField(v: unknown): CloudLayer[] {
  if (!Array.isArray(v)) return [];
  const out: CloudLayer[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    const cover = typeof item['cover'] === 'string' ? item['cover'] : '';
    out.push({ cover, base: toFiniteNumber(item['base']) });
  }
  return out;
}

/**
 * parseMetarJson — parse a single AWC `/api/data/metar?format=json` array
 * element (see docs/specs/slice-weather-metar.md for the confirmed field
 * shape). Accepts `unknown` and NEVER throws — any missing/malformed field
 * degrades to `null` for that field only.
 */
export function parseMetarJson(json: unknown): ParsedMetar {
  if (!isRecord(json)) return emptyParsedMetar(null);

  const rawText = typeof json['rawOb'] === 'string' ? json['rawOb'] : null;
  const obsTimeRaw = json['obsTime'];
  const observedAt =
    typeof obsTimeRaw === 'number' && Number.isFinite(obsTimeRaw) ? obsTimeRaw * 1000 : null;

  const windKt = toFiniteNumber(json['wspd']);
  const gustKt = toFiniteNumber(json['wgst']);
  const visibilitySM = parseVisibilityField(json['visib']);
  const vertVisFt = toFiniteNumber(json['vertVis']);
  const clouds = parseCloudsField(json['clouds']);
  const ceilingFt = ceilingFromClouds(clouds, vertVisFt);
  const flightCategory = deriveFlightCategory(ceilingFt, visibilitySM);

  return { flightCategory, windKt, gustKt, visibilitySM, ceilingFt, rawText, observedAt };
}

// ─── Raw METAR text path (defensive fallback — used for round-trip testing) ──

const WIND_RE = /^(\d{3}|VRB)(\d{2,3})(G(\d{2,3}))?KT$/;
const DAYTIME_RE = /^(\d{2})(\d{2})(\d{2})Z$/;
const CLOUD_RE = /^(FEW|SCT|BKN|OVC)(\d{3})$/;
const VV_RE = /^VV(\d{3}|\/\/\/)$/;
const VIS_FRAC_RE = /^M?(\d+)\/(\d+)SM$/;
const VIS_PLAIN_RE = /^(\d+(?:\.\d+)?)SM$/;
const BARE_INT_RE = /^\d+$/;

/**
 * resolveObservedAt — resolve a raw METAR's day/hour/minute-only group into a
 * full UTC instant, anchored near `referenceUtcMs` (the only clock input;
 * caller supplies it — this function never reads the wall clock itself).
 * Walks back up to 2 calendar months to find the closest occurrence that is
 * not more than 6h in the future of the reference (handles month rollover,
 * e.g. reference=Jul 1, day=30 → resolves to the prior June 30, not July 30).
 * Returns null when no reference is supplied, or the group is out of range.
 */
function resolveObservedAt(
  day: number,
  hour: number,
  minute: number,
  referenceUtcMs: number | undefined,
): number | null {
  if (referenceUtcMs === undefined || !Number.isFinite(referenceUtcMs)) return null;
  if (day < 1 || day > 31 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  const ref = new Date(referenceUtcMs);
  let candidate = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), day, hour, minute, 0);

  for (let back = 0; back < 3; back++) {
    if (candidate <= referenceUtcMs + SIX_HOURS_MS) return candidate;
    const d = new Date(candidate);
    candidate = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, day, hour, minute, 0);
  }
  return candidate;
}

/**
 * parseMetarText — best-effort tokenizer over a raw METAR text string.
 * Defensive fallback: the real provider always prefers parseMetarJson (the
 * AWC JSON already carries every field structured); this exists so the
 * `rawText`/round-trip shape is independently testable and so a future
 * text-only source degrades usefully rather than not at all. Partial /
 * unrecognized coverage (e.g. non-US meter-based visibility groups) is
 * expected and safe — unmatched fields simply stay `null`.
 *
 * NEVER THROWS. Accepts `unknown` for the same malformed-safe reason as
 * parseMetarJson.
 */
export function parseMetarText(rawText: unknown, opts?: ParseMetarOptions): ParsedMetar {
  if (typeof rawText !== 'string' || rawText.trim() === '') {
    return emptyParsedMetar(typeof rawText === 'string' ? rawText : null);
  }

  const tokens = rawText.trim().split(/\s+/);

  let windKt: number | null = null;
  let gustKt: number | null = null;
  let visibilitySM: number | null = null;
  let vertVisFt: number | null = null;
  let observedAt: number | null = null;
  const clouds: CloudLayer[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;

    const windMatch = WIND_RE.exec(tok);
    if (windMatch) {
      windKt = toFiniteNumber(windMatch[2]);
      gustKt = windMatch[4] ? toFiniteNumber(windMatch[4]) : null;
      continue;
    }

    if (observedAt === null) {
      const dayTimeMatch = DAYTIME_RE.exec(tok);
      if (dayTimeMatch) {
        observedAt = resolveObservedAt(
          Number(dayTimeMatch[1]),
          Number(dayTimeMatch[2]),
          Number(dayTimeMatch[3]),
          opts?.referenceUtcMs,
        );
        continue;
      }
    }

    const cloudMatch = CLOUD_RE.exec(tok);
    if (cloudMatch) {
      clouds.push({ cover: cloudMatch[1]!, base: Number(cloudMatch[2]) * 100 });
      continue;
    }

    const vvMatch = VV_RE.exec(tok);
    if (vvMatch && vvMatch[1] !== '///') {
      vertVisFt = Number(vvMatch[1]) * 100;
      continue;
    }

    if (visibilitySM === null) {
      const fracMatch = VIS_FRAC_RE.exec(tok);
      if (fracMatch) {
        // Mixed number, e.g. "2" "1/2SM" — fold in a preceding bare-integer token.
        const prev = i > 0 ? tokens[i - 1] : null;
        const whole = prev && BARE_INT_RE.test(prev) ? Number(prev) : 0;
        visibilitySM = whole + Number(fracMatch[1]) / Number(fracMatch[2]);
        continue;
      }
      const plainMatch = VIS_PLAIN_RE.exec(tok);
      if (plainMatch) {
        visibilitySM = Number(plainMatch[1]);
        continue;
      }
    }
  }

  const ceilingFt = ceilingFromClouds(clouds, vertVisFt);
  const flightCategory = deriveFlightCategory(ceilingFt, visibilitySM);

  return { flightCategory, windKt, gustKt, visibilitySM, ceilingFt, rawText, observedAt };
}
