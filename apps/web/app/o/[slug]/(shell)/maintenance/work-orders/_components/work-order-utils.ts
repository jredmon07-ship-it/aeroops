/**
 * work-order-utils.ts — Pure display helpers for the Work-Orders module
 * (Slice M1.3).
 *
 * PURE: no DOM, no React, no Next.js, no I/O. Unit-testable.
 *
 * COMPLIANCE POSTURE [VERIFY-M1-A]:
 *   A work order's 'completed' status is OPERATOR DATA — it is NOT a FAA
 *   return-to-service or §43.9/§43.11 determination.
 */

// ─── workOrderStatusLabel ─────────────────────────────────────────────────────

/**
 * workOrderStatusLabel — human-readable label for a work-order status value.
 *
 * [VERIFY-M1-A]: 'completed' ≠ FAA RTS. Only operator record.
 */
export function workOrderStatusLabel(status: string): string {
  switch (status) {
    case 'open':        return 'Open';
    case 'in_progress': return 'In progress';
    case 'completed':   return 'Completed';
    case 'cancelled':   return 'Cancelled';
    default:            return status;
  }
}

// ─── isTerminalStatus ─────────────────────────────────────────────────────────

/**
 * isTerminalStatus — true when the WO is in a terminal state (no further edits).
 * [VERIFY-M1-B]: no reopen path.
 */
export function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'cancelled';
}

// ─── formatCompleteResultSummary ──────────────────────────────────────────────

export interface CompleteResultSummaryInput {
  squawkResolveSkipped?: 'no_linked_squawk' | 'already_resolved_or_deferred';
  ungrounded: boolean;
  ungroundSkipped?: 'not_grounded' | 'grounded_for_other_reason' | 'no_matching_grounding_basis';
  requestedResolveSquawk: boolean;
  requestedUnground: boolean;
}

export interface CompleteResultSummaryLine {
  applied: boolean;
  label: string;
}

/**
 * formatCompleteResultSummary — produces an array of result lines for the
 * Complete work order result panel/toast.
 *
 * Each line describes what happened (or was skipped) for each sub-action.
 * Pure function — no I/O, no DOM.
 *
 * [VERIFY-M1-D]: unground = operator action; skip reasons are informational.
 */
export function formatCompleteResultSummary(
  input: CompleteResultSummaryInput,
): CompleteResultSummaryLine[] {
  const lines: CompleteResultSummaryLine[] = [];

  // Work order itself always completes when ok:true
  lines.push({ applied: true, label: 'Work order marked as completed.' });

  // Squawk resolve
  if (input.requestedResolveSquawk) {
    if (!input.squawkResolveSkipped) {
      lines.push({ applied: true, label: 'Linked squawk resolved.' });
    } else if (input.squawkResolveSkipped === 'no_linked_squawk') {
      lines.push({ applied: false, label: 'No linked squawk to resolve.' });
    } else if (input.squawkResolveSkipped === 'already_resolved_or_deferred') {
      lines.push({ applied: false, label: 'Squawk already resolved or deferred — skipped.' });
    }
  }

  // Unground
  if (input.requestedUnground) {
    if (input.ungrounded) {
      lines.push({ applied: true, label: 'Aircraft returned to service (operator grounding released).' });
    } else if (input.ungroundSkipped === 'not_grounded') {
      lines.push({ applied: false, label: 'Aircraft was not grounded — no change.' });
    } else if (input.ungroundSkipped === 'grounded_for_other_reason') {
      lines.push({ applied: false, label: 'Aircraft remains grounded — grounded for a different reason.' });
    } else if (input.ungroundSkipped === 'no_matching_grounding_basis') {
      lines.push({ applied: false, label: 'Grounding basis does not match this work order — aircraft remains grounded.' });
    }
  }

  return lines;
}

// ─── formatDate helpers ───────────────────────────────────────────────────────

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(iso));
  } catch {
    return iso ?? '—';
  }
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso ?? '—';
  }
}
