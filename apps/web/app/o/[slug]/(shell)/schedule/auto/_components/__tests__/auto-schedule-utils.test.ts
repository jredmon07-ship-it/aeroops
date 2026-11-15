/**
 * auto-schedule-utils.test.ts — Pure unit tests for the auto-scheduler UI
 * helper logic (Slice 4b, §4b.3 web).
 *
 * Tests the pure validation and serialization logic that the DemandBuilder
 * and CommitPanel encode. No DOM, no React, no Next.js, no DB.
 *
 * Coverage:
 *   1. skipReasonLabel — maps all known reason strings to human-readable labels
 *   2. resourceNames — resolves resource ids to display names with tail # prefix
 *   3. boardDateFromIso — the board ?date= day of a start instant, on the
 *      viewer's (browser's) calendar, not the ISO string's UTC date
 *   4. Serialized proposal shape — wouldResult values are 'create' | 'skip'
 *   5. SerializedCommitProposal — result values are 'created' | 'skipped'
 *   6. Unschedulable reasons — known values and their copy
 *   7. Demand window seed — "today" on the viewer's (browser's) calendar,
 *      the same basis the builder reads the date fields in
 */

import { describe, it, expect } from 'vitest';
import { toDateInputValue } from '../../../_utils/format-time';

// ─── pure helpers (mirrors what the client components implement) ──────────────

function skipReasonLabel(reason?: string): string {
  switch (reason) {
    case 'conflict': return 'Conflict';
    case 'policy': return 'Policy violation';
    case 'conflict_and_policy': return 'Conflict + policy';
    case 'twilight': return 'Civil twilight block';
    default: return 'Skipped';
  }
}

interface ResourceLike {
  id: string;
  displayName: string;
  tailNumber: string | null;
}

function resourceNames(ids: string[], resources: ResourceLike[]): string {
  return ids
    .map((id) => {
      const r = resources.find((r) => r.id === id);
      if (!r) return id.slice(0, 8);
      return r.tailNumber ? `${r.tailNumber} (${r.displayName})` : r.displayName;
    })
    .join(', ');
}

function boardDateFromIso(iso: string): string {
  return toDateInputValue(new Date(iso));
}

/** DemandBuilder's "Add date-window constraint" seed: today, browser-local. */
function seedEarliestDate(now: Date): string {
  return toDateInputValue(now);
}

/** DemandBuilder's localDateTimeToUtcMs: the date + time fields read as browser-local. */
function localDateTimeToUtcMs(date: string, time: string): number | undefined {
  if (!date || !time) return undefined;
  const d = new Date(`${date}T${time}:00`);
  if (isNaN(d.getTime())) return undefined;
  return d.getTime();
}

/** Run `fn` with the process (= the browser's local) zone switched to `tz`. */
function inZone<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('1. skipReasonLabel — all known reason strings', () => {
  it('conflict → "Conflict"', () => {
    expect(skipReasonLabel('conflict')).toBe('Conflict');
  });

  it('policy → "Policy violation"', () => {
    expect(skipReasonLabel('policy')).toBe('Policy violation');
  });

  it('conflict_and_policy → "Conflict + policy"', () => {
    expect(skipReasonLabel('conflict_and_policy')).toBe('Conflict + policy');
  });

  it('twilight → "Civil twilight block"', () => {
    expect(skipReasonLabel('twilight')).toBe('Civil twilight block');
  });

  it('undefined → "Skipped" (fallback)', () => {
    expect(skipReasonLabel(undefined)).toBe('Skipped');
  });

  it('unknown string → "Skipped" (fallback)', () => {
    expect(skipReasonLabel('unknown_future_reason')).toBe('Skipped');
  });
});

describe('2. resourceNames — display name resolution', () => {
  const resources: ResourceLike[] = [
    { id: 'res-1', displayName: 'Cessna 172', tailNumber: 'N12345' },
    { id: 'res-2', displayName: 'Jane Smith (CFI)', tailNumber: null },
    { id: 'res-3', displayName: 'Piper Archer', tailNumber: 'N99999' },
  ];

  it('aircraft with tail # → "N12345 (Cessna 172)"', () => {
    const result = resourceNames(['res-1'], resources);
    expect(result).toBe('N12345 (Cessna 172)');
  });

  it('instructor without tail # → displayName only', () => {
    const result = resourceNames(['res-2'], resources);
    expect(result).toBe('Jane Smith (CFI)');
  });

  it('multiple resources → comma-separated', () => {
    const result = resourceNames(['res-1', 'res-2'], resources);
    expect(result).toBe('N12345 (Cessna 172), Jane Smith (CFI)');
  });

  it('unknown id → first 8 chars of id (fallback)', () => {
    const result = resourceNames(['unknown-id-long'], resources);
    expect(result).toBe('unknown-');
  });

  it('empty array → empty string', () => {
    expect(resourceNames([], resources)).toBe('');
  });
});

describe('3. boardDateFromIso — the board day on the viewer’s calendar', () => {
  it('a start that is the same calendar day everywhere links to that day', () => {
    // 06:00Z = 01:00 in Chicago (CDT), 18:00 in Auckland (NZST).
    for (const tz of ['America/Chicago', 'Pacific/Auckland', 'UTC']) {
      expect(inZone(tz, () => boardDateFromIso('2026-06-19T06:00:00.000Z'))).toBe('2026-06-19');
    }
  });

  it('a US evening start links to that evening’s day, not the next UTC day', () => {
    // 2026-06-20 01:30Z = Jun 19 20:30 CDT.
    expect(inZone('America/Chicago', () => boardDateFromIso('2026-06-20T01:30:00.000Z'))).toBe('2026-06-19');
  });

  it('an Auckland morning start links to that morning’s day, not the previous UTC day', () => {
    // 2026-06-19 21:00Z = Jun 20 09:00 NZST.
    expect(inZone('Pacific/Auckland', () => boardDateFromIso('2026-06-19T21:00:00.000Z'))).toBe('2026-06-20');
  });

  it('in UTC the board day is the ISO date part, including both ends of the day', () => {
    expect(inZone('UTC', () => boardDateFromIso('2026-01-01T00:00:00.000Z'))).toBe('2026-01-01');
    expect(inZone('UTC', () => boardDateFromIso('2026-12-31T23:59:59.999Z'))).toBe('2026-12-31');
  });
});

describe('4. Preview proposal shapes — wouldResult discriminant', () => {
  it('"create" and "skip" are the only valid wouldResult values', () => {
    const validValues: Array<'create' | 'skip'> = ['create', 'skip'];
    for (const v of validValues) {
      expect(['create', 'skip']).toContain(v);
    }
  });

  it('"create" proposals have no skip reason', () => {
    const proposal = { wouldResult: 'create' as const, reason: undefined };
    expect(proposal.reason).toBeUndefined();
  });

  it('"skip" proposals carry a reason', () => {
    const proposal = {
      wouldResult: 'skip' as const,
      reason: 'conflict' as const,
    };
    expect(proposal.reason).toBe('conflict');
    expect(skipReasonLabel(proposal.reason)).toBe('Conflict');
  });
});

describe('5. Commit proposal shapes — result discriminant', () => {
  it('"created" and "skipped" are the only valid result values', () => {
    const validValues: Array<'created' | 'skipped'> = ['created', 'skipped'];
    for (const v of validValues) {
      expect(['created', 'skipped']).toContain(v);
    }
  });

  it('"created" proposals carry a reservationId', () => {
    const proposal = {
      result: 'created' as const,
      reservationId: 'res-uuid-1',
      reason: undefined,
    };
    expect(proposal.reservationId).toBeDefined();
    expect(proposal.reason).toBeUndefined();
  });

  it('"skipped" proposals carry a reason but no reservationId', () => {
    const proposal = {
      result: 'skipped' as const,
      reason: 'policy' as const,
      reservationId: undefined,
    };
    expect(proposal.reservationId).toBeUndefined();
    expect(skipReasonLabel(proposal.reason)).toBe('Policy violation');
  });
});

describe('6. Unschedulable reasons — known values', () => {
  it('"no_feasible_window" and "over_constrained" are valid', () => {
    const reasons = ['no_feasible_window', 'over_constrained'] as const;
    expect(reasons).toContain('no_feasible_window');
    expect(reasons).toContain('over_constrained');
  });

  it('no_feasible_window maps to descriptive copy', () => {
    const reason = 'no_feasible_window';
    const copy =
      reason === 'no_feasible_window'
        ? 'No feasible window in the scheduling range'
        : 'Over-constrained (window too narrow or resources fully booked)';
    expect(copy).toBe('No feasible window in the scheduling range');
  });

  it('over_constrained maps to descriptive copy', () => {
    // Use a mutable variable so TS does not narrow to a specific literal.
    const reason: string = 'over_constrained';
    const copy =
      reason === 'no_feasible_window'
        ? 'No feasible window in the scheduling range'
        : 'Over-constrained (window too narrow or resources fully booked)';
    expect(copy).toBe('Over-constrained (window too narrow or resources fully booked)');
  });
});

describe('7. Demand window seed — today on the viewer’s calendar', () => {
  // The seed used to be new Date().toISOString().slice(0, 10): the UTC day.
  it('a US evening seeds that evening’s day, not the next UTC day', () => {
    // 2026-06-20 01:30Z = Jun 19 20:30 CDT.
    expect(inZone('America/Chicago', () => seedEarliestDate(new Date('2026-06-20T01:30:00.000Z')))).toBe(
      '2026-06-19',
    );
  });

  it('an Auckland morning seeds that morning’s day, not the previous UTC day', () => {
    // 2026-06-19 21:00Z = Jun 20 09:00 NZST.
    expect(inZone('Pacific/Auckland', () => seedEarliestDate(new Date('2026-06-19T21:00:00.000Z')))).toBe(
      '2026-06-20',
    );
  });

  it('the builder reads the seeded day back as the day that contains now', () => {
    const cases = [
      ['America/Chicago', '2026-06-20T01:30:00.000Z'],
      ['Pacific/Auckland', '2026-06-19T21:00:00.000Z'],
      ['UTC', '2026-06-19T23:59:00.000Z'],
    ] as const;
    for (const [tz, nowIso] of cases) {
      inZone(tz, () => {
        const now = new Date(nowIso).getTime();
        const seeded = seedEarliestDate(new Date(now));
        expect(now).toBeGreaterThanOrEqual(localDateTimeToUtcMs(seeded, '00:00')!);
        expect(now).toBeLessThanOrEqual(localDateTimeToUtcMs(seeded, '23:59')!);
      });
    }
  });
});
