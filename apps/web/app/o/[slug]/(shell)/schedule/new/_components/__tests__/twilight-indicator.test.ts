/**
 * twilight-indicator.test.ts — Pure unit tests for the twilight indicator
 * display logic (Slice 4a, §4a.3).
 *
 * Tests the pure classification-to-copy logic that TwilightIndicator encodes.
 * No DOM, no React, no Next.js, no DB.
 *
 * Coverage:
 *   1. normal + wouldViolate=false → 'within_daylight'
 *   2. normal + wouldViolate=true  → 'violation'
 *   3. events=null + classification=null → 'no_coords'
 *   4. polar_day  → 'polar_day'
 *   5. polar_night → 'polar_night'
 *   6. no_civil_twilight → 'no_civil_twilight'
 *   7. non-normal classification → never 'violation' (gate inert invariant)
 *   8. events=null → 'no_coords' (not violation)
 */

import { describe, it, expect } from 'vitest';
import type { PreviewTwilightResourceReport } from '@aeroops/api';
import type { SolarEvents } from '@aeroops/core';

// ─── pure helper (mirror of what TwilightIndicator renders) ─────────────────

type TwilightDisplayClass =
  | 'no_coords'
  | 'polar_day'
  | 'polar_night'
  | 'no_civil_twilight'
  | 'violation'
  | 'within_daylight';

function classifyReport(report: PreviewTwilightResourceReport): TwilightDisplayClass {
  const { events, wouldViolate, classification } = report;
  if (!events && classification === null) return 'no_coords';
  if (classification && classification !== 'normal') {
    return classification as TwilightDisplayClass;
  }
  if (wouldViolate) return 'violation';
  return 'within_daylight';
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeNormalEvents(): SolarEvents {
  return {
    sunriseUtcMs: 1_000_000,
    sunsetUtcMs: 2_000_000,
    civilDawnUtcMs: 900_000,
    civilDuskUtcMs: 2_100_000,
    classification: 'normal',
  };
}

function makeReport(
  overrides: Partial<PreviewTwilightResourceReport>,
): PreviewTwilightResourceReport {
  return {
    resourceId: 'resource-id-1',
    events: null,
    wouldViolate: false,
    classification: null,
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Tests
// ═════════════════════════════════════════════════════════════════════════════

describe('classifyReport — normal + within daylight', () => {
  it('normal events + wouldViolate=false → within_daylight', () => {
    const r = makeReport({ events: makeNormalEvents(), classification: 'normal', wouldViolate: false });
    expect(classifyReport(r)).toBe('within_daylight');
  });
});

describe('classifyReport — normal + violation', () => {
  it('normal events + wouldViolate=true → violation', () => {
    const r = makeReport({ events: makeNormalEvents(), classification: 'normal', wouldViolate: true });
    expect(classifyReport(r)).toBe('violation');
  });
});

describe('classifyReport — no coords', () => {
  it('events=null + classification=null → no_coords', () => {
    const r = makeReport({ events: null, classification: null, wouldViolate: false });
    expect(classifyReport(r)).toBe('no_coords');
  });
});

describe('classifyReport — polar_day', () => {
  it('polar_day → polar_day', () => {
    const r = makeReport({ events: null, classification: 'polar_day', wouldViolate: false });
    expect(classifyReport(r)).toBe('polar_day');
  });

  it('polar_day with wouldViolate=true (impossible in practice) → classification wins, not violation', () => {
    const r = makeReport({ events: null, classification: 'polar_day', wouldViolate: true });
    expect(classifyReport(r)).toBe('polar_day');
    expect(classifyReport(r)).not.toBe('violation');
  });
});

describe('classifyReport — polar_night', () => {
  it('polar_night → polar_night', () => {
    const r = makeReport({ events: null, classification: 'polar_night', wouldViolate: false });
    expect(classifyReport(r)).toBe('polar_night');
  });
});

describe('classifyReport — no_civil_twilight', () => {
  it('no_civil_twilight → no_civil_twilight', () => {
    const r = makeReport({ events: null, classification: 'no_civil_twilight', wouldViolate: false });
    expect(classifyReport(r)).toBe('no_civil_twilight');
  });
});

describe('classifyReport — gate inert for non-normal (invariant)', () => {
  const nonNormal: Array<SolarEvents['classification']> = ['polar_day', 'polar_night', 'no_civil_twilight'];
  for (const cls of nonNormal) {
    it(`${cls} never maps to 'violation' even with wouldViolate=true`, () => {
      const r = makeReport({ events: null, classification: cls, wouldViolate: true });
      expect(classifyReport(r)).not.toBe('violation');
    });
  }
});

describe('classifyReport — events=null boundary', () => {
  it('events=null + classification=null → no_coords (not violation)', () => {
    const r = makeReport({ events: null, classification: null, wouldViolate: false });
    const result = classifyReport(r);
    expect(result).toBe('no_coords');
    expect(result).not.toBe('violation');
  });
});
