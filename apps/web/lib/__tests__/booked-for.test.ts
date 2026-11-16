/**
 * booked-for.test.ts — how the schedule names the member a booking is for
 * (lib/booked-for.ts; ReservationRow.memberDisplayName, migration 0051).
 *
 * The list card, the board block and the month chip read the same helpers:
 * a booking made for a member says "for Riley Member"; a booking that names no
 * one reads exactly as it did before.
 */
import { describe, it, expect } from 'vitest';
import { bookedForLabel, boardBlockSecondLine, monthChipPeople } from '../booked-for';

describe('bookedForLabel (list card line, board + chip labels)', () => {
  it('names the member', () => {
    expect(bookedForLabel('Riley Member')).toBe('for Riley Member');
  });

  it('a booking for no one has no label', () => {
    expect(bookedForLabel(null)).toBeNull();
    expect(bookedForLabel(undefined)).toBeNull();
    expect(bookedForLabel('  ')).toBeNull();
  });

  it('an e-mail display name (no full name on file) is used as is', () => {
    expect(bookedForLabel('riley@example.com')).toBe('for riley@example.com');
  });
});

describe('boardBlockSecondLine', () => {
  it('leads with the member, then the linked resources', () => {
    expect(boardBlockSecondLine('Riley Member', 'Morgan Ellis (CFI)')).toBe(
      'for Riley Member · Morgan Ellis (CFI)',
    );
  });

  it('the member alone when the booking holds one resource', () => {
    expect(boardBlockSecondLine('Riley Member', '')).toBe('for Riley Member');
  });

  it('without a member it is the partner line exactly as before', () => {
    expect(boardBlockSecondLine(null, 'Morgan Ellis (CFI)')).toBe('Morgan Ellis (CFI)');
    expect(boardBlockSecondLine(null, '')).toBe('');
  });
});

describe('monthChipPeople', () => {
  it('names the member in place of the booker; the title and aria-label carry both', () => {
    expect(monthChipPeople('Riley Member', 'Casey Scheduler')).toEqual({
      segment: 'for Riley M.',
      title: 'for Riley Member · booked by Casey Scheduler',
      ariaClause: ', for Riley Member, booked by Casey Scheduler',
    });
  });

  it('names the member when the viewer cannot read the booker (no member list)', () => {
    expect(monthChipPeople('Riley Member', undefined)).toEqual({
      segment: 'for Riley M.',
      title: 'for Riley Member',
      ariaClause: ', for Riley Member',
    });
  });

  it('a booking for no one keeps the booker short name and no title, as before', () => {
    expect(monthChipPeople(null, 'Casey Scheduler')).toEqual({
      segment: 'Casey S.',
      title: undefined,
      ariaClause: ', booked by Casey Scheduler',
    });
    expect(monthChipPeople(null, undefined)).toEqual({
      segment: null,
      title: undefined,
      ariaClause: '',
    });
  });
});
