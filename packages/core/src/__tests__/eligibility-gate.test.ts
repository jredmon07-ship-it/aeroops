/**
 * eligibility-gate.test.ts — unit + property tests for the pure eligibility gate.
 *
 * This is where the DISPATCH-3c eligibility gate PROPERTY tests live (ADR-0009
 * §5, the hard guardrail). The pure fn decides whether a pilot is eligible
 * based solely on free-text tag membership.
 *
 * Deterministic: no Date.now(), no Math.random() — fast-check seeds the only
 * randomness and generators are constrained to produce well-formed inputs.
 *
 * [VERIFY-3c-A] These tests confirm that the gate is a pure string set-membership
 * test — NO FAA currency/medical/flight-review/Part-61/141/endorsement logic.
 *
 * COVERAGE:
 *   Property (fast-check), per spec §5 E1–E7:
 *     E1  empty requiredTags → always satisfied/no-gate (any pilotTags/mode)
 *     E2  missingTags = exact set-difference, deduped, order from requiredTags,
 *         never contains a tag already held by the pilot
 *     E3  satisfied ⟺ missingTags.length === 0
 *     E4  mode partition: block → blocked=!satisfied & warnings=[];
 *                         warn  → blocked=false & warnings=missingTags; never both
 *     E5  superset: pilotTags ⊇ requiredTags → satisfied for any mode
 *     E6  case-sensitivity: a case-differing pilot tag does NOT satisfy
 *     E7  purity: same inputs → deep-equal output twice; inputs not mutated
 *   Unit:
 *     - empty requiredTags
 *     - all tags missing (no pilot tags)
 *     - mixed (some held, some missing)
 *     - duplicate required tags (deduped in missingTags)
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { evaluateEligibilityGate } from '../dispatch-gate/eligibility-gate.js';

// ─── Generators ──────────────────────────────────────────────────────────────

/** A non-empty tag string (printable ASCII to avoid collation edge cases). */
const tagString = fc.string({ minLength: 1, maxLength: 40 });

/** An array of tag strings (may be empty, may have duplicates). */
const tagArray = fc.array(tagString, { minLength: 0, maxLength: 15 });

/** A non-empty array of tag strings. */
const nonEmptyTagArray = fc.array(tagString, { minLength: 1, maxLength: 10 });

/** Mode: 'block' or 'warn'. */
const mode = fc.oneof(fc.constant('block' as const), fc.constant('warn' as const));

// ─── Helper ───────────────────────────────────────────────────────────────────

/** Compute the expected set-difference in spec-order. */
function expectedMissingTags(requiredTags: string[], pilotTags: string[]): string[] {
  const pilotSet = new Set(pilotTags);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of requiredTags) {
    if (!pilotSet.has(tag) && !seen.has(tag)) {
      result.push(tag);
      seen.add(tag);
    }
  }
  return result;
}

// ─── E1: Empty requiredTags → no gate ────────────────────────────────────────

describe('E1: empty requiredTags → always satisfied, no gate, for any pilotTags/mode', () => {
  it('property: empty requiredTags → satisfied=true, missingTags=[], blocked=false, warnings=[]', () => {
    fc.assert(
      fc.property(tagArray, mode, (pilotTags, m) => {
        const result = evaluateEligibilityGate([], pilotTags, m);
        expect(result.satisfied).toBe(true);
        expect(result.missingTags).toEqual([]);
        expect(result.blocked).toBe(false);
        expect(result.warnings).toEqual([]);
      }),
    );
  });
});

// ─── E2: missingTags = exact set-difference ───────────────────────────────────

describe('E2: missingTags = exact set-difference, deduped, order from requiredTags, never a held tag', () => {
  it('property: missingTags equals expected set-difference for any inputs', () => {
    fc.assert(
      fc.property(tagArray, tagArray, mode, (requiredTags, pilotTags, m) => {
        const result = evaluateEligibilityGate(requiredTags, pilotTags, m);
        const expected = expectedMissingTags(requiredTags, pilotTags);
        expect(result.missingTags).toEqual(expected);
      }),
    );
  });

  it('property: no tag in missingTags is also in pilotTags (case-sensitive)', () => {
    fc.assert(
      fc.property(tagArray, tagArray, mode, (requiredTags, pilotTags, m) => {
        const result = evaluateEligibilityGate(requiredTags, pilotTags, m);
        const pilotSet = new Set(pilotTags);
        for (const tag of result.missingTags) {
          expect(pilotSet.has(tag)).toBe(false);
        }
      }),
    );
  });

  it('property: missingTags contains no duplicates', () => {
    fc.assert(
      fc.property(tagArray, tagArray, mode, (requiredTags, pilotTags, m) => {
        const result = evaluateEligibilityGate(requiredTags, pilotTags, m);
        const seen = new Set<string>();
        for (const tag of result.missingTags) {
          expect(seen.has(tag)).toBe(false);
          seen.add(tag);
        }
      }),
    );
  });

  it('property: each tag in missingTags is also in requiredTags (subset)', () => {
    fc.assert(
      fc.property(tagArray, tagArray, mode, (requiredTags, pilotTags, m) => {
        const result = evaluateEligibilityGate(requiredTags, pilotTags, m);
        const requiredSet = new Set(requiredTags);
        for (const tag of result.missingTags) {
          expect(requiredSet.has(tag)).toBe(true);
        }
      }),
    );
  });
});

// ─── E3: satisfied ⟺ missingTags empty ───────────────────────────────────────

describe('E3: satisfied ⟺ missingTags.length === 0', () => {
  it('property: satisfied is true iff missingTags is empty', () => {
    fc.assert(
      fc.property(tagArray, tagArray, mode, (requiredTags, pilotTags, m) => {
        const result = evaluateEligibilityGate(requiredTags, pilotTags, m);
        expect(result.satisfied).toBe(result.missingTags.length === 0);
      }),
    );
  });

  it('property: satisfied=false iff at least one required tag is missing', () => {
    fc.assert(
      fc.property(tagArray, tagArray, mode, (requiredTags, pilotTags, m) => {
        const result = evaluateEligibilityGate(requiredTags, pilotTags, m);
        const expected = expectedMissingTags(requiredTags, pilotTags);
        if (expected.length > 0) {
          expect(result.satisfied).toBe(false);
        } else {
          expect(result.satisfied).toBe(true);
        }
      }),
    );
  });
});

// ─── E4: mode partition ───────────────────────────────────────────────────────

describe('E4: mode partition — block/warn arms are mutually exclusive', () => {
  it('property: mode=block → blocked=!satisfied, warnings=[]', () => {
    fc.assert(
      fc.property(tagArray, tagArray, (requiredTags, pilotTags) => {
        const result = evaluateEligibilityGate(requiredTags, pilotTags, 'block');
        expect(result.blocked).toBe(!result.satisfied);
        expect(result.warnings).toEqual([]);
      }),
    );
  });

  it('property: mode=warn → blocked=false, warnings=missingTags', () => {
    fc.assert(
      fc.property(tagArray, tagArray, (requiredTags, pilotTags) => {
        const result = evaluateEligibilityGate(requiredTags, pilotTags, 'warn');
        expect(result.blocked).toBe(false);
        expect(result.warnings).toEqual(result.missingTags);
      }),
    );
  });

  it('property: blocked and non-empty warnings are never both true simultaneously', () => {
    fc.assert(
      fc.property(tagArray, tagArray, mode, (requiredTags, pilotTags, m) => {
        const result = evaluateEligibilityGate(requiredTags, pilotTags, m);
        // blocked=true AND warnings.length>0 must never happen
        expect(result.blocked && result.warnings.length > 0).toBe(false);
      }),
    );
  });

  it('property: mode=block satisfied → blocked=false, warnings=[]', () => {
    fc.assert(
      fc.property(tagArray, tagArray, (requiredTags, pilotTags) => {
        const result = evaluateEligibilityGate(requiredTags, pilotTags, 'block');
        if (result.satisfied) {
          expect(result.blocked).toBe(false);
          expect(result.warnings).toEqual([]);
        }
      }),
    );
  });

  it('property: mode=warn satisfied → blocked=false, warnings=[]', () => {
    fc.assert(
      fc.property(tagArray, tagArray, (requiredTags, pilotTags) => {
        const result = evaluateEligibilityGate(requiredTags, pilotTags, 'warn');
        if (result.satisfied) {
          expect(result.blocked).toBe(false);
          expect(result.warnings).toEqual([]);
        }
      }),
    );
  });
});

// ─── E5: superset → always satisfied ────────────────────────────────────────

describe('E5: pilotTags ⊇ requiredTags → satisfied for any mode', () => {
  it('property: when pilotTags contains all requiredTags, result is satisfied and not blocked', () => {
    fc.assert(
      fc.property(nonEmptyTagArray, tagArray, mode, (requiredTags, extraPilotTags, m) => {
        // Ensure pilotTags is a strict superset of requiredTags
        const pilotTags = [...requiredTags, ...extraPilotTags];
        const result = evaluateEligibilityGate(requiredTags, pilotTags, m);
        expect(result.satisfied).toBe(true);
        expect(result.missingTags).toEqual([]);
        expect(result.blocked).toBe(false);
        expect(result.warnings).toEqual([]);
      }),
    );
  });

  it('property: pilotTags exactly equals requiredTags (no duplicates) → satisfied', () => {
    fc.assert(
      fc.property(nonEmptyTagArray, mode, (uniqueTags, m) => {
        // Deduplicate to ensure an exact match
        const deduped = [...new Set(uniqueTags)];
        const result = evaluateEligibilityGate(deduped, deduped, m);
        expect(result.satisfied).toBe(true);
        expect(result.missingTags).toEqual([]);
        expect(result.blocked).toBe(false);
      }),
    );
  });
});

// ─── E6: case-sensitivity ────────────────────────────────────────────────────

describe('E6: case-sensitivity — a case-differing pilot tag does NOT satisfy', () => {
  it('property: uppercased pilotTag does not satisfy lowercase requiredTag', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s === s.toLowerCase() && s.trim() === s && s.length > 0),
        mode,
        (lowerTag, m) => {
          const upperTag = lowerTag.toUpperCase();
          // Only meaningful when the two differ (skip if all-non-alpha string is same)
          if (lowerTag === upperTag) return;
          const result = evaluateEligibilityGate([lowerTag], [upperTag], m);
          expect(result.satisfied).toBe(false);
          expect(result.missingTags).toEqual([lowerTag]);
        },
      ),
    );
  });

  it('unit: exact case match satisfies; different case does not', () => {
    const r1 = evaluateEligibilityGate(['IFR-Current'], ['IFR-Current'], 'block');
    expect(r1.satisfied).toBe(true);

    const r2 = evaluateEligibilityGate(['IFR-Current'], ['ifr-current'], 'block');
    expect(r2.satisfied).toBe(false);
    expect(r2.missingTags).toEqual(['IFR-Current']);
    expect(r2.blocked).toBe(true);

    const r3 = evaluateEligibilityGate(['IFR-Current'], ['IFR-CURRENT'], 'block');
    expect(r3.satisfied).toBe(false);
    expect(r3.missingTags).toEqual(['IFR-Current']);
    expect(r3.blocked).toBe(true);
  });
});

// ─── E7: purity ──────────────────────────────────────────────────────────────

describe('E7: purity — same inputs produce deep-equal output; inputs not mutated', () => {
  it('property: calling twice with the same inputs gives deep-equal results', () => {
    fc.assert(
      fc.property(tagArray, tagArray, mode, (requiredTags, pilotTags, m) => {
        const result1 = evaluateEligibilityGate(requiredTags, pilotTags, m);
        const result2 = evaluateEligibilityGate(requiredTags, pilotTags, m);
        expect(result1).toEqual(result2);
      }),
    );
  });

  it('property: requiredTags input array is not mutated', () => {
    fc.assert(
      fc.property(tagArray, tagArray, mode, (requiredTags, pilotTags, m) => {
        const snapshot = JSON.stringify(requiredTags);
        evaluateEligibilityGate(requiredTags, pilotTags, m);
        expect(JSON.stringify(requiredTags)).toBe(snapshot);
      }),
    );
  });

  it('property: pilotTags input array is not mutated', () => {
    fc.assert(
      fc.property(tagArray, tagArray, mode, (requiredTags, pilotTags, m) => {
        const snapshot = JSON.stringify(pilotTags);
        evaluateEligibilityGate(requiredTags, pilotTags, m);
        expect(JSON.stringify(pilotTags)).toBe(snapshot);
      }),
    );
  });
});

// ─── Unit: empty requiredTags ─────────────────────────────────────────────────

describe('unit: empty requiredTags', () => {
  it('empty required + empty pilot, mode=block → satisfied, no gate', () => {
    const r = evaluateEligibilityGate([], [], 'block');
    expect(r.satisfied).toBe(true);
    expect(r.missingTags).toEqual([]);
    expect(r.blocked).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it('empty required + some pilots, mode=warn → satisfied, no gate', () => {
    const r = evaluateEligibilityGate([], ['IFR-Current', 'Complex-Endorsement'], 'warn');
    expect(r.satisfied).toBe(true);
    expect(r.missingTags).toEqual([]);
    expect(r.blocked).toBe(false);
    expect(r.warnings).toEqual([]);
  });
});

// ─── Unit: all tags missing ───────────────────────────────────────────────────

describe('unit: all required tags missing (pilot has no tags)', () => {
  const required = ['IFR-Current', 'Complex-Endorsement', 'High-Performance'];

  it('mode=block → blocked=true, missingTags=all required, warnings=[]', () => {
    const r = evaluateEligibilityGate(required, [], 'block');
    expect(r.satisfied).toBe(false);
    expect(r.missingTags).toEqual(['IFR-Current', 'Complex-Endorsement', 'High-Performance']);
    expect(r.blocked).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('mode=warn → blocked=false, missingTags=all required, warnings=all missing', () => {
    const r = evaluateEligibilityGate(required, [], 'warn');
    expect(r.satisfied).toBe(false);
    expect(r.missingTags).toEqual(['IFR-Current', 'Complex-Endorsement', 'High-Performance']);
    expect(r.blocked).toBe(false);
    expect(r.warnings).toEqual(['IFR-Current', 'Complex-Endorsement', 'High-Performance']);
  });
});

// ─── Unit: mixed (some held, some missing) ───────────────────────────────────

describe('unit: mixed — pilot holds some required tags, not all', () => {
  const required = ['IFR-Current', 'Complex-Endorsement', 'High-Performance'];
  const pilotHolds = ['Complex-Endorsement', 'Night-Currency'];  // has Complex, missing IFR and HP

  it('mode=block → blocked=true, only missing tags in missingTags, order from requiredTags', () => {
    const r = evaluateEligibilityGate(required, pilotHolds, 'block');
    expect(r.satisfied).toBe(false);
    expect(r.missingTags).toEqual(['IFR-Current', 'High-Performance']);
    expect(r.blocked).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('mode=warn → blocked=false, warnings=missingTags', () => {
    const r = evaluateEligibilityGate(required, pilotHolds, 'warn');
    expect(r.satisfied).toBe(false);
    expect(r.missingTags).toEqual(['IFR-Current', 'High-Performance']);
    expect(r.blocked).toBe(false);
    expect(r.warnings).toEqual(['IFR-Current', 'High-Performance']);
  });

  it('pilot holding exactly all required → satisfied', () => {
    const r = evaluateEligibilityGate(required, required, 'block');
    expect(r.satisfied).toBe(true);
    expect(r.missingTags).toEqual([]);
    expect(r.blocked).toBe(false);
  });
});

// ─── Unit: duplicate required tags ───────────────────────────────────────────

describe('unit: duplicate required tags are de-duplicated in missingTags', () => {
  it('duplicated required tag missing → appears once in missingTags', () => {
    const r = evaluateEligibilityGate(
      ['IFR-Current', 'Complex-Endorsement', 'IFR-Current'], // IFR-Current duplicated
      ['Complex-Endorsement'],
      'block',
    );
    expect(r.satisfied).toBe(false);
    expect(r.missingTags).toEqual(['IFR-Current']); // only once, first-occurrence order
    expect(r.blocked).toBe(true);
  });

  it('all duplicated required tags held by pilot → satisfied', () => {
    const r = evaluateEligibilityGate(
      ['IFR-Current', 'IFR-Current', 'IFR-Current'],
      ['IFR-Current'],
      'block',
    );
    expect(r.satisfied).toBe(true);
    expect(r.missingTags).toEqual([]);
    expect(r.blocked).toBe(false);
  });

  it('mixed duplicates — some held, some not — each missing tag appears once', () => {
    const r = evaluateEligibilityGate(
      ['A', 'B', 'A', 'C', 'B', 'C'],  // A,B,C each twice
      ['B'],                            // pilot holds B only
      'warn',
    );
    expect(r.satisfied).toBe(false);
    expect(r.missingTags).toEqual(['A', 'C']); // each once, order from first occurrence
    expect(r.blocked).toBe(false);
    expect(r.warnings).toEqual(['A', 'C']);
  });
});
