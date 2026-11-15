/**
 * csv-format.test.ts — report CSV cells (lib/csv-format.ts).
 *
 * csvDate: a bucket start stays its UTC day ([VERIFY-R1-TZ]); an event
 * instant, given the viewer's zone, is the day it happened for them — the date
 * the page shows beside it, not the server's UTC date.
 */
import { describe, it, expect } from 'vitest';
import { csvDate, csvFilename } from '../csv-format';

describe('csvDate', () => {
  it('without a zone: the UTC calendar date (report buckets)', () => {
    expect(csvDate('2026-11-16T00:00:00.000Z')).toBe('2026-11-16');
    expect(csvDate('2026-11-16T01:00:00.000Z')).toBe('2026-11-16');
  });

  it('with the viewer\'s zone: the local day of the event', () => {
    // 19:00 CST on Nov 15 = 01:00 UTC on Nov 16.
    expect(csvDate('2026-11-16T01:00:00.000Z', 'America/Chicago')).toBe('2026-11-15');
    expect(csvDate('2026-11-15T12:00:00.000Z', 'Pacific/Auckland')).toBe('2026-11-16');
    expect(csvDate('2026-11-16T01:00:00.000Z', 'UTC')).toBe('2026-11-16');
  });

  it('an unreadable instant falls back to its first ten characters', () => {
    expect(csvDate('not-a-date', 'America/Chicago')).toBe('not-a-date');
  });
});

describe('csvFilename', () => {
  it('names the file by slug and UTC year-month', () => {
    expect(csvFilename('bravo', new Date('2026-11-15T12:00:00Z'))).toBe('aeroops-bravo-2026-11.csv');
  });
});
