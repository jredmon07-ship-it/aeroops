/**
 * grounding-gate.test.ts — unit + property tests for the pure grounding gate.
 *
 * This is where the MAINTENANCE-3b grounding gate PROPERTY tests live (ADR-0008
 * §6, the hard guardrail). The pure fn decides which candidate resources are
 * blocked or warned due to grounding.
 *
 * Deterministic: no Date.now(), no Math.random() — fast-check seeds the only
 * randomness and generators are constrained to produce well-formed inputs.
 *
 * COVERAGE:
 *   Property (fast-check), per spec §6:
 *     G1  released/non-grounded aircraft never appears in blocked or warnings.
 *     G2  mode='block' ⇒ every grounded aircraft in `blocked`, none in `warnings`.
 *         mode='warn'  ⇒ every grounded aircraft in `warnings`, none in `blocked`.
 *     G3  non-aircraft kinds never appear in either list (never evaluated).
 *     G4  exact partition: no resource in both; |blocked|+|warnings| == grounded count.
 *     G5  purity: same input twice ⇒ deep-equal output.
 *   Unit:
 *     - empty input → empty result
 *     - all grounded aircraft → all in blocked (mode='block')
 *     - all grounded aircraft → all in warnings (mode='warn')
 *     - mixed kinds and states
 *     - grounded aircraft with reason:null
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  evaluateGroundingGate,
} from '../maintenance/grounding-gate.js';
import type {
  GroundingHit,
  GroundingGateResult,
} from '../maintenance/grounding-gate.js';

// ─── Generators ──────────────────────────────────────────────────────────────

const AIRCRAFT_KIND = 'aircraft' as const;
const NON_AIRCRAFT_KINDS = ['instructor', 'sim', 'room', 'vehicle'] as const;

/** Generate a UUID-like string (not a real RFC-4122 UUID, but unique enough for tests). */
const resourceId = fc.uuid();

/** Generate a grounding reason string or null. */
const reasonOrNull = fc.oneof(fc.string({ minLength: 1, maxLength: 80 }), fc.constant(null));

/** A candidate aircraft resource. */
const aircraftResource = fc.record({
  resourceId: resourceId,
  kind: fc.constant(AIRCRAFT_KIND),
  grounded: fc.boolean(),
  reason: reasonOrNull,
});

/** A grounded aircraft resource (grounded=true). */
const groundedAircraftResource = fc.record({
  resourceId: resourceId,
  kind: fc.constant(AIRCRAFT_KIND),
  grounded: fc.constant(true),
  reason: reasonOrNull,
});

/** A released (non-grounded) aircraft resource (grounded=false). */
const releasedAircraftResource = fc.record({
  resourceId: resourceId,
  kind: fc.constant(AIRCRAFT_KIND),
  grounded: fc.constant(false),
  reason: fc.constant(null),
});

/** A non-aircraft resource with any grounding flag. */
const nonAircraftResource = fc.record({
  resourceId: resourceId,
  kind: fc.oneof(...NON_AIRCRAFT_KINDS.map((k) => fc.constant(k))),
  grounded: fc.boolean(),
  reason: reasonOrNull,
});

/** A mixed array of candidate resources (aircraft and non-aircraft). */
const candidateResources = fc.array(
  fc.oneof(aircraftResource, nonAircraftResource),
  { minLength: 0, maxLength: 20 },
);

/** A mode string. */
const mode = fc.oneof(fc.constant('block' as const), fc.constant('warn' as const));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countGroundedAircraft(
  resources: { kind: string; grounded: boolean }[],
): number {
  return resources.filter((r) => r.kind === 'aircraft' && r.grounded).length;
}

function allHitIds(result: GroundingGateResult): string[] {
  return [...result.blocked.map((h) => h.resourceId), ...result.warnings.map((h) => h.resourceId)];
}

// ─── G1: Released aircraft never appear ──────────────────────────────────────

describe('G1: released/non-grounded aircraft never appears in blocked or warnings', () => {
  it('property: any released aircraft is absent from both lists for either mode', () => {
    fc.assert(
      fc.property(
        fc.array(releasedAircraftResource, { minLength: 1, maxLength: 10 }),
        fc.array(nonAircraftResource, { minLength: 0, maxLength: 5 }),
        mode,
        (releasedAircraft, nonAircraft, m) => {
          const resources = [...releasedAircraft, ...nonAircraft];
          const result = evaluateGroundingGate(resources, m);
          const hitIds = new Set(allHitIds(result));
          for (const r of releasedAircraft) {
            expect(hitIds.has(r.resourceId)).toBe(false);
          }
        },
      ),
    );
  });

  it('property: mixed resources — released aircraft never hit', () => {
    fc.assert(
      fc.property(candidateResources, mode, (resources, m) => {
        const result = evaluateGroundingGate(resources, m);
        const hitIds = new Set(allHitIds(result));
        for (const r of resources) {
          if (r.kind === 'aircraft' && !r.grounded) {
            expect(hitIds.has(r.resourceId)).toBe(false);
          }
        }
      }),
    );
  });
});

// ─── G2: Mode partitions correctly ───────────────────────────────────────────

describe('G2: mode partitions grounded aircraft into the correct list', () => {
  it('property: mode=block ⇒ every grounded aircraft in blocked, none in warnings', () => {
    fc.assert(
      fc.property(candidateResources, (resources) => {
        const result = evaluateGroundingGate(resources, 'block');
        expect(result.warnings).toHaveLength(0);
        const blockedIds = new Set(result.blocked.map((h) => h.resourceId));
        for (const r of resources) {
          if (r.kind === 'aircraft' && r.grounded) {
            expect(blockedIds.has(r.resourceId)).toBe(true);
          }
        }
      }),
    );
  });

  it('property: mode=warn ⇒ every grounded aircraft in warnings, none in blocked', () => {
    fc.assert(
      fc.property(candidateResources, (resources) => {
        const result = evaluateGroundingGate(resources, 'warn');
        expect(result.blocked).toHaveLength(0);
        const warnIds = new Set(result.warnings.map((h) => h.resourceId));
        for (const r of resources) {
          if (r.kind === 'aircraft' && r.grounded) {
            expect(warnIds.has(r.resourceId)).toBe(true);
          }
        }
      }),
    );
  });
});

// ─── G3: Non-aircraft kinds never evaluated ───────────────────────────────────

describe('G3: non-aircraft kinds never appear in either list', () => {
  it('property: non-aircraft resources (even if grounded=true) never hit', () => {
    fc.assert(
      fc.property(
        fc.array(nonAircraftResource, { minLength: 0, maxLength: 10 }),
        mode,
        (resources, m) => {
          const result = evaluateGroundingGate(resources, m);
          expect(result.blocked).toHaveLength(0);
          expect(result.warnings).toHaveLength(0);
        },
      ),
    );
  });

  it('property: mixed resources — non-aircraft never in either list', () => {
    fc.assert(
      fc.property(candidateResources, mode, (resources, m) => {
        const result = evaluateGroundingGate(resources, m);
        const hitIds = new Set(allHitIds(result));
        for (const r of resources) {
          if (r.kind !== 'aircraft') {
            expect(hitIds.has(r.resourceId)).toBe(false);
          }
        }
      }),
    );
  });
});

// ─── G4: Exact partition ──────────────────────────────────────────────────────

describe('G4: exact partition — no resource in both; |blocked|+|warnings| == grounded aircraft count', () => {
  it('property: no resource appears in both blocked and warnings', () => {
    fc.assert(
      fc.property(candidateResources, mode, (resources, m) => {
        const result = evaluateGroundingGate(resources, m);
        const blockedIds = new Set(result.blocked.map((h) => h.resourceId));
        for (const hit of result.warnings) {
          expect(blockedIds.has(hit.resourceId)).toBe(false);
        }
      }),
    );
  });

  it('property: |blocked|+|warnings| equals the count of grounded aircraft in the input', () => {
    fc.assert(
      fc.property(candidateResources, mode, (resources, m) => {
        const result = evaluateGroundingGate(resources, m);
        const expectedCount = countGroundedAircraft(resources);
        expect(result.blocked.length + result.warnings.length).toBe(expectedCount);
      }),
    );
  });
});

// ─── G5: Purity ──────────────────────────────────────────────────────────────

describe('G5: purity — same input twice produces deep-equal output', () => {
  it('property: calling twice with the same input gives deep-equal results', () => {
    fc.assert(
      fc.property(candidateResources, mode, (resources, m) => {
        const result1 = evaluateGroundingGate(resources, m);
        const result2 = evaluateGroundingGate(resources, m);
        expect(result1).toEqual(result2);
      }),
    );
  });

  it('property: input is not mutated by the function', () => {
    fc.assert(
      fc.property(candidateResources, mode, (resources, m) => {
        const inputSnapshot = JSON.stringify(resources);
        evaluateGroundingGate(resources, m);
        expect(JSON.stringify(resources)).toBe(inputSnapshot);
      }),
    );
  });
});

// ─── Unit: empty input ────────────────────────────────────────────────────────

describe('unit: empty input', () => {
  it('mode=block → empty blocked and empty warnings', () => {
    const result = evaluateGroundingGate([], 'block');
    expect(result.blocked).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('mode=warn → empty blocked and empty warnings', () => {
    const result = evaluateGroundingGate([], 'warn');
    expect(result.blocked).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

// ─── Unit: all-grounded aircraft ──────────────────────────────────────────────

describe('unit: all grounded aircraft', () => {
  const allGrounded = [
    { resourceId: 'ac-1', kind: 'aircraft', grounded: true, reason: 'magneto check failed' },
    { resourceId: 'ac-2', kind: 'aircraft', grounded: true, reason: 'oil leak' },
    { resourceId: 'ac-3', kind: 'aircraft', grounded: true, reason: 'brake wear' },
  ];

  it('mode=block → all three in blocked, none in warnings', () => {
    const result = evaluateGroundingGate(allGrounded, 'block');
    expect(result.warnings).toHaveLength(0);
    expect(result.blocked).toHaveLength(3);
    const ids = result.blocked.map((h) => h.resourceId).sort();
    expect(ids).toEqual(['ac-1', 'ac-2', 'ac-3']);
  });

  it('mode=warn → all three in warnings, none in blocked', () => {
    const result = evaluateGroundingGate(allGrounded, 'warn');
    expect(result.blocked).toHaveLength(0);
    expect(result.warnings).toHaveLength(3);
    const ids = result.warnings.map((h) => h.resourceId).sort();
    expect(ids).toEqual(['ac-1', 'ac-2', 'ac-3']);
  });

  it('reason string is preserved in the hit', () => {
    const result = evaluateGroundingGate(allGrounded, 'block');
    const hit = result.blocked.find((h) => h.resourceId === 'ac-1');
    expect(hit?.reason).toBe('magneto check failed');
  });
});

// ─── Unit: mixed kinds and states ────────────────────────────────────────────

describe('unit: mixed kinds and states', () => {
  const mixed = [
    { resourceId: 'ac-grounded', kind: 'aircraft', grounded: true, reason: 'flap actuator' },
    { resourceId: 'ac-released', kind: 'aircraft', grounded: false, reason: null },
    { resourceId: 'instructor-1', kind: 'instructor', grounded: true, reason: 'not applicable' },
    { resourceId: 'sim-1', kind: 'sim', grounded: true, reason: 'hardware fault' },
    { resourceId: 'room-1', kind: 'room', grounded: false, reason: null },
    { resourceId: 'vehicle-1', kind: 'vehicle', grounded: true, reason: 'fuel system' },
  ];

  it('mode=block → only the grounded aircraft in blocked', () => {
    const result = evaluateGroundingGate(mixed, 'block');
    expect(result.warnings).toHaveLength(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]?.resourceId).toBe('ac-grounded');
    expect(result.blocked[0]?.reason).toBe('flap actuator');
  });

  it('mode=warn → only the grounded aircraft in warnings', () => {
    const result = evaluateGroundingGate(mixed, 'warn');
    expect(result.blocked).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.resourceId).toBe('ac-grounded');
  });

  it('ac-released is absent from both lists', () => {
    const resultBlock = evaluateGroundingGate(mixed, 'block');
    const resultWarn = evaluateGroundingGate(mixed, 'warn');
    const idsBlock = new Set(allHitIds(resultBlock));
    const idsWarn = new Set(allHitIds(resultWarn));
    expect(idsBlock.has('ac-released')).toBe(false);
    expect(idsWarn.has('ac-released')).toBe(false);
  });

  it('non-aircraft resources are absent from both lists even when grounded=true', () => {
    const resultBlock = evaluateGroundingGate(mixed, 'block');
    const resultWarn = evaluateGroundingGate(mixed, 'warn');
    const nonAircraftIds = ['instructor-1', 'sim-1', 'room-1', 'vehicle-1'];
    const idsBlock = new Set(allHitIds(resultBlock));
    const idsWarn = new Set(allHitIds(resultWarn));
    for (const id of nonAircraftIds) {
      expect(idsBlock.has(id)).toBe(false);
      expect(idsWarn.has(id)).toBe(false);
    }
  });
});

// ─── Unit: grounded aircraft with reason:null ─────────────────────────────────

describe('unit: grounded aircraft with reason:null', () => {
  it('reason:null is passed through to GroundingHit unchanged (mode=block)', () => {
    const resources = [
      { resourceId: 'ac-null-reason', kind: 'aircraft', grounded: true, reason: null },
    ];
    const result = evaluateGroundingGate(resources, 'block');
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]?.resourceId).toBe('ac-null-reason');
    expect(result.blocked[0]?.reason).toBeNull();
  });

  it('reason:null is passed through to GroundingHit unchanged (mode=warn)', () => {
    const resources = [
      { resourceId: 'ac-null-reason', kind: 'aircraft', grounded: true, reason: null },
    ];
    const result = evaluateGroundingGate(resources, 'warn');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.resourceId).toBe('ac-null-reason');
    expect(result.warnings[0]?.reason).toBeNull();
  });
});

// ─── Unit: only non-aircraft, some with grounded=true ────────────────────────

describe('unit: only non-aircraft resources', () => {
  const nonAircraft = [
    { resourceId: 'inst-1', kind: 'instructor', grounded: true, reason: 'leave' },
    { resourceId: 'sim-2', kind: 'sim', grounded: true, reason: 'broken' },
  ];

  it('mode=block → empty result even when all grounded', () => {
    const result = evaluateGroundingGate(nonAircraft, 'block');
    expect(result.blocked).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('mode=warn → empty result even when all grounded', () => {
    const result = evaluateGroundingGate(nonAircraft, 'warn');
    expect(result.blocked).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});
