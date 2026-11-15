/**
 * squawk-severity.test.ts — Pure unit tests for the squawk severity chip map
 * (squawk-severity.ts, used by the dashboard's Open squawks card).
 *
 * The bug: the dashboard mapped 'major'/'minor', which are not severities, so
 * 'medium' and 'high' fell through to the neutral chip. The map is now keyed
 * by core's SquawkSeverity (a missing or renamed key fails typecheck); these
 * tests pin the runtime behaviour.
 *
 * COVERAGE:
 *   1. The map covers exactly SQUAWK_SEVERITIES
 *   2. Each severity gets the Squawks list's colors + label; medium and high
 *      are not neutral; all four differ
 *   3. Light and dark: every chip has a light and a dark-mode text color, all
 *      from one palette pattern (grounding in red, not the 4.1:1 danger tint)
 *   4. A value that is not a severity (the old 'major'/'minor') renders as
 *      itself in the neutral colors
 *
 * PURE: no DOM, no Next.js, no DB.
 */

import { describe, it, expect } from 'vitest';
import { SQUAWK_SEVERITIES } from '@aeroops/core';
import { SQUAWK_SEVERITY_CHIP, squawkSeverityChip } from '../squawk-severity';

describe('1. the map is keyed by the real severities', () => {
  it('has exactly the SQUAWK_SEVERITIES keys', () => {
    expect(Object.keys(SQUAWK_SEVERITY_CHIP).sort()).toEqual([...SQUAWK_SEVERITIES].sort());
  });
});

describe('2. each severity gets its own chip', () => {
  it('labels', () => {
    expect(squawkSeverityChip('low').label).toBe('Low');
    expect(squawkSeverityChip('medium').label).toBe('Medium');
    expect(squawkSeverityChip('high').label).toBe('High');
    expect(squawkSeverityChip('grounding').label).toBe('Grounding');
  });

  it('colors: low slate, medium amber, high orange, grounding red', () => {
    expect(squawkSeverityChip('low').className).toContain('text-slate-600');
    expect(squawkSeverityChip('medium').className).toContain('text-amber-800');
    expect(squawkSeverityChip('high').className).toContain('text-orange-800');
    expect(squawkSeverityChip('grounding').className).toContain('text-red-800');
  });

  it('medium and high are not the neutral chip (the bug)', () => {
    const neutral = squawkSeverityChip('low').className;
    expect(squawkSeverityChip('medium').className).not.toBe(neutral);
    expect(squawkSeverityChip('high').className).not.toBe(neutral);
  });

  it('all four chips differ', () => {
    const classNames = SQUAWK_SEVERITIES.map((s) => squawkSeverityChip(s).className);
    expect(new Set(classNames).size).toBe(SQUAWK_SEVERITIES.length);
  });

  it('every chip has the same instrument-chip shape', () => {
    for (const s of SQUAWK_SEVERITIES) {
      expect(squawkSeverityChip(s).className, s).toMatch(
        /^inline-flex items-center rounded-sm border px-1\.5 py-0\.5 text-\[0\.6875rem\] font-semibold leading-4 /,
      );
    }
  });
});

describe('3. light and dark', () => {
  it('every chip sets border, background and text for light and for dark', () => {
    // \w, not a bracketed class: Tailwind scans this file and would emit a
    // junk arbitrary-value rule for a utility name followed by "-[".
    for (const s of SQUAWK_SEVERITIES) {
      const cls = SQUAWK_SEVERITY_CHIP[s].cls;
      for (const part of [
        /(^| )border-\w+-\d{3}( |$)/,
        /(^| )dark:border-\w+-\d{3}(\/\d+)?( |$)/,
        /(^| )bg-\w+-\d{2,3}( |$)/,
        /(^| )dark:bg-\w+-\d{3}(\/\d+)?( |$)/,
        /(^| )text-\w+-\d{3}( |$)/,
        /(^| )dark:text-\w+-\d{3}( |$)/,
      ]) {
        expect(cls, `${s}: ${part}`).toMatch(part);
      }
    }
  });

  it('grounding uses the red palette (its dark text is red-200), not a token-tinted chip', () => {
    expect(SQUAWK_SEVERITY_CHIP.grounding.cls).toBe(
      'border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/40 text-red-800 dark:text-red-200',
    );
  });
});

describe('4. a value that is not a severity', () => {
  it("the old 'major'/'minor' keys render as themselves in the neutral colors", () => {
    const neutral = squawkSeverityChip('low').className;
    expect(squawkSeverityChip('major')).toEqual({ label: 'major', className: neutral });
    expect(squawkSeverityChip('minor')).toEqual({ label: 'minor', className: neutral });
  });

  it('prototype keys are not severities', () => {
    expect(squawkSeverityChip('constructor').className).toBe(squawkSeverityChip('low').className);
  });
});
