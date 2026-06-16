/**
 * _utils/format-time.ts — Local time formatting helpers for the schedule module.
 *
 * Uses Intl.DateTimeFormat for locale-aware formatting. All times displayed in
 * local 24h format per spec §3 ("HH:mm – HH:mm").
 */

/**
 * formatTimeRange — formats a start+end pair as "HH:mm – HH:mm" in local time.
 *
 * @param start - Date object for the start of the window.
 * @param end   - Date object for the end of the window.
 * @returns     - e.g. "09:30 – 11:00"
 */
export function formatTimeRange(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  const fmt = new Intl.DateTimeFormat(undefined, opts);
  return `${fmt.format(start)} – ${fmt.format(end)}`;
}

/**
 * formatTime — formats a single Date as "HH:mm" in local time.
 */
export function formatTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

/**
 * formatDate — formats a Date as a human-readable date string.
 * e.g. "Monday, June 16, 2026"
 */
export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(date);
}

/**
 * toDateInputValue — formats a Date as "YYYY-MM-DD" for <input type="date">.
 */
export function toDateInputValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * parseDateParam — parses a "YYYY-MM-DD" string and returns a Date at local
 * midnight, or null if invalid.
 */
export function parseDateParam(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00`);
  if (isNaN(parsed.getTime())) return null;
  return parsed;
}

/**
 * startOfDay — returns a new Date at 00:00:00.000 for the given date.
 */
export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * endOfDay — returns a new Date at 23:59:59.999 for the given date.
 */
export function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * addDays — returns a new Date offset by `days` days.
 */
export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
