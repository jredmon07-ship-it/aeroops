/**
 * work-order-utils.test.ts — Pure unit tests for work-order display helpers
 * (Slice M1.3).
 *
 * Covers:
 *   1. workOrderStatusLabel — human-readable status labels
 *   2. isTerminalStatus — terminal status detection [VERIFY-M1-B]
 *   3. formatCompleteResultSummary — completion sub-action summary [VERIFY-M1-D]
 *
 * PURE: no DOM, no React, no Next.js, no DB, no I/O.
 *
 * COMPLIANCE:
 *   [VERIFY-M1-A]: 'completed' ≠ FAA RTS (just operator record)
 *   [VERIFY-M1-B]: no reopen path — terminal = completed | cancelled
 *   [VERIFY-M1-D]: unground = explicit operator action; skip reasons are informational
 */

import { describe, it, expect } from 'vitest';
import {
  workOrderStatusLabel,
  isTerminalStatus,
  formatCompleteResultSummary,
} from '../work-orders/_components/work-order-utils';

// ═════════════════════════════════════════════════════════════════════════════
// 1. workOrderStatusLabel [VERIFY-M1-A]
// ═════════════════════════════════════════════════════════════════════════════

describe('1. workOrderStatusLabel [VERIFY-M1-A]', () => {
  it("'open' → 'Open'", () => {
    expect(workOrderStatusLabel('open')).toBe('Open');
  });

  it("'in_progress' → 'In progress'", () => {
    expect(workOrderStatusLabel('in_progress')).toBe('In progress');
  });

  it("'completed' → 'Completed' (operator record, NOT FAA RTS [VERIFY-M1-A])", () => {
    expect(workOrderStatusLabel('completed')).toBe('Completed');
  });

  it("'cancelled' → 'Cancelled'", () => {
    expect(workOrderStatusLabel('cancelled')).toBe('Cancelled');
  });

  it('unknown status → passthrough (defensive)', () => {
    expect(workOrderStatusLabel('unknown_future_status')).toBe('unknown_future_status');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. isTerminalStatus [VERIFY-M1-B]
// ═════════════════════════════════════════════════════════════════════════════

describe('2. isTerminalStatus [VERIFY-M1-B] — no reopen', () => {
  it("'completed' is terminal (no reopen [VERIFY-M1-B])", () => {
    expect(isTerminalStatus('completed')).toBe(true);
  });

  it("'cancelled' is terminal (no reopen [VERIFY-M1-B])", () => {
    expect(isTerminalStatus('cancelled')).toBe(true);
  });

  it("'open' is NOT terminal (actions available)", () => {
    expect(isTerminalStatus('open')).toBe(false);
  });

  it("'in_progress' is NOT terminal (actions available)", () => {
    expect(isTerminalStatus('in_progress')).toBe(false);
  });

  it('unknown status → false (defensive; does not prevent display)', () => {
    expect(isTerminalStatus('unknown')).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. formatCompleteResultSummary [VERIFY-M1-D]
// ═════════════════════════════════════════════════════════════════════════════

describe('3. formatCompleteResultSummary [VERIFY-M1-D]', () => {
  it('always includes a "Work order marked as completed" first line', () => {
    const lines = formatCompleteResultSummary({
      ungrounded: false,
      requestedResolveSquawk: false,
      requestedUnground: false,
    });
    expect(lines[0]).toEqual({ applied: true, label: 'Work order marked as completed.' });
  });

  it('no sub-actions requested → only the WO completion line', () => {
    const lines = formatCompleteResultSummary({
      ungrounded: false,
      requestedResolveSquawk: false,
      requestedUnground: false,
    });
    expect(lines.length).toBe(1);
  });

  it('squawk resolved → applied=true squawk line', () => {
    const lines = formatCompleteResultSummary({
      squawkResolveSkipped: undefined,
      ungrounded: false,
      requestedResolveSquawk: true,
      requestedUnground: false,
    });
    const squawkLine = lines.find((l) => l.label.includes('squawk'));
    expect(squawkLine?.applied).toBe(true);
    expect(squawkLine?.label).toContain('Linked squawk resolved');
  });

  it('squawk skip: no_linked_squawk → applied=false informational line', () => {
    const lines = formatCompleteResultSummary({
      squawkResolveSkipped: 'no_linked_squawk',
      ungrounded: false,
      requestedResolveSquawk: true,
      requestedUnground: false,
    });
    const squawkLine = lines.find((l) => l.label.includes('squawk'));
    expect(squawkLine?.applied).toBe(false);
    expect(squawkLine?.label).toContain('No linked squawk');
  });

  it('squawk skip: already_resolved_or_deferred → applied=false informational line', () => {
    const lines = formatCompleteResultSummary({
      squawkResolveSkipped: 'already_resolved_or_deferred',
      ungrounded: false,
      requestedResolveSquawk: true,
      requestedUnground: false,
    });
    const squawkLine = lines.find((l) => l.label.includes('already'));
    expect(squawkLine?.applied).toBe(false);
  });

  it('unground applied → applied=true unground line [VERIFY-M1-D]', () => {
    const lines = formatCompleteResultSummary({
      ungrounded: true,
      requestedResolveSquawk: false,
      requestedUnground: true,
    });
    const ungroundLine = lines.find((l) => l.label.includes('service'));
    expect(ungroundLine?.applied).toBe(true);
  });

  it('unground skip: not_grounded → applied=false not-grounded line [VERIFY-M1-D]', () => {
    const lines = formatCompleteResultSummary({
      ungrounded: false,
      ungroundSkipped: 'not_grounded',
      requestedResolveSquawk: false,
      requestedUnground: true,
    });
    const ungroundLine = lines.find((l) => l.label.includes('not grounded'));
    expect(ungroundLine?.applied).toBe(false);
  });

  it('unground skip: grounded_for_other_reason → applied=false with reason [VERIFY-M1-D]', () => {
    const lines = formatCompleteResultSummary({
      ungrounded: false,
      ungroundSkipped: 'grounded_for_other_reason',
      requestedResolveSquawk: false,
      requestedUnground: true,
    });
    const ungroundLine = lines.find((l) => l.label.includes('different reason'));
    expect(ungroundLine?.applied).toBe(false);
  });

  it('unground skip: no_matching_grounding_basis → applied=false informational [VERIFY-M1-D]', () => {
    const lines = formatCompleteResultSummary({
      ungrounded: false,
      ungroundSkipped: 'no_matching_grounding_basis',
      requestedResolveSquawk: false,
      requestedUnground: true,
    });
    const ungroundLine = lines.find((l) => l.label.includes('basis'));
    expect(ungroundLine?.applied).toBe(false);
  });

  it('all three sub-actions → 3 lines total (WO + squawk + unground)', () => {
    const lines = formatCompleteResultSummary({
      squawkResolveSkipped: undefined,
      ungrounded: true,
      requestedResolveSquawk: true,
      requestedUnground: true,
    });
    expect(lines.length).toBe(3);
  });

  it('sub-action not requested → no corresponding line added', () => {
    const lines = formatCompleteResultSummary({
      ungrounded: true, // unground was not requested — this field should be ignored
      requestedResolveSquawk: false,
      requestedUnground: false,
    });
    // Only the WO completion line
    expect(lines.length).toBe(1);
    expect(lines[0]?.label).toContain('completed');
  });
});
