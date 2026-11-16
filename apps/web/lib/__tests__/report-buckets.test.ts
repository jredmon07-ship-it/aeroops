/**
 * report-buckets.test.ts — the calendar day a report bucket covers
 * (lib/report-buckets.ts, [VERIFY-R1-TZ]).
 *
 * A bucket's start is the first instant of a local day in the zone the read
 * bucketed in. Its label and CSV row must be THAT day — east of UTC the
 * instant's UTC date is the day before.
 */
import { describe, it, expect } from 'vitest';
import { bucketDay, formatBucketDayShort } from '../report-buckets';

describe('bucketDay', () => {
  it('Chicago: the bucket starting 06:00Z covers Nov 15', () => {
    expect(bucketDay('2026-11-15T06:00:00.000Z', 'America/Chicago')).toBe('2026-11-15');
  });

  it('Berlin: the bucket starting 23:00Z on the 14th covers Nov 15 (not its UTC date)', () => {
    expect(bucketDay('2026-11-14T23:00:00.000Z', 'Europe/Berlin')).toBe('2026-11-15');
  });

  it('the 25-hour fall-back day and a local Monday read as their own days', () => {
    expect(bucketDay('2026-11-01T05:00:00.000Z', 'America/Chicago')).toBe('2026-11-01');
    expect(bucketDay('2026-11-02T06:00:00.000Z', 'America/Chicago')).toBe('2026-11-02');
    expect(bucketDay('2026-11-09T06:00:00.000Z', 'America/Chicago')).toBe('2026-11-09');
  });

  it('no zone echoed (the rolling UTC default): the UTC date', () => {
    expect(bucketDay('2026-11-16T00:00:00.000Z', undefined)).toBe('2026-11-16');
  });

  it('never throws: an unknown zone or an unreadable instant gives the first ten characters', () => {
    expect(bucketDay('2026-11-14T23:00:00.000Z', 'Mars/Olympus_Mons')).toBe('2026-11-14');
    expect(bucketDay('not-a-date', 'America/Chicago')).toBe('not-a-date');
  });
});

describe('formatBucketDayShort', () => {
  it('month/day without padding', () => {
    expect(formatBucketDayShort('2026-11-15')).toBe('11/15');
    expect(formatBucketDayShort('2027-01-05')).toBe('1/5');
  });

  it('anything that is not a YYYY-MM-DD day → empty label', () => {
    expect(formatBucketDayShort('')).toBe('');
    expect(formatBucketDayShort('2026-11-15T06:00:00.000Z')).toBe('');
    expect(formatBucketDayShort('garbage')).toBe('');
  });
});
