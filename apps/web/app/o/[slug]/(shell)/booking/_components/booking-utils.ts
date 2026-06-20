/**
 * booking-utils.ts — Pure display helpers for the booking-request triage inbox.
 *
 * PURE: no I/O, no DOM, no Next.js, no React. Unit-testable in isolation.
 *
 * Exported for use by BookingInbox (client component) and tests.
 */

// ─── Status domain ────────────────────────────────────────────────────────────

export type BookingRequestStatus = 'new' | 'contacted' | 'converted' | 'declined';

// ─── statusLabel ──────────────────────────────────────────────────────────────

/**
 * statusLabel — human-readable label for a booking request status value.
 *
 * @param status - One of the four BookingRequestStatus values.
 * @returns      - A short, Title Case label.
 */
export function statusLabel(status: BookingRequestStatus | string): string {
  const map: Record<string, string> = {
    new: 'New',
    contacted: 'Contacted',
    converted: 'Converted',
    declined: 'Declined',
  };
  return map[status] ?? status;
}

// ─── statusBadgeIntent ────────────────────────────────────────────────────────

/**
 * StatusBadgeConfig — visual config for a booking request status badge.
 * cls  — Tailwind classes for colour/border.
 */
export interface StatusBadgeConfig {
  label: string;
  cls: string;
}

/**
 * statusBadgeConfig — returns the visual config for a status badge.
 *
 * Colour mapping (mirrors severity/status chip pattern from work-order-status-badge):
 *   new       → brand accent (blue)      — needs action
 *   contacted → amber                    — in-progress
 *   converted → green                    — positive terminal
 *   declined  → slate                    — neutral terminal
 *
 * @param status - A BookingRequestStatus value.
 * @returns      - StatusBadgeConfig { label, cls }.
 */
export function statusBadgeConfig(status: BookingRequestStatus | string): StatusBadgeConfig {
  const configs: Record<string, StatusBadgeConfig> = {
    new: {
      label: 'New',
      cls: 'border-brand/30 bg-brand/8 text-brand-ink',
    },
    contacted: {
      label: 'Contacted',
      cls: 'border-amber-200 bg-amber-50 text-amber-800',
    },
    converted: {
      label: 'Converted',
      cls: 'border-green-200 bg-green-50 text-green-800',
    },
    declined: {
      label: 'Declined',
      cls: 'border-slate-200 bg-slate-50 text-slate-500',
    },
  };
  return (
    configs[status] ?? {
      label: status,
      cls: 'border-slate-200 bg-slate-50 text-slate-500',
    }
  );
}

// ─── isTerminalStatus ─────────────────────────────────────────────────────────

/**
 * isTerminalStatus — returns true for statuses that allow no further transitions.
 *
 * Terminal statuses (per transition table in update-booking-request-status.ts):
 *   converted — no outgoing transitions
 *   declined  — no outgoing transitions
 *
 * @param status - A BookingRequestStatus or unknown string.
 * @returns      - true iff no further transitions are permitted.
 */
export function isTerminalStatus(status: BookingRequestStatus | string): boolean {
  return status === 'converted' || status === 'declined';
}

// ─── formatRequestedDate ──────────────────────────────────────────────────────

/**
 * formatRequestedDate — formats a requested start (+ optional end) into a
 * human-readable string for the triage inbox.
 *
 * Examples:
 *   start only  → "Jun 25, 2026 at 10:00 AM"
 *   with end    → "Jun 25, 2026 at 10:00 AM – 12:00 PM"
 *                  (end date omitted when same calendar day)
 *   invalid ISO → "—"
 *
 * @param startIso - ISO 8601 string for requested_start.
 * @param endIso   - ISO 8601 string for requested_end (nullable).
 * @returns        - Formatted string.
 */
export function formatRequestedDate(
  startIso: string,
  endIso: string | null,
): string {
  try {
    const start = new Date(startIso);
    if (isNaN(start.getTime())) return '—';

    const datePart = start.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    const timePart = start.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });

    if (!endIso) return `${datePart} at ${timePart}`;

    const end = new Date(endIso);
    if (isNaN(end.getTime())) return `${datePart} at ${timePart}`;

    const endTimePart = end.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    });

    // If end is a different calendar date, include the full end date.
    const endDatePart = end.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

    if (endDatePart !== datePart) {
      return `${datePart} at ${timePart} – ${endDatePart} at ${endTimePart}`;
    }

    return `${datePart} at ${timePart} – ${endTimePart}`;
  } catch {
    return '—';
  }
}
