/**
 * booking-utils.ts — Pure display helpers for the booking-request triage inbox.
 *
 * PURE: no I/O, no DOM, no Next.js, no React. Unit-testable in isolation.
 *
 * Exported for use by BookingInbox (client component) and tests.
 */

import { NO_TIME, formatInZone, formatZonedDate } from '@/lib/zoned-format';

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
      cls: 'border-brand/30 bg-brand/8 dark:bg-brand/20 text-brand-ink dark:text-blue-200',
    },
    contacted: {
      label: 'Contacted',
      cls: 'border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200',
    },
    converted: {
      label: 'Converted',
      cls: 'border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-950/40 text-green-800 dark:text-green-200',
    },
    declined: {
      label: 'Declined',
      cls: 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
    },
  };
  return (
    configs[status] ?? {
      label: status,
      cls: 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
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

/** "10:00 AM" */
const CLOCK_12H: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

/**
 * formatRequestedDate — formats a requested start (+ optional end) into a
 * human-readable string for the triage inbox, in the viewer's zone.
 *
 * Examples (timeZone 'UTC'):
 *   start only  → "Jun 25, 2026 at 10:00 AM"
 *   with end    → "Jun 25, 2026 at 10:00 AM – 12:00 PM"
 *                  (end date omitted when same calendar day)
 *   invalid ISO → "—"
 *
 * The inbox renders on the server first, so the zone is passed in (the one
 * the page resolved with getViewerTimeZone) rather than read from the
 * runtime: UTC on the server, the viewer's in the browser, would not hydrate.
 *
 * @param startIso - ISO 8601 string for requested_start.
 * @param endIso   - ISO 8601 string for requested_end (nullable).
 * @param timeZone - IANA zone the date and times read in.
 * @returns        - Formatted string.
 */
export function formatRequestedDate(
  startIso: string,
  endIso: string | null,
  timeZone: string,
): string {
  const datePart = formatZonedDate(startIso, timeZone);
  if (datePart === NO_TIME) return NO_TIME;
  const timePart = formatInZone(startIso, timeZone, CLOCK_12H);

  if (!endIso) return `${datePart} at ${timePart}`;

  const endDatePart = formatZonedDate(endIso, timeZone);
  if (endDatePart === NO_TIME) return `${datePart} at ${timePart}`;
  const endTimePart = formatInZone(endIso, timeZone, CLOCK_12H);

  // If end is a different calendar date, include the full end date.
  if (endDatePart !== datePart) {
    return `${datePart} at ${timePart} – ${endDatePart} at ${endTimePart}`;
  }

  return `${datePart} at ${timePart} – ${endTimePart}`;
}
