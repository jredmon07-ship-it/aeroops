/**
 * import.test.ts — property + example tests for the Slice P1.7 pure CSV /
 * column-mapping / normalize layer.
 *
 * COVERAGE:
 *   parseCsv:
 *     - never throws on arbitrary string input (fuzzing).
 *     - round-trips a generated table (headers + rows) through a hand-built
 *       CSV serializer with correct RFC-4180 quoting.
 *     - quoting edge cases: embedded commas, quotes, CRLF/LF, empty fields.
 *   guessColumnMapping:
 *     - realistic Flight-Circle-ish header sets map as expected.
 *     - never throws / never double-maps one header to two fields.
 *   looksLikeSalesTransactionsExport:
 *     - a ledger-shaped header set is detected; a roster-shaped one is not.
 *   normalizeMemberRow / normalizeAircraftRow:
 *     - never throw on arbitrary/garbage input.
 *     - idempotent: normalizing the same effective row twice yields the same
 *       dedupeKey.
 *     - required-field enforcement (missing email / missing tail number).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseCsv } from '../import/csv.js';
import {
  guessColumnMapping,
  looksLikeSalesTransactionsExport,
} from '../import/column-mapping.js';
import { normalizeMemberRow, normalizeAircraftRow } from '../import/normalize.js';

// ─── CSV serializer (test-only helper, mirrors RFC-4180 quoting) ─────────────

function toCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function toCsvText(headers: string[], rows: string[][]): string {
  const lines = [headers, ...rows].map((r) => r.map(toCsvField).join(','));
  return lines.join('\r\n');
}

// Safe-ish arbitrary field: printable, may include comma/quote/newline.
const fieldArb = fc.string({ maxLength: 12 }).filter((s) => !s.includes(' '));

// Distinct, non-empty header names (letters/digits only) so object-key
// round-trip is unambiguous.
const headerArb = fc
  .string({ minLength: 1, maxLength: 10 })
  .map((s) => s.replace(/[^a-zA-Z0-9]/g, 'x') || 'h')
  .filter((s) => s.length > 0);

describe('parseCsv', () => {
  it('never throws on arbitrary string input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (text) => {
        expect(() => parseCsv(text)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  it('never throws on non-string-ish edge inputs', () => {
    // @ts-expect-error — deliberately exercising the runtime guard.
    expect(() => parseCsv(undefined)).not.toThrow();
    // @ts-expect-error — deliberately exercising the runtime guard.
    expect(() => parseCsv(null)).not.toThrow();
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
  });

  it('round-trips explicit rows matching header width', () => {
    // minLength: 2 headers — a single-column table whose one row value is
    // empty is indistinguishable from a blank separator line (both are just
    // an empty text line); parseCsv deliberately treats a wholly-blank line
    // as "no row" (matching common CSV parser behavior, e.g. Python's csv
    // module), so that ambiguous case is excluded from this round-trip check.
    fc.assert(
      fc.property(
        fc.uniqueArray(headerArb, { minLength: 2, maxLength: 5 }).chain((headers) =>
          fc.tuple(
            fc.constant(headers),
            fc.array(fc.array(fieldArb, { minLength: headers.length, maxLength: headers.length }), {
              minLength: 0,
              maxLength: 8,
            }),
          ),
        ),
        ([headers, rows]) => {
          const text = toCsvText(headers, rows);
          const parsed = parseCsv(text);
          expect(parsed.headers).toEqual(headers);
          expect(parsed.rows.length).toBe(rows.length);
          for (let i = 0; i < rows.length; i++) {
            for (let c = 0; c < headers.length; c++) {
              expect(parsed.rows[i]![headers[c]!]).toBe(rows[i]![c]);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('handles quoted fields with embedded commas, quotes, and newlines', () => {
    const text = 'name,note\r\n"Doe, Jane","She said ""hi""\nnew line"\r\nBob,plain\n';
    const parsed = parseCsv(text);
    expect(parsed.headers).toEqual(['name', 'note']);
    expect(parsed.rows).toEqual([
      { name: 'Doe, Jane', note: 'She said "hi"\nnew line' },
      { name: 'Bob', note: 'plain' },
    ]);
  });

  it('short rows default missing fields to empty string; long rows drop extras', () => {
    const text = 'a,b,c\n1,2\n1,2,3,4\n';
    const parsed = parseCsv(text);
    expect(parsed.rows).toEqual([
      { a: '1', b: '2', c: '' },
      { a: '1', b: '2', c: '3' },
    ]);
  });

  it('strips a leading BOM from the header row', () => {
    const parsed = parseCsv('﻿email,name\na@b.com,A\n');
    expect(parsed.headers).toEqual(['email', 'name']);
  });

  it('ignores a trailing blank line', () => {
    const parsed = parseCsv('email\na@b.com\n\n');
    expect(parsed.rows).toEqual([{ email: 'a@b.com' }]);
  });
});

describe('guessColumnMapping', () => {
  it('maps a realistic Flight-Circle-ish member export header set', () => {
    const headers = ['Full Name', 'Email Address', 'Phone Number', 'Member Since'];
    const mapping = guessColumnMapping(headers, 'members');
    expect(mapping['email']).toBe('Email Address');
    expect(mapping['fullName']).toBe('Full Name');
    expect(mapping['phone']).toBe('Phone Number');
  });

  it('maps a realistic aircraft export header set', () => {
    const headers = ['Tail Number', 'Make', 'Model', 'Year', 'Serial Number'];
    const mapping = guessColumnMapping(headers, 'aircraft');
    expect(mapping['tailNumber']).toBe('Tail Number');
    expect(mapping['make']).toBe('Make');
    expect(mapping['model']).toBe('Model');
    expect(mapping['year']).toBe('Year');
    expect(mapping['serialNumber']).toBe('Serial Number');
  });

  it('maps N-Number / Registration / Reg / Aircraft ID variants', () => {
    expect(guessColumnMapping(['N-Number', 'Make'], 'aircraft')['tailNumber']).toBe('N-Number');
    expect(guessColumnMapping(['Registration', 'Make'], 'aircraft')['tailNumber']).toBe('Registration');
    expect(guessColumnMapping(['Reg', 'Make'], 'aircraft')['tailNumber']).toBe('Reg');
    expect(guessColumnMapping(['Aircraft ID', 'Make'], 'aircraft')['tailNumber']).toBe('Aircraft ID');
  });

  it('maps myFBO-ish member header wording (Member Name / E-mail / Cell Phone)', () => {
    const mapping = guessColumnMapping(['Member Name', 'E-mail', 'Cell Phone', 'Member Type'], 'members');
    expect(mapping['email']).toBe('E-mail');
    expect(mapping['fullName']).toBe('Member Name');
    expect(mapping['phone']).toBe('Cell Phone');
  });

  it('maps terse header wording (Name / Mail / Tel)', () => {
    const mapping = guessColumnMapping(['Name', 'Mail', 'Tel'], 'members');
    expect(mapping['email']).toBe('Mail');
    expect(mapping['fullName']).toBe('Name');
    expect(mapping['phone']).toBe('Tel');
  });

  it('does NOT mis-map "Mailing Address" to email when a real Email column exists', () => {
    const mapping = guessColumnMapping(['Full Name', 'Mailing Address', 'Email'], 'members');
    expect(mapping['email']).toBe('Email');
  });

  it('maps myFBO-ish aircraft header wording (Aircraft Type / Manufacturer / Serial #)', () => {
    const mapping = guessColumnMapping(
      ['Aircraft ID', 'Manufacturer', 'Aircraft Type', 'Year', 'Serial #'],
      'aircraft',
    );
    expect(mapping['tailNumber']).toBe('Aircraft ID');
    expect(mapping['make']).toBe('Manufacturer');
    expect(mapping['model']).toBe('Aircraft Type');
    expect(mapping['year']).toBe('Year');
    expect(mapping['serialNumber']).toBe('Serial #');
  });

  it('ambiguous header matching two fields is claimed by exactly one (priority order)', () => {
    // "Name Email" matches BOTH the email pattern and the name pattern; email
    // is the higher-priority field, so it wins and the header is used once.
    const mapping = guessColumnMapping(['Name Email'], 'members');
    expect(mapping['email']).toBe('Name Email');
    expect(mapping['fullName']).toBeNull();
  });

  it('leaves every aircraft field null when nothing matches', () => {
    const mapping = guessColumnMapping(['Color', 'Notes', 'Owner'], 'aircraft');
    expect(mapping['tailNumber']).toBeNull();
    expect(mapping['make']).toBeNull();
    expect(mapping['model']).toBeNull();
    expect(mapping['year']).toBeNull();
    expect(mapping['serialNumber']).toBeNull();
  });

  it('leaves unmatched fields null', () => {
    const mapping = guessColumnMapping(['Unrelated Column'], 'members');
    expect(mapping['email']).toBeNull();
    expect(mapping['fullName']).toBeNull();
    expect(mapping['phone']).toBeNull();
  });

  it('never double-maps one header to two fields, and never throws', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 20 }), { maxLength: 20 }), (headers) => {
        const mapping = guessColumnMapping(headers, 'members');
        const claimed = Object.values(mapping).filter((v): v is string => v !== null);
        expect(new Set(claimed).size).toBe(claimed.length);
      }),
      { numRuns: 200 },
    );
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 20 }), { maxLength: 20 }), (headers) => {
        expect(() => guessColumnMapping(headers, 'aircraft')).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });
});

describe('looksLikeSalesTransactionsExport', () => {
  it('detects a ledger-shaped header set', () => {
    expect(
      looksLikeSalesTransactionsExport(['Date', 'Transaction Type', 'Amount', 'Balance']),
    ).toBe(true);
  });

  it('does not flag a roster-shaped header set', () => {
    expect(looksLikeSalesTransactionsExport(['Full Name', 'Email', 'Phone'])).toBe(false);
  });

  it('does not flag an aircraft-shaped header set', () => {
    expect(looksLikeSalesTransactionsExport(['Tail Number', 'Make', 'Model', 'Year'])).toBe(false);
  });

  it('never throws on garbage input', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 30 }), { maxLength: 30 }), (headers) => {
        expect(() => looksLikeSalesTransactionsExport(headers)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });
});

describe('normalizeMemberRow', () => {
  const mapping = { email: 'Email', fullName: 'Name', phone: 'Phone' };

  it('accepts a valid row', () => {
    const result = normalizeMemberRow(
      { Email: 'Jane@Example.com', Name: ' Jane Doe ', Phone: '555-1234' },
      mapping,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.email).toBe('jane@example.com');
      expect(result.value.fullName).toBe('Jane Doe');
      expect(result.value.phone).toBe('555-1234');
      expect(result.dedupeKey).toBe('jane@example.com');
    }
  });

  it('skips a row with a missing email', () => {
    const result = normalizeMemberRow({ Email: '', Name: 'Jane' }, mapping);
    expect(result).toEqual({ ok: false, reason: 'missing_email' });
  });

  it('skips a row with an invalid email', () => {
    const result = normalizeMemberRow({ Email: 'not-an-email' }, mapping);
    expect(result).toEqual({ ok: false, reason: 'invalid_email' });
  });

  it('is dedupe-key-idempotent for the same effective email regardless of case/whitespace', () => {
    const a = normalizeMemberRow({ Email: 'A@B.com' }, mapping);
    const b = normalizeMemberRow({ Email: ' a@b.com ' }, mapping);
    expect(a.ok && b.ok && a.dedupeKey === b.dedupeKey).toBe(true);
  });

  it('never throws on arbitrary/garbage input', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ maxLength: 10 }), fc.string({ maxLength: 30 })),
        fc.dictionary(fc.string({ maxLength: 10 }), fc.option(fc.string({ maxLength: 10 }), { nil: null })),
        (row, badMapping) => {
          expect(() => normalizeMemberRow(row, badMapping as never)).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
    // Wildly wrong types.
    expect(() => normalizeMemberRow(null, mapping)).not.toThrow();
    expect(() => normalizeMemberRow(undefined, mapping)).not.toThrow();
    // @ts-expect-error — deliberately exercising the runtime guard.
    expect(() => normalizeMemberRow('not an object', mapping)).not.toThrow();
    // @ts-expect-error — deliberately exercising the runtime guard.
    expect(() => normalizeMemberRow({ Email: 12345 }, mapping)).not.toThrow();
  });
});

describe('normalizeAircraftRow', () => {
  const mapping = {
    tailNumber: 'Tail',
    make: 'Make',
    model: 'Model',
    year: 'Year',
    serialNumber: 'Serial',
  };

  it('accepts a valid row', () => {
    const result = normalizeAircraftRow(
      { Tail: ' n172sp ', Make: 'Cessna', Model: '172S', Year: '2014', Serial: '172S-11876' },
      mapping,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tailNumber).toBe('N172SP');
      expect(result.value.year).toBe(2014);
      expect(result.dedupeKey).toBe('N172SP');
    }
  });

  it('skips a row with a missing tail number', () => {
    const result = normalizeAircraftRow({ Tail: '', Make: 'Cessna' }, mapping);
    expect(result).toEqual({ ok: false, reason: 'missing_tail_number' });
  });

  it('never hard-fails on an unparsable year — falls back to null', () => {
    const result = normalizeAircraftRow({ Tail: 'N1', Year: 'not a year' }, mapping);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.year).toBeNull();
  });

  it('rejects an out-of-range year (falls back to null, not a skip)', () => {
    const result = normalizeAircraftRow({ Tail: 'N1', Year: '1899' }, mapping);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.year).toBeNull();
  });

  it('is dedupe-key-idempotent for the same effective tail regardless of case/whitespace', () => {
    const a = normalizeAircraftRow({ Tail: 'n 172 sp' }, mapping);
    const b = normalizeAircraftRow({ Tail: 'N172SP' }, mapping);
    expect(a.ok && b.ok && a.dedupeKey === b.dedupeKey).toBe(true);
  });

  it('never throws on arbitrary/garbage input', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string({ maxLength: 10 }), fc.string({ maxLength: 30 })),
        (row) => {
          expect(() => normalizeAircraftRow(row, mapping)).not.toThrow();
        },
      ),
      { numRuns: 200 },
    );
    expect(() => normalizeAircraftRow(null, mapping)).not.toThrow();
    expect(() => normalizeAircraftRow(undefined, mapping)).not.toThrow();
  });
});
