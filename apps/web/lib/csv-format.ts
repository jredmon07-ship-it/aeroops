/**
 * csv-format.ts — pure cell formatters for building report CSV grids.
 *
 * DISPLAY-ONLY. Dates are emitted as YYYY-MM-DD (the report grain), derived
 * from an ISO timestamp string.
 */

/** ISO timestamp string → "YYYY-MM-DD" (UTC calendar date). */
export function csvDate(iso: string): string {
  return iso.slice(0, 10);
}

/** "aeroops-<slug>-YYYY-MM.csv" — stable, spreadsheet-friendly report filename. */
export function csvFilename(slug: string, now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `aeroops-${slug}-${y}-${m}.csv`;
}
