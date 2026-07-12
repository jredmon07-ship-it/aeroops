/**
 * csv-format.ts — pure cell formatters for building report CSV grids.
 *
 * DISPLAY-ONLY. Money is emitted as a plain decimal string (no "$", no thousands
 * separators) so a spreadsheet reads it as a number; integer cents stay the
 * source of truth upstream (@aeroops/core). Dates are emitted as YYYY-MM-DD
 * (the report grain), derived from an ISO timestamp string.
 */

/** Integer cents → plain decimal dollars, e.g. 45999 → "459.99". */
export function centsToAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${(abs / 100).toFixed(2)}`;
}

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
