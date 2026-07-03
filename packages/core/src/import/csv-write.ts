/**
 * import/csv-write.ts — dependency-free CSV serializer, companion to
 * import/csv.ts (the parser). PURE: no I/O, no clock, no DB. Never throws.
 *
 * serializeCsv(rows) — RFC-4180 quoting; round-trips with parseCsv (see
 * csv-write.test.ts's property suite): parseCsv(serializeCsv(grid)) reproduces
 * grid's data rows (treating grid[0] as the header) field-for-field.
 *
 * neutralizeCsvFormula(field) — spreadsheet-injection guard for operator
 * free-text columns opened in Excel/Sheets/Numbers. A field beginning with
 * `=` `+` `-` `@` or a leading TAB/CR is prefixed with a single `'` so the
 * spreadsheet application renders it as literal text rather than evaluating
 * it as a formula. Deliberately kept OUT of serializeCsv itself so the
 * round-trip property (serialize→parse reproduces the exact original field)
 * stays clean; callers apply it explicitly to the specific free-text columns
 * that need it (see logbook/internal.ts pilotLogToCsvRows).
 */

const NEEDS_QUOTING_RE = /["\n\r,]/;

/**
 * quoteField — wraps a field in double quotes iff it contains a double quote,
 * comma, or newline (CR or LF); embedded double quotes are doubled.
 */
function quoteField(field: string): string {
  if (!NEEDS_QUOTING_RE.test(field)) return field;
  return `"${field.replace(/"/g, '""')}"`;
}

/**
 * serializeCsv — turns a grid of string rows into RFC-4180 CSV text. Rows are
 * joined with CRLF; a trailing CRLF follows the last row (matches common
 * spreadsheet-export convention and is tolerated by parseCsv either way).
 * An empty grid (`[]`) serializes to `''`.
 */
export function serializeCsv(rows: string[][]): string {
  if (rows.length === 0) return '';
  return rows.map((row) => row.map(quoteField).join(',')).join('\r\n') + '\r\n';
}

const LEADING_FORMULA_CHAR_RE = /^[=+\-@\t\r]/;

/**
 * neutralizeCsvFormula — spreadsheet-injection guard. If `field`'s first
 * character could be interpreted by Excel/Sheets/Numbers as the start of a
 * formula (`=`, `+`, `-`, `@`, or a leading TAB/CR), prefix a single `'` so it
 * is treated as literal text. Empty string and otherwise-normal strings are
 * returned unchanged. Never throws.
 */
export function neutralizeCsvFormula(field: string): string {
  if (field.length === 0) return field;
  if (LEADING_FORMULA_CHAR_RE.test(field)) return `'${field}`;
  return field;
}
