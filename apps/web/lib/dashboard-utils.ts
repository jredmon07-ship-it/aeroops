/**
 * lib/dashboard-utils.ts — Pure helpers for the Slice-7 ops dashboard.
 *
 * Extracted so they are independently testable (no Next.js, no DOM, no DB).
 *
 * PURE: no I/O; safe to import in both RSC and test environments.
 */

import { addDays, dayInZone } from './schedule-day';
import { NO_TIME, formatInZone, formatZonedClock } from './zoned-format';

// ─── Range key ────────────────────────────────────────────────────────────────

export type DashboardRangeKey = '7d' | '30d' | '90d';

/**
 * resolveRangeKey — validates a raw ?range= string and falls back to '30d'.
 *
 * Contract: any input that is not '7d'/'30d'/'90d' → returns '30d' (default).
 * Spec §3: "validate→fallback 30d".
 */
export function resolveRangeKey(
  raw: string | string[] | undefined | null,
): DashboardRangeKey {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === '7d' || v === '30d' || v === '90d') return v;
  return '30d';
}

/**
 * rangeLabelFull — human-readable label for a range key.
 *
 * Used in heading labels like "Last 30 days".
 */
export function rangeLabelFull(key: DashboardRangeKey): string {
  if (key === '7d') return '7 days';
  if (key === '90d') return '90 days';
  return '30 days';
}

/**
 * formatFlightStart — a reservation's start for the "Today's flights" card,
 * on the 24-hour clock in the viewer's zone (the zone the card's day is in):
 *
 *   starts on `today`        → "15:00"
 *   started the day before   → "Yesterday 15:00" (an overnight booking still running)
 *   started earlier          → "Nov 13 15:00"
 *   unreadable               → "—"
 *
 * The card lists every booking that overlaps today, so one that began
 * yesterday must not read as a bare "15:00" at the top of today's list.
 *
 * @param iso      - The reservation's startAt (ISO instant).
 * @param today    - The viewer's calendar day, "YYYY-MM-DD" (dayInZone).
 * @param timeZone - The viewer's IANA zone (getViewerTimeZone).
 * Never throws.
 */
export function formatFlightStart(iso: string, today: string, timeZone: string): string {
  const clock = formatZonedClock(iso, timeZone);
  if (clock === NO_TIME) return NO_TIME;
  try {
    const day = dayInZone(new Date(iso), timeZone);
    if (day === today) return clock;
    if (day === addDays(today, -1)) return `Yesterday ${clock}`;
    return `${formatInZone(iso, timeZone, { month: 'short', day: 'numeric' })} ${clock}`;
  } catch {
    return clock;
  }
}

/**
 * clampBarWidth — clamp a utilization proportion to [0, 100].
 *
 * If maxHours is 0, returns 0 (all bars are empty — correct for zero-flight fleet).
 */
export function clampBarWidth(flightHours: number, maxHours: number): number {
  if (maxHours <= 0 || flightHours < 0) return 0;
  return Math.min(100, (flightHours / maxHours) * 100);
}
