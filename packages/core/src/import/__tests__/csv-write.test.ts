/**
 * csv-write.test.ts — tests for import/csv-write.ts (Slice P2 logbook export).
 *
 * COVERAGE:
 *   [property] round-trip: parseCsv(serializeCsv(grid)) reproduces grid's data
 *     rows (grid[0] treated as header) field-for-field, for random data cells
 *     including commas/quotes/CRLF/unicode. Headers are synthesized
 *     deterministically (h0, h1, ...) to sidestep two DOCUMENTED, unrelated
 *     parseCsv quirks that are not part of what this property is verifying:
 *       (a) a wholly blank single-column line ('' with no commas) is treated
 *           as a blank separator and dropped (see import/csv.ts header doc).
 *       (b) duplicate header names collide when objectifying rows.
 *     Both are pre-existing, tested behaviors of the FROZEN parser, not bugs
 *     in serializeCsv — this test targets serializeCsv's quoting/escaping
 *     correctness on arbitrary field CONTENT, which headers do not affect.
 *   serializeCsv: unit cases for comma, embedded-quote doubling, newline,
 *     empty grid.
 *   neutralizeCsvFormula: prefixes for =+-@/leading TAB/CR; leaves normal and
 *     empty strings unchanged.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseCsv } from '../csv.js';
import { serializeCsv, neutralizeCsvFormula } from '../csv-write.js';

// ════════════════════════════════════════════════════════════════════════════
// [property] round-trip
// ════════════════════════════════════════════════════════════════════════════

describe('[property] serializeCsv/parseCsv round-trip', () => {
  const interestingCell = fc.oneof(
    fc.string({ maxLength: 20 }),
    fc.constantFrom(
      '',
      'a,b',
      'a"b',
      'a\nb',
      'a\r\nb',
      '"quoted"',
      ',',
      '"',
      '\n',
      '\r\n',
      '😀🚀',
      'a,"b"\nc',
      '  leading/trailing spaces  ',
      'tab\ttab',
    ),
  );

  const gridArb = fc.integer({ min: 1, max: 4 }).chain((numCols) => {
    const headers = Array.from({ length: numCols }, (_, i) => `h${i}`);
    return fc
      .array(fc.array(interestingCell, { minLength: numCols, maxLength: numCols }), {
        minLength: 0,
        maxLength: 6,
      })
      .map((dataRows) => ({ numCols, headers, dataRows }));
  });

  it('reproduces data rows field-for-field for arbitrary cell content', () => {
    fc.assert(
      fc.property(gridArb, ({ numCols, headers, dataRows }) => {
        // Documented parser quirk (a): skip the case where a single-column
        // data row's value is the empty string — parseCsv drops that line as
        // a blank separator (see import/csv.ts). Not what this property tests.
        fc.pre(!(numCols === 1 && dataRows.some((r) => r[0] === '')));

        const grid = [headers, ...dataRows];
        const csv = serializeCsv(grid);
        const parsed = parseCsv(csv);

        expect(parsed.headers).toEqual(headers);
        expect(parsed.rows.length).toBe(dataRows.length);
        for (let i = 0; i < dataRows.length; i++) {
          const row = dataRows[i]!;
          const obj = parsed.rows[i]!;
          for (let c = 0; c < numCols; c++) {
            expect(obj[headers[c]!]).toBe(row[c]);
          }
        }
      }),
    );
  });

  it('empty grid serializes to empty string and parses to {headers:[],rows:[]}', () => {
    const csv = serializeCsv([]);
    expect(csv).toBe('');
    expect(parseCsv(csv)).toEqual({ headers: [], rows: [] });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// serializeCsv — unit cases
// ════════════════════════════════════════════════════════════════════════════

describe('serializeCsv', () => {
  it('quotes a field containing a comma', () => {
    expect(serializeCsv([['a,b', 'c']])).toBe('"a,b",c\r\n');
  });

  it('doubles an embedded quote and wraps the field', () => {
    expect(serializeCsv([['say "hi"']])).toBe('"say ""hi"""\r\n');
  });

  it('quotes a field containing a newline (LF)', () => {
    expect(serializeCsv([['line1\nline2']])).toBe('"line1\nline2"\r\n');
  });

  it('quotes a field containing a CRLF', () => {
    expect(serializeCsv([['line1\r\nline2']])).toBe('"line1\r\nline2"\r\n');
  });

  it('leaves a plain field unquoted', () => {
    expect(serializeCsv([['plain']])).toBe('plain\r\n');
  });

  it('joins multiple rows with CRLF and trails a final CRLF', () => {
    expect(serializeCsv([['a', 'b'], ['c', 'd']])).toBe('a,b\r\nc,d\r\n');
  });

  it('empty grid → empty string', () => {
    expect(serializeCsv([])).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// neutralizeCsvFormula — unit cases
// ════════════════════════════════════════════════════════════════════════════

describe('neutralizeCsvFormula', () => {
  it.each(['=SUM(A1:A2)', '+1234', '-1234', '@cmd', '\ttabbed', '\rcr'])(
    'prefixes a leading %s with a single quote',
    (input) => {
      expect(neutralizeCsvFormula(input)).toBe(`'${input}`);
    },
  );

  it('leaves a normal string unchanged', () => {
    expect(neutralizeCsvFormula('N12345')).toBe('N12345');
  });

  it('leaves an empty string unchanged', () => {
    expect(neutralizeCsvFormula('')).toBe('');
  });

  it('leaves a string with an internal (non-leading) formula char unchanged', () => {
    expect(neutralizeCsvFormula('Cessna 172 (=trainer)')).toBe('Cessna 172 (=trainer)');
  });
});
