/**
 * member-schedule-view.test.ts — the member Schedule's day view model
 * (app/o/[slug]/(shell)/portal/schedule/_utils/member-schedule-view.ts).
 *
 * COVERAGE:
 *   1. Labels — someone else's booking "Booked", a blackout "Unavailable",
 *      the member's own "Your booking"; a redacted interval never grows notes
 *      or "with …" labels; the member's own carries its notes (trimmed) and
 *      the booking's OTHER resources.
 *   2. Times in the viewer's zone — the same instant reads 09:00 in Chicago,
 *      16:00 in Berlin, 15:00 in UTC; summer offsets too.
 *   3. Over midnight — a side outside the viewed day carries its date; an end
 *      exactly at the next midnight does not.
 *   4. Sorting — aircraft before instructors, natural tail-# order (N2 before
 *      N10), instructors by name; intervals by start, end, then mine first.
 *   5. Guards — intervals outside the day (half-open) or naming an unknown
 *      resource are dropped; nothingBooked; keys unique.
 *   6. aircraftDetail — make + model, either alone, neither → null.
 *
 * PURE unit tests — no DOM, no Next.js, no DB.
 */
import { describe, it, expect } from 'vitest';
import type {
  MemberAvailabilityInterval,
  MemberAvailabilityResource,
  MemberAvailabilityResult,
} from '@aeroops/api';
import { dayWindow } from '../schedule-day';
import {
  aircraftDetail,
  buildMemberScheduleView,
  intervalKind,
  intervalLabel,
  intervalTimeText,
} from '../../app/o/[slug]/(shell)/portal/schedule/_utils/member-schedule-view';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CHICAGO = 'America/Chicago';
/** Monday 2026-11-16 in Chicago (CST, UTC-6): 06:00Z → 06:00Z next day. */
const DAY = dayWindow('2026-11-16', CHICAGO);

const z = (iso: string) => new Date(iso);

function aircraft(id: string, label: string, extra: Partial<MemberAvailabilityResource> = {}): MemberAvailabilityResource {
  return { id, kind: 'aircraft', label, make: null, model: null, grounded: false, ...extra };
}

function instructor(id: string, label: string): MemberAvailabilityResource {
  return { id, kind: 'instructor', label, make: null, model: null, grounded: false };
}

function busy(
  resourceId: string,
  startIso: string,
  endIso: string,
  kind: 'booked' | 'unavailable' = 'booked',
): MemberAvailabilityInterval {
  // Exactly the four keys the API sends for someone else's time.
  return { resourceId, startAt: z(startIso), endAt: z(endIso), kind };
}

function mine(
  resourceId: string,
  startIso: string,
  endIso: string,
  notes: string | null,
  resourceLabels: string[],
): MemberAvailabilityInterval {
  return { resourceId, startAt: z(startIso), endAt: z(endIso), kind: 'booked', mine: true, notes, resourceLabels };
}

function result(
  resources: MemberAvailabilityResource[],
  intervals: MemberAvailabilityInterval[],
): MemberAvailabilityResult {
  return { resources, intervals };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Labels — redacted vs mine
// ═════════════════════════════════════════════════════════════════════════════

describe('1. labels: Booked / Unavailable / Your booking', () => {
  it('intervalKind + intervalLabel read the API shape', () => {
    const other = busy('a1', '2026-11-16T15:00:00Z', '2026-11-16T17:00:00Z');
    const blackout = busy('a1', '2026-11-16T18:00:00Z', '2026-11-16T19:00:00Z', 'unavailable');
    const own = mine('a1', '2026-11-16T20:00:00Z', '2026-11-16T21:00:00Z', null, ['N101']);
    expect([intervalKind(other), intervalLabel(other)]).toEqual(['booked', 'Booked']);
    expect([intervalKind(blackout), intervalLabel(blackout)]).toEqual(['unavailable', 'Unavailable']);
    expect([intervalKind(own), intervalLabel(own)]).toEqual(['mine', 'Your booking']);
  });

  it("someone else's booking and a blackout show no notes and no 'with' labels", () => {
    const view = buildMemberScheduleView(
      result(
        [aircraft('a1', 'N101')],
        [
          busy('a1', '2026-11-16T15:00:00Z', '2026-11-16T17:00:00Z'),
          busy('a1', '2026-11-16T18:00:00Z', '2026-11-16T19:00:00Z', 'unavailable'),
        ],
      ),
      DAY,
      CHICAGO,
    );
    expect(view.aircraft[0]!.intervals.map((i) => [i.kind, i.label, i.notes, i.withLabels])).toEqual([
      ['booked', 'Booked', null, []],
      ['unavailable', 'Unavailable', null, []],
    ]);
  });

  it("the member's own booking: 'Your booking', trimmed notes, and the booking's OTHER resources", () => {
    const view = buildMemberScheduleView(
      result(
        [aircraft('a1', 'N101'), instructor('i1', 'Casey Example (CFI)')],
        [
          mine('a1', '2026-11-16T21:00:00Z', '2026-11-16T23:00:00Z', '  Dual lesson — steep turns  ', [
            'N101',
            'Casey Example (CFI)',
          ]),
          mine('i1', '2026-11-16T21:00:00Z', '2026-11-16T23:00:00Z', '  Dual lesson — steep turns  ', [
            'N101',
            'Casey Example (CFI)',
          ]),
        ],
      ),
      DAY,
      CHICAGO,
    );
    const onAircraft = view.aircraft[0]!.intervals[0]!;
    expect(onAircraft).toMatchObject({
      kind: 'mine',
      label: 'Your booking',
      notes: 'Dual lesson — steep turns',
      withLabels: ['Casey Example (CFI)'],
    });
    expect(view.instructors[0]!.intervals[0]!.withLabels).toEqual(['N101']);
  });

  it('blank notes on your own booking read as none', () => {
    const view = buildMemberScheduleView(
      result([aircraft('a1', 'N101')], [mine('a1', '2026-11-16T21:00:00Z', '2026-11-16T22:00:00Z', '   ', ['N101'])]),
      DAY,
      CHICAGO,
    );
    expect(view.aircraft[0]!.intervals[0]!.notes).toBeNull();
    expect(view.aircraft[0]!.intervals[0]!.withLabels).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Times in the viewer's zone
// ═════════════════════════════════════════════════════════════════════════════

describe("2. times read in the viewer's zone", () => {
  const start = z('2026-11-16T15:00:00Z');
  const end = z('2026-11-16T17:00:00Z');

  it('the same instants read 09:00 – 11:00 in Chicago, 16:00 – 18:00 in Berlin, 15:00 – 17:00 in UTC', () => {
    expect(intervalTimeText(start, end, DAY, CHICAGO)).toBe('09:00 – 11:00');
    expect(intervalTimeText(start, end, dayWindow('2026-11-16', 'Europe/Berlin'), 'Europe/Berlin')).toBe(
      '16:00 – 18:00',
    );
    expect(intervalTimeText(start, end, dayWindow('2026-11-16', 'UTC'), 'UTC')).toBe('15:00 – 17:00');
  });

  it('a summer day uses the summer offset (CDT, UTC-5)', () => {
    const july = dayWindow('2026-07-15', CHICAGO);
    expect(intervalTimeText(z('2026-07-15T15:00:00Z'), z('2026-07-15T16:30:00Z'), july, CHICAGO)).toBe(
      '10:00 – 11:30',
    );
  });

  it('the row view carries the zoned text', () => {
    const view = buildMemberScheduleView(result([aircraft('a1', 'N101')], [busy('a1', '2026-11-16T15:00:00Z', '2026-11-16T17:00:00Z')]), DAY, CHICAGO);
    expect(view.aircraft[0]!.intervals[0]!.time).toBe('09:00 – 11:00');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Over midnight
// ═════════════════════════════════════════════════════════════════════════════

describe('3. bookings over midnight keep their real times, with the date outside the day', () => {
  it('a start the evening before carries its date', () => {
    // 04:00Z = Nov 15 22:00 CST; 07:00Z = Nov 16 01:00 CST.
    expect(intervalTimeText(z('2026-11-16T04:00:00Z'), z('2026-11-16T07:00:00Z'), DAY, CHICAGO)).toBe(
      'Nov 15 22:00 – 01:00',
    );
  });

  it('an end the next morning carries its date', () => {
    // 05:00Z Nov 17 = Nov 16 23:00 CST; 08:00Z = Nov 17 02:00 CST.
    expect(intervalTimeText(z('2026-11-17T05:00:00Z'), z('2026-11-17T08:00:00Z'), DAY, CHICAGO)).toBe(
      '23:00 – Nov 17 02:00',
    );
  });

  it('both sides outside (an all-day blackout) carry both dates', () => {
    expect(intervalTimeText(z('2026-11-15T12:00:00Z'), z('2026-11-18T12:00:00Z'), DAY, CHICAGO)).toBe(
      'Nov 15 06:00 – Nov 18 06:00',
    );
  });

  it('an end exactly at the next midnight is still this day: no date', () => {
    expect(intervalTimeText(z('2026-11-17T04:00:00Z'), DAY.to, DAY, CHICAGO)).toBe('22:00 – 00:00');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Sorting
// ═════════════════════════════════════════════════════════════════════════════

describe('4. sorting', () => {
  it('aircraft first in natural tail-# order, then instructors by name — whatever the input order', () => {
    const view = buildMemberScheduleView(
      result(
        [
          instructor('i2', 'Morgan Ellis (CFI)'),
          aircraft('a10', 'N10'),
          instructor('i1', 'casey Reed (CFI)'),
          aircraft('a100', 'N100'),
          aircraft('a2', 'N2'),
        ],
        [],
      ),
      DAY,
      CHICAGO,
    );
    expect(view.aircraft.map((r) => r.title)).toEqual(['N2', 'N10', 'N100']);
    expect(view.instructors.map((r) => r.title)).toEqual(['casey Reed (CFI)', 'Morgan Ellis (CFI)']);
  });

  it('intervals by start, then end; at the same start and end, yours first, then booked, then unavailable', () => {
    const view = buildMemberScheduleView(
      result(
        [aircraft('a1', 'N101')],
        [
          busy('a1', '2026-11-16T20:00:00Z', '2026-11-16T21:00:00Z', 'unavailable'),
          busy('a1', '2026-11-16T20:00:00Z', '2026-11-16T21:00:00Z'),
          busy('a1', '2026-11-16T15:00:00Z', '2026-11-16T18:00:00Z'),
          busy('a1', '2026-11-16T15:00:00Z', '2026-11-16T16:00:00Z'),
          mine('a1', '2026-11-16T20:00:00Z', '2026-11-16T21:00:00Z', null, ['N101']),
        ],
      ),
      DAY,
      CHICAGO,
    );
    expect(view.aircraft[0]!.intervals.map((i) => `${i.time} ${i.label}`)).toEqual([
      '09:00 – 10:00 Booked',
      '09:00 – 12:00 Booked',
      '14:00 – 15:00 Your booking',
      '14:00 – 15:00 Booked',
      '14:00 – 15:00 Unavailable',
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Guards, empties, keys, grounded
// ═════════════════════════════════════════════════════════════════════════════

describe('5. guards and empties', () => {
  it('drops intervals outside the day (half-open) and ones naming an unknown resource', () => {
    const view = buildMemberScheduleView(
      result(
        [aircraft('a1', 'N101')],
        [
          busy('a1', '2026-11-16T05:00:00Z', DAY.from.toISOString()), // ends at the day's start
          busy('a1', DAY.to.toISOString(), '2026-11-17T07:00:00Z'), // starts at the day's end
          busy('a1', '2026-11-16T15:00:00Z', '2026-11-16T17:00:00Z'), // inside
          busy('ghost', '2026-11-16T15:00:00Z', '2026-11-16T17:00:00Z'), // unknown resource
        ],
      ),
      DAY,
      CHICAGO,
    );
    expect(view.aircraft).toHaveLength(1);
    expect(view.aircraft[0]!.intervals.map((i) => i.time)).toEqual(['09:00 – 11:00']);
  });

  it('nothingBooked: rows listed, no intervals → true; any interval → false', () => {
    const empty = buildMemberScheduleView(result([aircraft('a1', 'N101'), instructor('i1', 'Casey')], []), DAY, CHICAGO);
    expect(empty.nothingBooked).toBe(true);
    expect(empty.aircraft).toHaveLength(1);
    expect(empty.instructors).toHaveLength(1);

    const some = buildMemberScheduleView(
      result([aircraft('a1', 'N101')], [busy('a1', '2026-11-16T15:00:00Z', '2026-11-16T17:00:00Z', 'unavailable')]),
      DAY,
      CHICAGO,
    );
    expect(some.nothingBooked).toBe(false);
  });

  it('no resources at all → empty lists', () => {
    expect(buildMemberScheduleView(result([], []), DAY, CHICAGO)).toEqual({
      aircraft: [],
      instructors: [],
      nothingBooked: true,
    });
  });

  it('keys are unique, even for two identical blackouts', () => {
    const view = buildMemberScheduleView(
      result(
        [aircraft('a1', 'N101')],
        [
          busy('a1', '2026-11-16T15:00:00Z', '2026-11-16T17:00:00Z', 'unavailable'),
          busy('a1', '2026-11-16T15:00:00Z', '2026-11-16T17:00:00Z', 'unavailable'),
        ],
      ),
      DAY,
      CHICAGO,
    );
    const keys = view.aircraft[0]!.intervals.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('an aircraft row carries its make/model and grounded chip state; an instructor row neither', () => {
    const view = buildMemberScheduleView(
      result(
        [
          aircraft('a1', 'N101', { make: 'Cessna', model: '172S', grounded: true }),
          instructor('i1', 'Casey Example (CFI)'),
        ],
        [],
      ),
      DAY,
      CHICAGO,
    );
    expect(view.aircraft[0]).toMatchObject({ title: 'N101', detail: 'Cessna 172S', grounded: true });
    expect(view.instructors[0]).toMatchObject({ title: 'Casey Example (CFI)', detail: null, grounded: false });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. aircraftDetail
// ═════════════════════════════════════════════════════════════════════════════

describe('6. aircraftDetail', () => {
  it('joins make and model; either alone; neither → null; trims', () => {
    expect(aircraftDetail('Cessna', '172S')).toBe('Cessna 172S');
    expect(aircraftDetail(null, 'PA-28-181')).toBe('PA-28-181');
    expect(aircraftDetail('Piper', null)).toBe('Piper');
    expect(aircraftDetail(null, null)).toBeNull();
    expect(aircraftDetail('  ', ' ')).toBeNull();
    expect(aircraftDetail(' Cessna ', ' 152 ')).toBe('Cessna 152');
  });
});
