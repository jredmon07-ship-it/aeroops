/**
 * scheduling/civil-twilight.ts — pure civil-twilight solar computation + gate.
 *
 * The `@aeroops/core` half of Slice 4a (§4a.2). No I/O, no Drizzle, no React, no
 * clock (`Date.now()`), no randomness, NO timezone library. The only time input
 * is the injected `dateUtcMs`. This computes sunrise / sunset / civil-dawn /
 * civil-dusk UTC instants for a given lat/long/date, and an additive warn/block
 * twilight gate over a candidate booking window — modeled on the grounding gate
 * (ADR-0008) warn/block partition discipline.
 *
 * PURE & DETERMINISTIC: same inputs always produce deep-equal outputs. Safe to
 * call in isolation and property-test for all invariants (the hard guardrail).
 *
 * ─── ALGORITHM (documented) ───────────────────────────────────────────────────
 * NOAA / Meeus "low-precision" closed-form solar position. We compute, for a
 * Julian-day anchored at the LOCAL solar civil day (solar-noon anchored from
 * longitude — NOT raw UTC), the solar declination and the equation of time, then
 * solve the hour-angle for each target geometric solar altitude:
 *   - sunrise / sunset       at h0 = -0.833°  (atmospheric refraction + solar
 *                                              semidiameter; standard astronomy).
 *   - civil dawn / civil dusk at h0 = -6°     (standard civil-twilight definition).
 * The morning crossing of an altitude = dawn/sunrise; the evening crossing =
 * dusk/sunset. Results are whole-millisecond UTC instants.
 *
 * Reference: Meeus, "Astronomical Algorithms" (2nd ed.) ch. 25 (solar position),
 * and the NOAA Solar Calculator spreadsheet (same low-precision formulae). The
 * achieved accuracy vs USNO/NOAA published times is within ~1 minute at mid
 * latitudes (see the reference test suite). [VERIFY-4a-B] -6° / -0.833° are
 * standard astronomy constants, NOT an FAA night-currency / §61.57 / §1.1
 * determination. [VERIFY-4a-A]
 *
 * ─── LOCAL CIVIL DAY ANCHOR ───────────────────────────────────────────────────
 * "The day" for which we report events is the local civil day at the given
 * longitude. We derive it by shifting `dateUtcMs` by the longitude's mean solar
 * offset (longitude/15 hours), taking the calendar date of that shifted instant,
 * and anchoring computation at local solar noon (12:00 local mean time) of that
 * date. This keeps the ±180° / date-boundary behaviour stable (§4a.4).
 *
 * ─── EXTREME LATITUDE ─────────────────────────────────────────────────────────
 * When the sun never reaches a target altitude on the local day (the hour-angle
 * equation has no real solution because |cos H| > 1), that event is `null`:
 *   - sun stays ABOVE -0.833° all day (never sets) → polar_day.
 *   - sun stays BELOW -0.833° all day (never rises) → polar_night.
 *   - sun rises/sets but never drops below -6° (no true night) → no_civil_twilight.
 * The gate is INERT (empty) for any non-'normal' classification — an undefined
 * boundary is NEVER a hard block.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/** Geometric solar altitude for sunrise/sunset (refraction + solar semidiameter). */
const ALT_SUNRISE_SUNSET = -0.833;
/** Geometric solar altitude for civil dawn/dusk. */
const ALT_CIVIL = -6;

/** Unix epoch (1970-01-01T00:00:00Z) as a Julian Day Number. */
const UNIX_EPOCH_JD = 2440587.5;

// ─── Public types ─────────────────────────────────────────────────────────────

export interface SolarEvents {
  sunriseUtcMs: number | null;
  sunsetUtcMs: number | null;
  civilDawnUtcMs: number | null;
  civilDuskUtcMs: number | null;
  classification: 'normal' | 'polar_day' | 'polar_night' | 'no_civil_twilight';
}

export interface TwilightHit {
  reason: 'ends_after_civil_dusk' | 'starts_before_civil_dawn';
  boundaryUtcMs: number;
  classification: SolarEvents['classification'];
}

export interface TwilightGateResult {
  blocked: TwilightHit[];
  warnings: TwilightHit[];
}

// ─── Solar math (Meeus low-precision) ─────────────────────────────────────────

/**
 * Solar declination (deg) and equation of time (minutes) for a given Julian Day
 * (TT ≈ UT at this precision). Meeus ch. 25 low-precision series.
 */
function solarDeclinationAndEoT(jd: number): { declDeg: number; eotMin: number } {
  // Julian centuries since J2000.0
  const t = (jd - 2451545.0) / 36525.0;

  // Geometric mean longitude of the Sun (deg)
  let l0 = 280.46646 + t * (36000.76983 + t * 0.0003032);
  l0 = ((l0 % 360) + 360) % 360;

  // Geometric mean anomaly of the Sun (deg)
  const m = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const mRad = m * DEG;

  // Sun's equation of the center (deg)
  const c =
    (1.914602 - t * (0.004817 + 0.000014 * t)) * Math.sin(mRad) +
    (0.019993 - 0.000101 * t) * Math.sin(2 * mRad) +
    0.000289 * Math.sin(3 * mRad);

  // True longitude of the Sun (deg)
  const trueLong = l0 + c;

  // Apparent longitude of the Sun (deg), corrected for nutation/aberration
  const omega = 125.04 - 1934.136 * t;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * DEG);

  // Mean obliquity of the ecliptic (deg) + correction
  const seconds = 21.448 - t * (46.815 + t * (0.00059 - t * 0.001813));
  const epsilon0 = 23 + (26 + seconds / 60) / 60;
  const epsilon = epsilon0 + 0.00256 * Math.cos(omega * DEG);

  // Solar declination (deg)
  const declDeg =
    Math.asin(Math.sin(epsilon * DEG) * Math.sin(lambda * DEG)) * RAD;

  // Equation of time (minutes) — Meeus eq. 28.3
  const epsHalfTan = Math.tan((epsilon * DEG) / 2);
  const y = epsHalfTan * epsHalfTan;
  const l0Rad = l0 * DEG;
  const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const eotRad =
    y * Math.sin(2 * l0Rad) -
    2 * e * Math.sin(mRad) +
    4 * e * y * Math.sin(mRad) * Math.cos(2 * l0Rad) -
    0.5 * y * y * Math.sin(4 * l0Rad) -
    1.25 * e * e * Math.sin(2 * mRad);
  const eotMin = eotRad * RAD * 4; // radians → degrees → minutes (4 min/deg)

  return { declDeg, eotMin };
}

/**
 * Solve the UTC instant of a target-altitude crossing.
 *
 * @param noonJd     Julian Day at local solar noon of the local civil day.
 * @param latitude   observer latitude (deg).
 * @param longitude  observer longitude (deg, east positive).
 * @param altDeg     target geometric solar altitude (deg).
 * @param morning    true → morning crossing (rise/dawn); false → evening (set/dusk).
 * @returns the UTC ms instant, or null if the sun never reaches `altDeg` that day.
 */
function altitudeCrossingUtcMs(
  noonJd: number,
  latitude: number,
  longitude: number,
  altDeg: number,
  morning: boolean,
): number | null {
  const { declDeg, eotMin } = solarDeclinationAndEoT(noonJd);
  const latRad = latitude * DEG;
  const declRad = declDeg * DEG;

  // Hour angle H where solar altitude == altDeg:
  //   cos(H) = (sin(alt) - sin(lat) sin(decl)) / (cos(lat) cos(decl))
  const cosH =
    (Math.sin(altDeg * DEG) - Math.sin(latRad) * Math.sin(declRad)) /
    (Math.cos(latRad) * Math.cos(declRad));

  // No real crossing → the sun never reaches this altitude this day.
  if (cosH > 1 || cosH < -1) return null;

  const hDeg = Math.acos(cosH) * RAD; // 0..180

  // Solar-noon UTC (minutes from 00:00 UTC):
  //   720 - 4*longitude - eot   (NOAA convention, longitude east-positive)
  const solarNoonMinUtc = 720 - 4 * longitude - eotMin;
  const offsetMin = hDeg * 4; // hour-angle degrees → minutes
  const eventMinUtc = morning
    ? solarNoonMinUtc - offsetMin
    : solarNoonMinUtc + offsetMin;

  // Midnight UTC of the same calendar date as local solar noon.
  const midnightUtcMs = jdToMs(Math.floor(noonJd - 0.5) + 0.5);
  return Math.round(midnightUtcMs + eventMinUtc * MS_PER_MINUTE);
}

// ─── Julian-day <-> ms helpers ────────────────────────────────────────────────

function msToJd(ms: number): number {
  return ms / MS_PER_DAY + UNIX_EPOCH_JD;
}

function jdToMs(jd: number): number {
  return (jd - UNIX_EPOCH_JD) * MS_PER_DAY;
}

// ─── computeSolarEvents ───────────────────────────────────────────────────────

/**
 * Pure NOAA/Meeus low-precision solar-event computation for a single local civil
 * day. See the module header for the algorithm + anchoring + extreme-latitude
 * rules. PURE — `dateUtcMs` is the only time input.
 */
export function computeSolarEvents(input: {
  latitude: number;
  longitude: number;
  dateUtcMs: number;
}): SolarEvents {
  const { latitude, longitude, dateUtcMs } = input;

  // ── Local civil day anchor (solar-noon anchored from longitude). ────────────
  // Shift UTC by the longitude's mean-solar offset, take that calendar date, and
  // anchor at 12:00 local mean time (= solar noon) of that date.
  const localMeanMs = dateUtcMs + (longitude / 15) * 3_600_000;
  const localMidnightUtcMs = Math.floor(localMeanMs / MS_PER_DAY) * MS_PER_DAY;
  // Local solar noon (12:00 local mean) expressed back in UTC ms.
  const localNoonUtcMs = localMidnightUtcMs + 12 * 3_600_000 - (longitude / 15) * 3_600_000;
  const noonJd = msToJd(localNoonUtcMs);

  const sunriseUtcMs = altitudeCrossingUtcMs(noonJd, latitude, longitude, ALT_SUNRISE_SUNSET, true);
  const sunsetUtcMs = altitudeCrossingUtcMs(noonJd, latitude, longitude, ALT_SUNRISE_SUNSET, false);
  const civilDawnUtcMs = altitudeCrossingUtcMs(noonJd, latitude, longitude, ALT_CIVIL, true);
  const civilDuskUtcMs = altitudeCrossingUtcMs(noonJd, latitude, longitude, ALT_CIVIL, false);

  // ── Classification. ─────────────────────────────────────────────────────────
  // To distinguish polar_day vs polar_night when sunrise/sunset are null we
  // evaluate the sun's actual altitude at solar noon: above the horizon ⇒ the
  // sun is up all day (polar_day); below ⇒ down all day (polar_night).
  let classification: SolarEvents['classification'] = 'normal';

  if (sunriseUtcMs === null || sunsetUtcMs === null) {
    const noonAlt = solarAltitudeAtNoon(noonJd, latitude);
    classification = noonAlt > ALT_SUNRISE_SUNSET ? 'polar_day' : 'polar_night';
  } else if (civilDawnUtcMs === null || civilDuskUtcMs === null) {
    // Sun rises and sets, but never drops below -6°: no true civil night.
    classification = 'no_civil_twilight';
  }

  return {
    sunriseUtcMs,
    sunsetUtcMs,
    civilDawnUtcMs,
    civilDuskUtcMs,
    classification,
  };
}

/** Solar altitude (deg) at local solar noon — used only for polar classification. */
function solarAltitudeAtNoon(noonJd: number, latitude: number): number {
  const { declDeg } = solarDeclinationAndEoT(noonJd);
  // At solar noon the hour angle is 0, so altitude = 90 - |lat - decl|.
  return 90 - Math.abs(latitude - declDeg);
}

// ─── evaluateTwilightGate ─────────────────────────────────────────────────────

/**
 * Pure additive twilight gate over a candidate booking window. Modeled on the
 * grounding gate warn/block partition (ADR-0008).
 *
 * Violation (STRICT half-open `[)`):
 *   - candidateEndUtcMs   >  civilDuskUtcMs  → ends_after_civil_dusk
 *   - candidateStartUtcMs <  civilDawnUtcMs  → starts_before_civil_dawn
 * Ending EXACTLY at dusk (or starting exactly at dawn) does NOT violate.
 *
 * INERT (empty `{blocked:[], warnings:[]}`) when:
 *   - events === null                    (no coords / config off → undefined boundary)
 *   - events.classification !== 'normal' (polar/no-civil-twilight → undefined boundary;
 *                                         NEVER hard-block an undefined boundary)
 *   - pilotIsExempt === true             (operator-tagged exemption)
 *
 * mode='block' → violations go to `blocked`, `warnings:[]`.
 * mode='warn'  → violations go to `warnings`, `blocked:[]`.
 * The two lists are always mutually exclusive (a hit is in exactly one).
 */
export function evaluateTwilightGate(input: {
  candidateStartUtcMs: number;
  candidateEndUtcMs: number;
  events: SolarEvents | null;
  pilotIsExempt: boolean;
  mode: 'block' | 'warn';
}): TwilightGateResult {
  const { candidateStartUtcMs, candidateEndUtcMs, events, pilotIsExempt, mode } = input;

  const empty: TwilightGateResult = { blocked: [], warnings: [] };

  // INERT: no boundary, undefined boundary, or exempt pilot.
  if (events === null) return empty;
  if (events.classification !== 'normal') return empty;
  if (pilotIsExempt) return empty;

  const hits: TwilightHit[] = [];

  // Ends after civil dusk (strict). civilDuskUtcMs is non-null for 'normal'.
  if (events.civilDuskUtcMs !== null && candidateEndUtcMs > events.civilDuskUtcMs) {
    hits.push({
      reason: 'ends_after_civil_dusk',
      boundaryUtcMs: events.civilDuskUtcMs,
      classification: events.classification,
    });
  }

  // Starts before civil dawn (strict). civilDawnUtcMs is non-null for 'normal'.
  if (events.civilDawnUtcMs !== null && candidateStartUtcMs < events.civilDawnUtcMs) {
    hits.push({
      reason: 'starts_before_civil_dawn',
      boundaryUtcMs: events.civilDawnUtcMs,
      classification: events.classification,
    });
  }

  if (mode === 'block') {
    return { blocked: hits, warnings: [] };
  }
  return { blocked: [], warnings: hits };
}
