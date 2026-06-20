/**
 * availability-display.ts — Pure display helpers for availability windows.
 * (Slice AV1.3)
 *
 * These helpers are PURE (no I/O, no React, no DOM) so they can be tested
 * in a Node environment via vitest.
 *
 * [VERIFY-AV1-A]: availability windows = OPERATOR operating-hours data ONLY.
 * NOT an FAA duty-time, rest-period, Part-117/135/121, or flight-time-limit
 * determination.
 */

// ─── Day-of-week labels (ISO 8601: 1=Mon ... 7=Sun) ───────────────────────────

const DOW_LABELS: Record<number, string> = {
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
  7: 'Sunday',
};

/** Return the full weekday label for a 1-based ISO day-of-week (1=Mon...7=Sun). */
export function dowLabel(dayOfWeek: number): string {
  return DOW_LABELS[dayOfWeek] ?? `Day ${dayOfWeek}`;
}

// ─── Minutes to "HH:MM" formatter ─────────────────────────────────────────────

/**
 * Format minutes-since-midnight to a zero-padded "HH:MM" string.
 * - 0    => "00:00"
 * - 90   => "01:30"
 * - 1439 => "23:59"
 * - 1440 => "24:00"  (end-of-day sentinel)
 *
 * Values outside [0, 1440] are clamped to the nearest valid value.
 */
export function minutesToHHMM(minutes: number): string {
  const clamped = Math.max(0, Math.min(1440, Math.round(minutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Parse "HH:MM" to minutes-since-midnight.
 * Returns null if the string is not a valid "HH:MM" in the range [00:00, 24:00].
 */
export function hhmmToMinutes(hhmm: string): number | null {
  if (typeof hhmm !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!match) return null;
  const h = parseInt(match[1]!, 10);
  const m = parseInt(match[2]!, 10);
  if (m < 0 || m > 59) return null;
  const total = h * 60 + m;
  if (total < 0 || total > 1440) return null;
  return total;
}

// ─── Overnight-split helper ────────────────────────────────────────────────────

export interface RawWindow {
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
  tz: string;
}

/**
 * splitOvernightWindow — split a UI-level window that crosses midnight into
 * two windows that the backend can accept (no-wrap: endMinute > startMinute).
 *
 * The backend's CHECK constraint requires end_minute > start_minute, so an
 * overnight entry like 22:00->02:00 must become:
 *   Window A: same day, 22:00 -> 24:00 (endMinute = 1440)
 *   Window B: next day, 00:00 -> 02:00 (startMinute = 0)
 *
 * When the window does NOT cross midnight (endMinute > startMinute), the
 * original single entry is returned as-is (a one-element array).
 *
 * Day wrapping: day 7 (Sunday) wraps to day 1 (Monday).
 */
export function splitOvernightWindow(
  startMinute: number,
  endMinute: number,
  dayOfWeek: number,
  tz: string,
): RawWindow[] {
  // No split needed - standard same-day window.
  if (endMinute > startMinute) {
    return [{ dayOfWeek, startMinute, endMinute, tz }];
  }

  // Overnight: endMinute <= startMinute -> split into two rows.
  const windowA: RawWindow = {
    dayOfWeek,
    startMinute,
    endMinute: 1440,
    tz,
  };

  // Next day: day 7 wraps to day 1.
  const nextDay = dayOfWeek === 7 ? 1 : dayOfWeek + 1;
  const windowB: RawWindow = {
    dayOfWeek: nextDay,
    startMinute: 0,
    endMinute: endMinute === 0 ? 1440 : endMinute,
    tz,
  };

  return [windowA, windowB];
}

// ─── Format a window as "HH:MM - HH:MM" ──────────────────────────────────────

/** Format a window's start/end minutes as a display string "HH:MM - HH:MM". */
export function formatWindowRange(startMinute: number, endMinute: number): string {
  return `${minutesToHHMM(startMinute)}–${minutesToHHMM(endMinute)}`;
}

// ─── Group windows by day ──────────────────────────────────────────────────────

export interface WindowsByDay {
  dayOfWeek: number;
  label: string;
  windows: Array<{
    id: string;
    startMinute: number;
    endMinute: number;
    tz: string;
    range: string;
  }>;
}

/**
 * Group a flat list of serialized availability windows by day-of-week,
 * Mon-Sun (ISO order 1-7), including only days that have at least one window.
 */
export function groupWindowsByDay(
  windows: Array<{
    id: string;
    dayOfWeek: number;
    startMinute: number;
    endMinute: number;
    tz: string;
  }>,
): WindowsByDay[] {
  const map = new Map<number, WindowsByDay>();

  for (const w of windows) {
    let group = map.get(w.dayOfWeek);
    if (!group) {
      group = {
        dayOfWeek: w.dayOfWeek,
        label: dowLabel(w.dayOfWeek),
        windows: [],
      };
      map.set(w.dayOfWeek, group);
    }
    group.windows.push({
      id: w.id,
      startMinute: w.startMinute,
      endMinute: w.endMinute,
      tz: w.tz,
      range: formatWindowRange(w.startMinute, w.endMinute),
    });
  }

  // Sort by ISO day order (1=Mon ... 7=Sun).
  return Array.from(map.values()).sort((a, b) => a.dayOfWeek - b.dayOfWeek);
}
