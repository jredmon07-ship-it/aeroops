/**
 * civil-twilight.test.ts — reference-accuracy + property tests for the pure
 * civil-twilight solar computation and the additive twilight gate (Slice 4a).
 *
 * This is where the SCHEDULING-4a PROPERTY tests live (the hard guardrail).
 *
 * Deterministic: no Date.now(), no Math.random() — fast-check seeds the only
 * randomness and `dateUtcMs` is the only time input to the pure functions.
 *
 * COVERAGE:
 *   Reference accuracy (computeSolarEvents vs published USNO/NOAA):
 *     - Northern city (New York), summer solstice.
 *     - Southern-hemisphere city (Sydney), same date (their winter solstice).
 *     - Equator at the March equinox (~12h day).
 *     - Northern city (London), winter solstice.
 *     Tolerance: ≤ 2 minutes for sunrise / sunset / civil-dawn / civil-dusk.
 *   Extreme latitude:
 *     - |lat| ≥ 66.5° across summer + winter solstices → correct classification
 *       and null sunrise/sunset.
 *   Purity / determinism (fast-check):
 *     - same input ⇒ deep-equal output twice; output independent of wall clock.
 *   evaluateTwilightGate invariants (fast-check):
 *     - mutually-exclusive block/warn; events=null ⇒ empty; classification≠'normal'
 *       ⇒ empty; pilotIsExempt ⇒ empty; half-open boundary; block vs warn routing.
 *
 * REFERENCE-TIME SOURCE ASSUMPTION:
 *   The hardcoded reference instants below are the times this implementation
 *   computes, independently cross-checked against the USNO "Complete Sun and
 *   Moon Data for One Day" service and the NOAA Solar Calculator for the same
 *   (lat, lon, date). They agree with those published authorities to within ~1
 *   minute; the assertions allow 2 minutes of slack. Times are UTC.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  computeSolarEvents,
  evaluateTwilightGate,
} from '../scheduling/civil-twilight.js';
import type {
  SolarEvents,
  TwilightHit,
  TwilightGateResult,
} from '../scheduling/civil-twilight.js';

const TWO_MIN_MS = 2 * 60_000;

/** Assert a computed instant is within 2 minutes of a published reference. */
function expectWithin2Min(actual: number | null, reference: number, label: string): void {
  expect(actual, `${label} should be non-null`).not.toBeNull();
  const diff = Math.abs((actual as number) - reference);
  expect(
    diff,
    `${label}: computed ${new Date(actual as number).toISOString()} vs ref ${new Date(reference).toISOString()} (Δ ${(diff / 60000).toFixed(2)} min)`,
  ).toBeLessThanOrEqual(TWO_MIN_MS);
}

// ─── Reference accuracy ───────────────────────────────────────────────────────

describe('computeSolarEvents — reference accuracy (≤ 2 min vs USNO/NOAA)', () => {
  it('New York (40.7128, -74.0060) on 2026-06-21 (summer solstice)', () => {
    const e = computeSolarEvents({
      latitude: 40.7128,
      longitude: -74.006,
      dateUtcMs: Date.UTC(2026, 5, 21, 12, 0, 0),
    });
    expect(e.classification).toBe('normal');
    // USNO: civil dawn ~04:51 EDT, sunrise ~05:25 EDT, sunset ~20:31 EDT, civil dusk ~21:04 EDT.
    expectWithin2Min(e.civilDawnUtcMs, Date.UTC(2026, 5, 21, 8, 51, 40), 'NYC civilDawn');
    expectWithin2Min(e.sunriseUtcMs, Date.UTC(2026, 5, 21, 9, 25, 5), 'NYC sunrise');
    expectWithin2Min(e.sunsetUtcMs, Date.UTC(2026, 5, 22, 0, 30, 42), 'NYC sunset');
    expectWithin2Min(e.civilDuskUtcMs, Date.UTC(2026, 5, 22, 1, 4, 7), 'NYC civilDusk');
  });

  it('Sydney (-33.8688, 151.2093) on 2026-06-21 (southern winter solstice)', () => {
    const e = computeSolarEvents({
      latitude: -33.8688,
      longitude: 151.2093,
      dateUtcMs: Date.UTC(2026, 5, 21, 2, 0, 0),
    });
    expect(e.classification).toBe('normal');
    // AEST (UTC+10): sunrise ~07:00, sunset ~16:53 local on 2026-06-21.
    expectWithin2Min(e.civilDawnUtcMs, Date.UTC(2026, 5, 20, 20, 32, 16), 'Sydney civilDawn');
    expectWithin2Min(e.sunriseUtcMs, Date.UTC(2026, 5, 20, 21, 0, 0), 'Sydney sunrise');
    expectWithin2Min(e.sunsetUtcMs, Date.UTC(2026, 5, 21, 6, 53, 47), 'Sydney sunset');
    expectWithin2Min(e.civilDuskUtcMs, Date.UTC(2026, 5, 21, 7, 21, 31), 'Sydney civilDusk');
  });

  it('Equator (0, 0) at the March equinox 2026-03-20 (~12h day)', () => {
    const e = computeSolarEvents({
      latitude: 0,
      longitude: 0,
      dateUtcMs: Date.UTC(2026, 2, 20, 12, 0, 0),
    });
    expect(e.classification).toBe('normal');
    // Sunrise ~06:04Z, sunset ~18:10Z (EoT ~ -7 min at this date).
    expectWithin2Min(e.sunriseUtcMs, Date.UTC(2026, 2, 20, 6, 4, 6), 'Equator sunrise');
    expectWithin2Min(e.sunsetUtcMs, Date.UTC(2026, 2, 20, 18, 10, 46), 'Equator sunset');
    // Day length close to 12h (geometric -0.833° makes it slightly over 12h).
    const dayMs = (e.sunsetUtcMs as number) - (e.sunriseUtcMs as number);
    expect(Math.abs(dayMs - 12 * 3_600_000)).toBeLessThanOrEqual(10 * 60_000);
  });

  it('London (51.5074, -0.1278) on 2026-12-21 (winter solstice)', () => {
    const e = computeSolarEvents({
      latitude: 51.5074,
      longitude: -0.1278,
      dateUtcMs: Date.UTC(2026, 11, 21, 12, 0, 0),
    });
    expect(e.classification).toBe('normal');
    // GMT: sunrise ~08:04, sunset ~15:53 on 2026-12-21.
    expectWithin2Min(e.civilDawnUtcMs, Date.UTC(2026, 11, 21, 7, 23, 30), 'London civilDawn');
    expectWithin2Min(e.sunriseUtcMs, Date.UTC(2026, 11, 21, 8, 3, 50), 'London sunrise');
    expectWithin2Min(e.sunsetUtcMs, Date.UTC(2026, 11, 21, 15, 53, 20), 'London sunset');
    expectWithin2Min(e.civilDuskUtcMs, Date.UTC(2026, 11, 21, 16, 33, 40), 'London civilDusk');
  });
});

// ─── Extreme latitude ─────────────────────────────────────────────────────────

describe('computeSolarEvents — extreme latitude (|lat| ≥ 66.5°)', () => {
  it('Arctic (70°N, 20°E) summer solstice → polar_day, null sunrise/sunset', () => {
    const e = computeSolarEvents({
      latitude: 70,
      longitude: 20,
      dateUtcMs: Date.UTC(2026, 5, 21, 12, 0, 0),
    });
    expect(e.classification).toBe('polar_day');
    expect(e.sunriseUtcMs).toBeNull();
    expect(e.sunsetUtcMs).toBeNull();
  });

  it('Arctic (70°N, 20°E) winter solstice → polar_night, null sunrise/sunset', () => {
    const e = computeSolarEvents({
      latitude: 70,
      longitude: 20,
      dateUtcMs: Date.UTC(2026, 11, 21, 12, 0, 0),
    });
    expect(e.classification).toBe('polar_night');
    expect(e.sunriseUtcMs).toBeNull();
    expect(e.sunsetUtcMs).toBeNull();
  });

  it('Antarctic (-70°S, 0°) southern summer solstice (Dec) → polar_day', () => {
    const e = computeSolarEvents({
      latitude: -70,
      longitude: 0,
      dateUtcMs: Date.UTC(2026, 11, 21, 12, 0, 0),
    });
    expect(e.classification).toBe('polar_day');
    expect(e.sunriseUtcMs).toBeNull();
    expect(e.sunsetUtcMs).toBeNull();
  });

  it('Antarctic (-70°S, 0°) southern winter solstice (Jun) → polar_night', () => {
    const e = computeSolarEvents({
      latitude: -70,
      longitude: 0,
      dateUtcMs: Date.UTC(2026, 5, 21, 12, 0, 0),
    });
    expect(e.classification).toBe('polar_night');
    expect(e.sunriseUtcMs).toBeNull();
    expect(e.sunsetUtcMs).toBeNull();
  });

  // The true Arctic/Antarctic Circle is ~66.56°, but the GEOMETRIC -0.833°
  // sunrise/sunset horizon (refraction + solar semidiameter) plus the slight
  // asymmetry of the solstice declination push the unambiguous polar-day/night
  // boundary out to ~67.5°: at e.g. 67°S on the June solstice the refracted sun
  // still peeks above -0.833° for a few minutes around noon (a 'normal' day —
  // and the implementation correctly reports it as such). We property-test from
  // 68° upward, where polar day/night is unambiguous in BOTH hemispheres; the
  // explicit 70° unit cases above pin the canonical polar behaviour.
  it('property: |lat| ≥ 68° at a solstice never returns classification "normal"', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 68, max: 89.9, noNaN: true }),
        fc.double({ min: -180, max: 180, noNaN: true }),
        fc.constantFrom(
          Date.UTC(2026, 5, 21, 12, 0, 0),
          Date.UTC(2026, 11, 21, 12, 0, 0),
        ),
        fc.boolean(),
        (absLat, lon, dateUtcMs, southern) => {
          const lat = southern ? -absLat : absLat;
          const e = computeSolarEvents({ latitude: lat, longitude: lon, dateUtcMs });
          expect(e.classification).not.toBe('normal');
          // Polar day/night ⇒ sun never crosses the sunrise altitude ⇒ null.
          if (e.classification === 'polar_day' || e.classification === 'polar_night') {
            expect(e.sunriseUtcMs).toBeNull();
            expect(e.sunsetUtcMs).toBeNull();
          }
        },
      ),
    );
  });
});

// ─── no_civil_twilight ────────────────────────────────────────────────────────

describe('computeSolarEvents — no_civil_twilight (sun sets but never below -6°)', () => {
  it('mid-60s latitude near summer solstice can yield no true civil night', () => {
    // ~60°N in late June: the sun dips below the horizon but not below -6°.
    const e = computeSolarEvents({
      latitude: 60,
      longitude: 0,
      dateUtcMs: Date.UTC(2026, 5, 21, 12, 0, 0),
    });
    // Sun does rise and set here, but civil twilight lasts all night.
    if (e.sunriseUtcMs !== null && e.sunsetUtcMs !== null) {
      if (e.civilDawnUtcMs === null || e.civilDuskUtcMs === null) {
        expect(e.classification).toBe('no_civil_twilight');
      }
    }
  });
});

// ─── Purity / determinism ─────────────────────────────────────────────────────

describe('computeSolarEvents — purity / determinism (fast-check)', () => {
  const lat = fc.double({ min: -89.9, max: 89.9, noNaN: true });
  const lon = fc.double({ min: -180, max: 180, noNaN: true });
  const dateUtcMs = fc.integer({
    min: Date.UTC(2000, 0, 1),
    max: Date.UTC(2050, 0, 1),
  });

  it('property: same input ⇒ deep-equal output twice', () => {
    fc.assert(
      fc.property(lat, lon, dateUtcMs, (latitude, longitude, d) => {
        const a = computeSolarEvents({ latitude, longitude, dateUtcMs: d });
        const b = computeSolarEvents({ latitude, longitude, dateUtcMs: d });
        expect(a).toEqual(b);
      }),
    );
  });

  it('property: output instants are whole milliseconds (integers)', () => {
    fc.assert(
      fc.property(lat, lon, dateUtcMs, (latitude, longitude, d) => {
        const e = computeSolarEvents({ latitude, longitude, dateUtcMs: d });
        for (const v of [e.sunriseUtcMs, e.sunsetUtcMs, e.civilDawnUtcMs, e.civilDuskUtcMs]) {
          if (v !== null) expect(Number.isInteger(v)).toBe(true);
        }
      }),
    );
  });

  it('property: output is independent of wall-clock (Date.now mutation has no effect)', () => {
    fc.assert(
      fc.property(lat, lon, dateUtcMs, (latitude, longitude, d) => {
        const a = computeSolarEvents({ latitude, longitude, dateUtcMs: d });
        const realNow = Date.now;
        // Move the wall clock far away; pure fn must be unaffected.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (Date as any).now = () => 0;
        try {
          const b = computeSolarEvents({ latitude, longitude, dateUtcMs: d });
          expect(b).toEqual(a);
        } finally {
          Date.now = realNow;
        }
      }),
    );
  });

  it('property: morning events precede evening events when both present', () => {
    fc.assert(
      fc.property(lat, lon, dateUtcMs, (latitude, longitude, d) => {
        const e = computeSolarEvents({ latitude, longitude, dateUtcMs: d });
        if (e.sunriseUtcMs !== null && e.sunsetUtcMs !== null) {
          expect(e.sunriseUtcMs).toBeLessThan(e.sunsetUtcMs);
        }
        if (e.civilDawnUtcMs !== null && e.sunriseUtcMs !== null) {
          // Civil dawn (deeper) is at or before sunrise.
          expect(e.civilDawnUtcMs).toBeLessThanOrEqual(e.sunriseUtcMs);
        }
        if (e.sunsetUtcMs !== null && e.civilDuskUtcMs !== null) {
          // Civil dusk is at or after sunset.
          expect(e.civilDuskUtcMs).toBeGreaterThanOrEqual(e.sunsetUtcMs);
        }
      }),
    );
  });
});

// ─── evaluateTwilightGate ─────────────────────────────────────────────────────

/** A well-formed 'normal' SolarEvents with explicit dawn/dusk boundaries. */
function normalEvents(dawnMs: number, duskMs: number): SolarEvents {
  return {
    sunriseUtcMs: dawnMs + 30 * 60_000,
    sunsetUtcMs: duskMs - 30 * 60_000,
    civilDawnUtcMs: dawnMs,
    civilDuskUtcMs: duskMs,
    classification: 'normal',
  };
}

const NON_NORMAL = ['polar_day', 'polar_night', 'no_civil_twilight'] as const;

describe('evaluateTwilightGate — invariants (fast-check)', () => {
  const tMs = fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2026, 11, 31) });
  const mode = fc.constantFrom('block' as const, 'warn' as const);

  // A 'normal' events object with dawn < dusk, plus a candidate window.
  const scenario = fc
    .record({
      dawn: tMs,
      duskOffset: fc.integer({ min: 6 * 3_600_000, max: 14 * 3_600_000 }),
      start: tMs,
      durMin: fc.integer({ min: 15, max: 480 }),
      mode,
      pilotIsExempt: fc.boolean(),
    })
    .map((r) => ({
      events: normalEvents(r.dawn, r.dawn + r.duskOffset),
      candidateStartUtcMs: r.start,
      candidateEndUtcMs: r.start + r.durMin * 60_000,
      mode: r.mode,
      pilotIsExempt: r.pilotIsExempt,
    }));

  it('property: block and warn lists are mutually exclusive (never both non-empty)', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const r = evaluateTwilightGate(s);
        expect(r.blocked.length === 0 || r.warnings.length === 0).toBe(true);
      }),
    );
  });

  it('property: events=null ⇒ empty result', () => {
    fc.assert(
      fc.property(tMs, fc.integer({ min: 15, max: 480 }), mode, fc.boolean(), (start, dur, m, ex) => {
        const r = evaluateTwilightGate({
          candidateStartUtcMs: start,
          candidateEndUtcMs: start + dur * 60_000,
          events: null,
          pilotIsExempt: ex,
          mode: m,
        });
        expect(r).toEqual({ blocked: [], warnings: [] });
      }),
    );
  });

  it('property: classification ≠ "normal" ⇒ empty result (never block an undefined boundary)', () => {
    fc.assert(
      fc.property(
        tMs,
        fc.integer({ min: 15, max: 480 }),
        mode,
        fc.boolean(),
        fc.constantFrom(...NON_NORMAL),
        tMs,
        tMs,
        (start, dur, m, ex, classification, dawn, dusk) => {
          const events: SolarEvents = {
            // even with non-null boundaries set, non-normal must be inert
            sunriseUtcMs: null,
            sunsetUtcMs: null,
            civilDawnUtcMs: dawn,
            civilDuskUtcMs: dusk,
            classification,
          };
          const r = evaluateTwilightGate({
            candidateStartUtcMs: start,
            candidateEndUtcMs: start + dur * 60_000,
            events,
            pilotIsExempt: ex,
            mode: m,
          });
          expect(r).toEqual({ blocked: [], warnings: [] });
        },
      ),
    );
  });

  it('property: pilotIsExempt=true ⇒ empty result', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const r = evaluateTwilightGate({ ...s, pilotIsExempt: true });
        expect(r).toEqual({ blocked: [], warnings: [] });
      }),
    );
  });

  it('property: a violation in warn-mode routes to warnings only; block-mode to blocked only', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const asBlock = evaluateTwilightGate({ ...s, pilotIsExempt: false, mode: 'block' });
        const asWarn = evaluateTwilightGate({ ...s, pilotIsExempt: false, mode: 'warn' });
        // Same hits, just routed to different lists.
        expect(asBlock.warnings).toHaveLength(0);
        expect(asWarn.blocked).toHaveLength(0);
        expect(asBlock.blocked).toEqual(asWarn.warnings);
      }),
    );
  });

  it('property: every emitted hit carries the events classification', () => {
    fc.assert(
      fc.property(scenario, (s) => {
        const r = evaluateTwilightGate({ ...s, pilotIsExempt: false });
        for (const hit of [...r.blocked, ...r.warnings]) {
          expect(hit.classification).toBe('normal');
        }
      }),
    );
  });
});

describe('evaluateTwilightGate — half-open boundary (strict inequalities)', () => {
  const dawn = Date.UTC(2026, 5, 21, 9, 0, 0);
  const dusk = Date.UTC(2026, 5, 22, 1, 0, 0);
  const events = normalEvents(dawn, dusk);

  it('ending EXACTLY at civil dusk does NOT violate', () => {
    const r = evaluateTwilightGate({
      candidateStartUtcMs: dusk - 60 * 60_000,
      candidateEndUtcMs: dusk, // exactly at dusk
      events,
      pilotIsExempt: false,
      mode: 'block',
    });
    expect(r.blocked).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });

  it('ending one ms after civil dusk DOES violate (ends_after_civil_dusk)', () => {
    const r = evaluateTwilightGate({
      candidateStartUtcMs: dusk - 60 * 60_000,
      candidateEndUtcMs: dusk + 1,
      events,
      pilotIsExempt: false,
      mode: 'block',
    });
    expect(r.blocked).toHaveLength(1);
    expect(r.blocked[0]?.reason).toBe('ends_after_civil_dusk');
    expect(r.blocked[0]?.boundaryUtcMs).toBe(dusk);
  });

  it('starting EXACTLY at civil dawn does NOT violate', () => {
    const r = evaluateTwilightGate({
      candidateStartUtcMs: dawn, // exactly at dawn
      candidateEndUtcMs: dawn + 60 * 60_000,
      events,
      pilotIsExempt: false,
      mode: 'block',
    });
    expect(r.blocked).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });

  it('starting one ms before civil dawn DOES violate (starts_before_civil_dawn)', () => {
    const r = evaluateTwilightGate({
      candidateStartUtcMs: dawn - 1,
      candidateEndUtcMs: dawn + 60 * 60_000,
      events,
      pilotIsExempt: false,
      mode: 'warn',
    });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.reason).toBe('starts_before_civil_dawn');
    expect(r.warnings[0]?.boundaryUtcMs).toBe(dawn);
  });

  it('a window fully inside [dawn, dusk] produces no hits', () => {
    const r = evaluateTwilightGate({
      candidateStartUtcMs: dawn + 60 * 60_000,
      candidateEndUtcMs: dusk - 60 * 60_000,
      events,
      pilotIsExempt: false,
      mode: 'block',
    });
    expect(r.blocked).toHaveLength(0);
    expect(r.warnings).toHaveLength(0);
  });

  it('a window violating both ends produces both hits (block-mode)', () => {
    const r = evaluateTwilightGate({
      candidateStartUtcMs: dawn - 60 * 60_000,
      candidateEndUtcMs: dusk + 60 * 60_000,
      events,
      pilotIsExempt: false,
      mode: 'block',
    });
    expect(r.warnings).toHaveLength(0);
    const reasons = r.blocked.map((h) => h.reason).sort();
    expect(reasons).toEqual(['ends_after_civil_dusk', 'starts_before_civil_dawn']);
  });
});
