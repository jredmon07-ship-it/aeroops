/**
 * metar.test.ts — property + reference tests for the pure METAR parser and
 * flight-category derivation (Slice W1, weather).
 *
 * Deterministic: no Date.now(), no Math.random() — fast-check seeds the only
 * randomness; `referenceUtcMs` is the only time input and is always injected.
 *
 * COVERAGE:
 *   - deriveFlightCategory: reference thresholds + monotonicity (worsening
 *     ceiling/visibility never improves the category) + both-null → UNKNOWN.
 *   - parseMetarJson: confirmed AWC field shapes (wind/gust/vis/clouds/vertVis/
 *     obsTime/rawOb), malformed-safe (never throws on garbage input).
 *   - parseMetarText: token extraction + a synthetic round-trip property
 *     (build a raw METAR string from random known values, parse it back,
 *     assert the extracted fields match) + malformed-safe.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  deriveFlightCategory,
  parseMetarJson,
  parseMetarText,
} from '../weather/metar.js';
import type { FlightCategory } from '../weather/metar.js';

const RANK: Record<Exclude<FlightCategory, 'UNKNOWN'>, number> = {
  VFR: 0,
  MVFR: 1,
  IFR: 2,
  LIFR: 3,
};

// ─── deriveFlightCategory — reference thresholds ──────────────────────────────

describe('deriveFlightCategory — reference thresholds', () => {
  it('VFR: ceiling > 3000 and vis > 5', () => {
    expect(deriveFlightCategory(3500, 6)).toBe('VFR');
    expect(deriveFlightCategory(null, 10)).toBe('VFR'); // no ceiling reported = unlimited
  });

  it('MVFR: ceiling 1000-3000 OR vis 3-5', () => {
    expect(deriveFlightCategory(2000, 10)).toBe('MVFR'); // ceiling governs
    expect(deriveFlightCategory(null, 4)).toBe('MVFR'); // vis governs
    expect(deriveFlightCategory(3000, 10)).toBe('MVFR'); // boundary inclusive
  });

  it('IFR: ceiling 500-1000 OR vis 1-3', () => {
    expect(deriveFlightCategory(700, 10)).toBe('IFR');
    expect(deriveFlightCategory(null, 2)).toBe('IFR');
  });

  it('LIFR: below IFR', () => {
    expect(deriveFlightCategory(200, 10)).toBe('LIFR');
    expect(deriveFlightCategory(null, 0.5)).toBe('LIFR');
  });

  it('worse of the two dimensions governs', () => {
    // Great ceiling, terrible visibility → LIFR wins.
    expect(deriveFlightCategory(5000, 0.5)).toBe('LIFR');
    // Terrible ceiling, great visibility → LIFR wins.
    expect(deriveFlightCategory(200, 10)).toBe('LIFR');
  });

  it('both unknown → UNKNOWN (never guesses VFR)', () => {
    expect(deriveFlightCategory(null, null)).toBe('UNKNOWN');
  });
});

// ─── deriveFlightCategory — monotonicity (the hard guardrail) ────────────────

describe('deriveFlightCategory — monotonic under worsening inputs (fast-check)', () => {
  it('lowering ceiling (holding vis fixed) never improves the category', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 6000 }),
        fc.integer({ min: 0, max: 6000 }),
        fc.float({ min: 0, max: Math.fround(12), noNaN: true }),
        (a, b, vis) => {
          const [lower, higher] = a <= b ? [a, b] : [b, a];
          const catLower = deriveFlightCategory(lower, vis);
          const catHigher = deriveFlightCategory(higher, vis);
          // catLower is never a BETTER (lower-rank) category than catHigher.
          expect(RANK[catLower as Exclude<FlightCategory, 'UNKNOWN'>]).toBeGreaterThanOrEqual(
            RANK[catHigher as Exclude<FlightCategory, 'UNKNOWN'>],
          );
        },
      ),
    );
  });

  it('lowering visibility (holding ceiling fixed) never improves the category', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: Math.fround(12), noNaN: true }),
        fc.float({ min: 0, max: Math.fround(12), noNaN: true }),
        fc.integer({ min: 0, max: 6000 }),
        (a, b, ceiling) => {
          const [lower, higher] = a <= b ? [a, b] : [b, a];
          const catLower = deriveFlightCategory(ceiling, lower);
          const catHigher = deriveFlightCategory(ceiling, higher);
          expect(RANK[catLower as Exclude<FlightCategory, 'UNKNOWN'>]).toBeGreaterThanOrEqual(
            RANK[catHigher as Exclude<FlightCategory, 'UNKNOWN'>],
          );
        },
      ),
    );
  });
});

// ─── parseMetarJson — confirmed AWC field shapes ──────────────────────────────

describe('parseMetarJson — confirmed AWC /api/data/metar?format=json shapes', () => {
  it('KJFK-like VFR observation', () => {
    const p = parseMetarJson({
      icaoId: 'KJFK',
      obsTime: 1783108260,
      wdir: 200,
      wspd: 14,
      visib: '10+',
      rawOb: 'METAR KJFK 031951Z 20014KT 10SM SCT070 34/22 A2992 RMK SLP131 T03440217 $',
      clouds: [{ cover: 'SCT', base: 7000 }],
      fltCat: 'VFR',
    });
    expect(p.windKt).toBe(14);
    expect(p.gustKt).toBeNull();
    expect(p.visibilitySM).toBe(10); // "10+" simplifies to its numeric floor
    expect(p.ceilingFt).toBeNull(); // SCT is not a ceiling layer
    expect(p.flightCategory).toBe('VFR');
    expect(p.observedAt).toBe(1783108260 * 1000);
    expect(p.rawText).toContain('KJFK');
  });

  it('KACV-like LIFR observation (OVC004 ceiling)', () => {
    const p = parseMetarJson({
      icaoId: 'KACV',
      obsTime: 1783108380,
      wdir: 300,
      wspd: 5,
      visib: '10+',
      rawOb: 'METAR KACV 031953Z AUTO 30005KT 10SM OVC004 13/12 A3006 RMK AO2 SLP184 T01330117',
      clouds: [{ cover: 'OVC', base: 400 }],
      fltCat: 'LIFR',
    });
    expect(p.ceilingFt).toBe(400);
    expect(p.flightCategory).toBe('LIFR');
  });

  it('gust field present (wgst)', () => {
    const p = parseMetarJson({ obsTime: 1, wspd: 13, wgst: 20, visib: 10, clouds: [] });
    expect(p.windKt).toBe(13);
    expect(p.gustKt).toBe(20);
  });

  it('plain numeric visib (e.g. 9)', () => {
    const p = parseMetarJson({ obsTime: 1, wspd: 10, visib: 9, clouds: [] });
    expect(p.visibilitySM).toBe(9);
  });

  it('lowest of multiple BKN/OVC layers wins as ceiling', () => {
    const p = parseMetarJson({
      obsTime: 1,
      wspd: 9,
      visib: '10+',
      clouds: [
        { cover: 'FEW', base: 2000 },
        { cover: 'BKN', base: 3300 },
        { cover: 'BKN', base: 4400 },
      ],
    });
    expect(p.ceilingFt).toBe(3300);
  });

  it('malformed-safe: null / undefined / arbitrary garbage never throws', () => {
    expect(() => parseMetarJson(null)).not.toThrow();
    expect(() => parseMetarJson(undefined)).not.toThrow();
    expect(() => parseMetarJson('not an object')).not.toThrow();
    expect(() => parseMetarJson(42)).not.toThrow();
    expect(() => parseMetarJson([])).not.toThrow();
    expect(() => parseMetarJson({ clouds: 'not-an-array', visib: {}, wspd: 'NaN-ish' })).not.toThrow();
    const p = parseMetarJson({ clouds: 'not-an-array', visib: {}, wspd: 'NaN-ish' });
    expect(p.flightCategory).toBe('UNKNOWN');
    expect(p.ceilingFt).toBeNull();
    expect(p.visibilitySM).toBeNull();
  });

  it('malformed-safe (fast-check): arbitrary JSON-like input never throws', () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        expect(() => parseMetarJson(input)).not.toThrow();
      }),
    );
  });
});

// ─── parseMetarText — token extraction + round-trip property ────────────────

describe('parseMetarText — token extraction', () => {
  it('extracts wind, gust, plain visibility, and ceiling from a synthetic string', () => {
    const raw = 'METAR KBOS 031954Z 29013G20KT 10SM FEW250 37/15 A2982 RMK AO2 SLP097 T03720150 $';
    const p = parseMetarText(raw);
    expect(p.windKt).toBe(13);
    expect(p.gustKt).toBe(20);
    expect(p.visibilitySM).toBe(10);
    expect(p.ceilingFt).toBeNull(); // FEW is not a ceiling layer
    expect(p.rawText).toBe(raw);
  });

  it('extracts a fractional visibility group', () => {
    const p = parseMetarText('METAR KXXX 031954Z 05010KT 1/2SM OVC004 20/18 A2992');
    expect(p.visibilitySM).toBe(0.5);
    expect(p.ceilingFt).toBe(400);
    expect(p.flightCategory).toBe('LIFR');
  });

  it('extracts a mixed-number visibility group ("2" "1/2SM")', () => {
    const p = parseMetarText('METAR KXXX 031954Z 05010KT 2 1/2SM BKN010 20/18 A2992');
    expect(p.visibilitySM).toBe(2.5);
  });

  it('resolves observedAt from the DDHHMMZ group given a reference clock', () => {
    const referenceUtcMs = Date.UTC(2026, 6, 3, 20, 0, 0); // 2026-07-03T20:00:00Z
    const p = parseMetarText('METAR KJFK 031951Z 20014KT 10SM SCT070 34/22 A2992', {
      referenceUtcMs,
    });
    expect(p.observedAt).toBe(Date.UTC(2026, 6, 3, 19, 51, 0));
  });

  it('resolves a month-rollover day/time group to the PRIOR month', () => {
    // reference = July 1st; day-group "30" must resolve to the prior June 30th,
    // not a future "July 30th".
    const referenceUtcMs = Date.UTC(2026, 6, 1, 0, 30, 0); // 2026-07-01T00:30:00Z
    const p = parseMetarText('METAR KXXX 302355Z 05010KT 10SM CLR 20/18 A2992', {
      referenceUtcMs,
    });
    expect(p.observedAt).toBe(Date.UTC(2026, 5, 30, 23, 55, 0));
  });

  it('no reference clock supplied → observedAt is null (never guesses a year)', () => {
    const p = parseMetarText('METAR KJFK 031951Z 20014KT 10SM SCT070 34/22 A2992');
    expect(p.observedAt).toBeNull();
  });

  it('malformed-safe: empty / non-string input never throws', () => {
    expect(() => parseMetarText('')).not.toThrow();
    expect(() => parseMetarText(null)).not.toThrow();
    expect(() => parseMetarText(undefined)).not.toThrow();
    expect(() => parseMetarText(12345)).not.toThrow();
    expect(parseMetarText(null).flightCategory).toBe('UNKNOWN');
  });

  it('malformed-safe (fast-check): arbitrary strings never throw', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => parseMetarText(s)).not.toThrow();
      }),
    );
  });
});

// ─── parseMetarText — synthetic round-trip property ──────────────────────────

/** Cloud cover codes considered a possible ceiling layer by the parser. */
const CEILING_COVERS = ['BKN', 'OVC'] as const;
const NON_CEILING_COVERS = ['FEW', 'SCT'] as const;

/** Build a syntactically-valid single-layer synthetic METAR text from known values. */
function formatSyntheticMetar(input: {
  wind: number;
  gust: number | null;
  visWhole: number; // 0-30 SM, kept as a plain whole-mile group (no fractions) for a clean round trip
  cloudCover: (typeof CEILING_COVERS)[number] | (typeof NON_CEILING_COVERS)[number];
  cloudBaseHundreds: number; // e.g. 50 → 5000 ft
}): string {
  const gustPart = input.gust !== null ? `G${String(input.gust).padStart(2, '0')}` : '';
  const wind = `${String(0).padStart(3, '0')}${String(input.wind).padStart(2, '0')}${gustPart}KT`;
  const vis = `${input.visWhole}SM`;
  const cloud = `${input.cloudCover}${String(input.cloudBaseHundreds).padStart(3, '0')}`;
  return `METAR KTST 031951Z ${wind} ${vis} ${cloud} 20/10 A2992 RMK AO2`;
}

describe('parseMetarText — synthetic round-trip (fast-check)', () => {
  it('extracted wind/gust/visibility/ceiling match the values used to construct the string', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 }), // wind
        fc.option(fc.integer({ min: 0, max: 80 }), { nil: null }), // gust
        fc.integer({ min: 0, max: 30 }), // visWhole
        fc.constantFrom(...CEILING_COVERS, ...NON_CEILING_COVERS),
        fc.integer({ min: 1, max: 250 }), // cloudBaseHundreds
        (wind, gust, visWhole, cloudCover, cloudBaseHundreds) => {
          // Ensure gust, when present, is >= wind speed (a valid METAR gust group).
          const safeGust = gust !== null && gust < wind ? wind + gust : gust;
          const raw = formatSyntheticMetar({
            wind,
            gust: safeGust,
            visWhole,
            cloudCover,
            cloudBaseHundreds,
          });
          const p = parseMetarText(raw);

          expect(p.windKt).toBe(wind);
          expect(p.gustKt).toBe(safeGust);
          expect(p.visibilitySM).toBe(visWhole);

          const expectedCeiling = (CEILING_COVERS as readonly string[]).includes(cloudCover)
            ? cloudBaseHundreds * 100
            : null;
          expect(p.ceilingFt).toBe(expectedCeiling);
          expect(p.rawText).toBe(raw);
        },
      ),
    );
  });
});
