/**
 * csv-format.ts — pure cell formatters for building report CSV grids.
 *
 * DISPLAY-ONLY. Dates are emitted as YYYY-MM-DD (the report grain), derived
 * from an ISO timestamp string.
 */

import { dayInZone } from './schedule-day';

/**
 * ISO timestamp string → "YYYY-MM-DD".
 *
 * Without `timeZone`: the UTC calendar date — right for report buckets, which
 * start at UTC midnight ([VERIFY-R1-TZ]). With the viewer's zone: the day the
 * event happened for them, the same date the page shows beside it (a squawk
 * reported at 19:00 CST on Nov 15 is the 15th, though its UTC date is the 16th).
 */
export function csvDate(iso: string, timeZone?: string): string {
  if (timeZone === undefined) return iso.slice(0, 10);
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso.slice(0, 10);
  try {
    return dayInZone(at, timeZone);
  } catch {
    return iso.slice(0, 10);
  }
}

/** "aeroops-<slug>-YYYY-MM.csv" — stable, spreadsheet-friendly report filename. */
export function csvFilename(slug: string, now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `aeroops-${slug}-${y}-${m}.csv`;
}
