/**
 * import/csv.ts — dependency-free, RFC-4180-ish CSV parser (Slice P1.7).
 *
 * PURE: no I/O, no clock, no DB. Never throws — malformed/garbage input is
 * parsed on a best-effort basis and always terminates with a result (this is
 * the FIRST thing an operator-uploaded file touches, so it must be robust to
 * arbitrary bytes).
 *
 * Supports:
 *   - quoted fields (commas/newlines/quotes inside "...")
 *   - "" as an escaped quote inside a quoted field
 *   - CRLF and bare LF line endings (mixed within one file is tolerated)
 *   - a header row (first non-empty line) — every subsequent row is
 *     objectified as { [header]: value }, keyed by header name
 *   - short rows (fewer fields than headers) → missing fields default to ''
 *   - long rows (more fields than headers) → extra fields are dropped
 *   - a wholly blank line (no commas at all) is treated as "no row" and
 *     skipped — this matches common CSV parser behavior (e.g. Python's csv
 *     module) but means a genuine single-column table whose one row value is
 *     empty is indistinguishable from a blank separator line and is also
 *     skipped. Real operator exports are always multi-column, so this
 *     trade-off never bites in practice.
 *   - a trailing blank line is ignored
 *
 * NOT supported (deliberately out of scope for an operator CSV export):
 *   - alternate delimiters (semicolon/tab) — Flight Circle exports comma-
 *     delimited CSV; a delimiter-detection seam can be added later if needed.
 *   - byte-order-mark stripping is handled (a leading U+FEFF on the first
 *     header is stripped) since spreadsheet exports commonly add one.
 */

export interface ParsedCsv {
  /** Header names in file order (BOM-stripped, NOT trimmed — see guessColumnMapping for matching). */
  headers: string[];
  /** One object per data row, keyed by header name. */
  rows: Record<string, string>[];
}

const BOM = '﻿';

/**
 * parseCsvLines — the core character-by-character DFA. Returns an array of
 * "fields per line" (string[][]), handling quoting across embedded newlines.
 * NEVER throws.
 */
function parseCsvLines(text: string): string[][] {
  const lines: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  let sawAnyFieldThisRow = false;

  const endField = () => {
    row.push(field);
    field = '';
    sawAnyFieldThisRow = true;
  };
  const endRow = () => {
    endField();
    // Drop a wholly-empty trailing/blank line (single empty field, no commas).
    if (!(row.length === 1 && row[0] === '')) {
      lines.push(row);
    }
    row = [];
    sawAnyFieldThisRow = false;
  };

  while (i < n) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      // A quote starting a field (ignore stray quotes mid-unquoted-field by
      // just entering quote mode — best-effort, never throws).
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      // Peek for \r\n; either way this ends the row.
      if (text[i + 1] === '\n') i += 1;
      endRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // Flush a trailing field/row that wasn't newline-terminated.
  if (field !== '' || sawAnyFieldThisRow || row.length > 0) {
    endRow();
  }

  return lines;
}

/**
 * parseCsv — parse CSV text into a header list + objectified rows.
 * Empty/whitespace-only input → { headers: [], rows: [] }. NEVER throws.
 */
export function parseCsv(text: string): ParsedCsv {
  if (typeof text !== 'string' || text.length === 0) {
    return { headers: [], rows: [] };
  }

  let src = text;
  if (src.charCodeAt(0) === 0xfeff || src.startsWith(BOM)) {
    src = src.slice(1);
  }

  const lines = parseCsvLines(src);
  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const headers = lines[0]!.map((h) => (typeof h === 'string' ? h : ''));
  const rows: Record<string, string>[] = [];

  for (let r = 1; r < lines.length; r++) {
    const fields = lines[r]!;
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]!] = fields[c] ?? '';
    }
    rows.push(obj);
  }

  return { headers, rows };
}
