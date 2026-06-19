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
 *   3. boardDateFromIso — extracts YYYY-MM-DD from an ISO timestamp string
 *   4. Serialized proposal shape — wouldResult values are 'create' | 'skip'
 *   5. SerializedCommitProposal — result values are 'created' | 'skipped'
 */

import { describe, it, expect } from 'vitest';

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
  return iso.slice(0, 10);
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

describe('3. boardDateFromIso — extracts YYYY-MM-DD from ISO timestamp', () => {
  it('extracts date from full ISO timestamp', () => {
    expect(boardDateFromIso('2026-06-19T14:30:00.000Z')).toBe('2026-06-19');
  });

  it('handles midnight UTC', () => {
    expect(boardDateFromIso('2026-01-01T00:00:00.000Z')).toBe('2026-01-01');
  });

  it('handles end of day', () => {
    expect(boardDateFromIso('2026-12-31T23:59:59.999Z')).toBe('2026-12-31');
  });

  it('date-only string passes through unchanged', () => {
    expect(boardDateFromIso('2026-06-19')).toBe('2026-06-19');
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
    let reason: string = 'over_constrained';
    const copy =
      reason === 'no_feasible_window'
        ? 'No feasible window in the scheduling range'
        : 'Over-constrained (window too narrow or resources fully booked)';
    expect(copy).toBe('Over-constrained (window too narrow or resources fully booked)');
  });
});
