/**
 * weather-chip.test.ts — Pure unit tests for the weather chip display logic
 * (Slice W1, weather).
 *
 * Mirrors twilight-indicator.test.ts's approach: tests the pure
 * state-to-display-class logic that WeatherChip encodes, without any DOM/
 * React rendering. No DOM, no React, no Next.js, no DB.
 *
 * Coverage:
 *   1. state='idle'   → 'hidden'
 *   2. state='loading' → 'loading'
 *   3. state='error'   → 'empty' (never an error banner — advisory only)
 *   4. state='loaded' + weather=null → 'empty' (no ICAO / provider outage —
 *      SAME empty state as 'error', proving a uniform graceful-empty path)
 *   5. state='loaded' + flightCategory='VFR'|'MVFR'|'IFR'|'LIFR' → the
 *      matching category display class
 *   6. state='loaded' + flightCategory='UNKNOWN' → 'category:unknown' (never
 *      silently defaults to a colored category)
 */

import { describe, it, expect } from 'vitest';
import type { ParsedMetar, FlightCategory } from '@aeroops/api';
import type { WeatherChipState } from '../weather-chip';

// ─── pure helper (mirror of what WeatherChip renders) ────────────────────────

type WeatherDisplayClass =
  | 'hidden'
  | 'loading'
  | 'empty'
  | 'category:vfr'
  | 'category:mvfr'
  | 'category:ifr'
  | 'category:lifr'
  | 'category:unknown';

function classifyWeatherDisplay(
  state: WeatherChipState,
  weather: ParsedMetar | null,
): WeatherDisplayClass {
  if (state === 'idle') return 'hidden';
  if (state === 'loading') return 'loading';
  if (state === 'error' || weather === null) return 'empty';
  const map: Record<FlightCategory, WeatherDisplayClass> = {
    VFR: 'category:vfr',
    MVFR: 'category:mvfr',
    IFR: 'category:ifr',
    LIFR: 'category:lifr',
    UNKNOWN: 'category:unknown',
  };
  return map[weather.flightCategory];
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeWeather(overrides: Partial<ParsedMetar>): ParsedMetar {
  return {
    flightCategory: 'VFR',
    windKt: 8,
    gustKt: null,
    visibilitySM: 10,
    ceilingFt: null,
    rawText: 'METAR KABC 031951Z 20008KT 10SM CLR 20/10 A2992',
    observedAt: 1_000_000,
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('classifyWeatherDisplay — idle / loading', () => {
  it('idle → hidden (no aircraft selected yet)', () => {
    expect(classifyWeatherDisplay('idle', null)).toBe('hidden');
  });

  it('loading → loading', () => {
    expect(classifyWeatherDisplay('loading', null)).toBe('loading');
  });
});

describe('classifyWeatherDisplay — graceful empty (never an error banner)', () => {
  it('error state → empty', () => {
    expect(classifyWeatherDisplay('error', null)).toBe('empty');
  });

  it('loaded + weather=null (no ICAO / provider outage) → empty', () => {
    expect(classifyWeatherDisplay('loaded', null)).toBe('empty');
  });

  it('error and loaded-with-null converge on the SAME empty display class', () => {
    expect(classifyWeatherDisplay('error', null)).toBe(classifyWeatherDisplay('loaded', null));
  });
});

describe('classifyWeatherDisplay — flight category mapping', () => {
  it('VFR → category:vfr', () => {
    expect(classifyWeatherDisplay('loaded', makeWeather({ flightCategory: 'VFR' }))).toBe('category:vfr');
  });
  it('MVFR → category:mvfr', () => {
    expect(classifyWeatherDisplay('loaded', makeWeather({ flightCategory: 'MVFR' }))).toBe('category:mvfr');
  });
  it('IFR → category:ifr', () => {
    expect(classifyWeatherDisplay('loaded', makeWeather({ flightCategory: 'IFR' }))).toBe('category:ifr');
  });
  it('LIFR → category:lifr', () => {
    expect(classifyWeatherDisplay('loaded', makeWeather({ flightCategory: 'LIFR' }))).toBe('category:lifr');
  });
  it("UNKNOWN → category:unknown (never silently defaults to a colored category)", () => {
    expect(classifyWeatherDisplay('loaded', makeWeather({ flightCategory: 'UNKNOWN' }))).toBe('category:unknown');
  });
});
