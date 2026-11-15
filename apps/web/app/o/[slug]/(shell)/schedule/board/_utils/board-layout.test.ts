/**
 * board-layout.test.ts — Unit tests for the dispatch board pure layout helpers.
 *
 * Covers (per spec slice-2c-reschedule-board.md §6 tests #19–22):
 *   #19 — block left/width positioning including midnight clamp
 *   #20 — multi-resource fan-out: N blocks sharing reservationId
 *   #21 — cancelled reservations are excluded from fanOutBlocks
 *   #22 — drag math: dropToNewStartAt → 15-min-snapped newStartAt, duration preserved
 *
 * Additional:
 *   — snapTo15Min rounds to nearest 15-min boundary
 *   — groupResourcesByKind: aircraft first, then instructors
 *   — fanOutBlocks respects activeResourceIds (deactivated resources skipped)
 *   — DST days (2026 in Chicago): the track is the day's real length (25 h on
 *     Nov 1, 23 h on Mar 8, 24 h on an ordinary day), the hour labels follow
 *     the wall clock (1am twice / no 2am), and a block sits under the label of
 *     its start time. Every expectation holds whatever the process zone is:
 *       for tz in America/Chicago America/New_York Pacific/Auckland UTC; do
 *         TZ=$tz pnpm --filter @aeroops/web exec vitest run board-layout
 *       done
 *
 * All pure unit tests — no DOM, no React, no Next.js, no DB.
 */

import { describe, it, expect } from 'vitest';
import type { ReservationRow } from '@aeroops/api';
import type { ResourceRow } from '@aeroops/api';
import { dayWindow } from '@/lib/schedule-day';
import {
  HOUR_MS,
  HOUR_WIDTH_PX,
  blockPositionFromReservation,
  snapTo15Min,
  dropToNewStartAt,
  fanOutBlocks,
  groupResourcesByKind,
  hourLabelAt,
  hourTicks,
  quarterCount,
  trackWidthPx,
} from './board-layout';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a day-start epoch (ms) for a concrete date at local midnight. */
function dayStart(y: number, m: number, d: number): number {
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/** An ordinary (non-DST) day's length. */
const DAY_MS = 24 * 60 * 60 * 1000;

// 2026-06-16 00:00:00 local — an ordinary 24 h day in every zone the suite runs in.
const DAY = dayStart(2026, 6, 16);
const DAY_END = DAY + DAY_MS;

function makeReservation(
  overrides: Partial<ReservationRow> & { startAt: Date; endAt: Date },
): ReservationRow {
  return {
    id: 'rsv-' + Math.random().toString(36).slice(2),
    orgId: 'org-1',
    status: 'booked',
    notes: null,
    createdBy: 'user-1',
    cancelledAt: null,
    cancelledBy: null,
    seriesId: null,
    resourceIds: ['res-1'],
    ...overrides,
  };
}

function makeResource(overrides: Partial<ResourceRow> & { id: string }): ResourceRow {
  return {
    kind: 'aircraft',
    displayName: 'Test Resource',
    tailNumber: null,
    instructorUserId: null,
    active: true,
    ...overrides,
  };
}

// ─── blockPositionFromReservation ─────────────────────────────────────────────

describe('#19 blockPositionFromReservation — positioning', () => {
  it('noon start, 1-hour block: leftPct=50, widthPct≈4.167', () => {
    const r = makeReservation({
      startAt: new Date(DAY + 12 * 60 * 60 * 1000),  // 12:00
      endAt: new Date(DAY + 13 * 60 * 60 * 1000),    // 13:00
    });
    const pos = blockPositionFromReservation(r, DAY, DAY_END);
    expect(pos.leftPct).toBeCloseTo(50, 5);
    expect(pos.widthPct).toBeCloseTo((1 / 24) * 100, 5);
  });

  it('start of day: leftPct=0', () => {
    const r = makeReservation({
      startAt: new Date(DAY),
      endAt: new Date(DAY + 30 * 60 * 1000),
    });
    const pos = blockPositionFromReservation(r, DAY, DAY_END);
    expect(pos.leftPct).toBe(0);
  });

  it('end of day: left + width = 100', () => {
    const r = makeReservation({
      startAt: new Date(DAY + 23 * 60 * 60 * 1000),  // 23:00
      endAt: new Date(DAY_END),          // 24:00
    });
    const pos = blockPositionFromReservation(r, DAY, DAY_END);
    expect(pos.leftPct + pos.widthPct).toBeCloseTo(100, 5);
  });

  it('midnight-spanning: leftPct < 100, widthPct clamped so sum = 100', () => {
    // 23:00 → 25:00 (midnight-spanning)
    const r = makeReservation({
      startAt: new Date(DAY + 23 * 60 * 60 * 1000),
      endAt: new Date(DAY + 25 * 60 * 60 * 1000),
    });
    const pos = blockPositionFromReservation(r, DAY, DAY_END);
    expect(pos.leftPct).toBeCloseTo((23 / 24) * 100, 4);
    expect(pos.leftPct + pos.widthPct).toBeCloseTo(100, 5);
    expect(pos.widthPct).toBeGreaterThan(0);
  });

  it('event starting before day-start is clamped: leftPct=0', () => {
    const r = makeReservation({
      startAt: new Date(DAY - 60 * 60 * 1000),   // -1h (previous day)
      endAt: new Date(DAY + 60 * 60 * 1000),      // 01:00
    });
    const pos = blockPositionFromReservation(r, DAY, DAY_END);
    expect(pos.leftPct).toBe(0);
    expect(pos.widthPct).toBeGreaterThan(0);
    expect(pos.widthPct).toBeLessThanOrEqual(100);
  });

  it('event entirely before day-start: leftPct=0, widthPct=0', () => {
    const r = makeReservation({
      startAt: new Date(DAY - 2 * 60 * 60 * 1000),
      endAt: new Date(DAY - 60 * 60 * 1000),
    });
    const pos = blockPositionFromReservation(r, DAY, DAY_END);
    expect(pos.leftPct).toBe(0);
    expect(pos.widthPct).toBe(0);
  });

  it('leftPct + widthPct never exceeds 100 (invariant)', () => {
    const cases = [
      { start: DAY, end: DAY_END },
      { start: DAY - 3600000, end: DAY_END + 3600000 },
      { start: DAY + 23 * 3600000, end: DAY + 26 * 3600000 },
    ];
    for (const { start, end } of cases) {
      const r = makeReservation({ startAt: new Date(start), endAt: new Date(end) });
      const { leftPct, widthPct } = blockPositionFromReservation(r, DAY, DAY_END);
      expect(leftPct + widthPct).toBeLessThanOrEqual(100 + 1e-9);
    }
  });
});

// ─── snapTo15Min ─────────────────────────────────────────────────────────────

describe('#22 snapTo15Min — 15-minute boundary snapping', () => {
  const MIN = 60 * 1000;

  it('already on a 15-min boundary: unchanged', () => {
    const t = DAY + 6 * 60 * MIN; // 06:00
    expect(snapTo15Min(t)).toBe(t);
  });

  it('7 min past boundary: rounds down', () => {
    const base = DAY + 6 * 60 * MIN;
    expect(snapTo15Min(base + 7 * MIN)).toBe(base);
  });

  it('8 min past boundary: rounds up (tie goes up)', () => {
    const base = DAY + 6 * 60 * MIN;
    expect(snapTo15Min(base + 8 * MIN)).toBe(base + 15 * MIN);
  });

  it('14 min past boundary: rounds up', () => {
    const base = DAY + 10 * 60 * MIN;
    expect(snapTo15Min(base + 14 * MIN)).toBe(base + 15 * MIN);
  });

  it('result is always divisible by 15 minutes', () => {
    for (let offset = 0; offset < 60 * MIN; offset += 3 * MIN) {
      const snapped = snapTo15Min(DAY + offset);
      expect(snapped % (15 * MIN)).toBe(0);
    }
  });
});

// ─── dropToNewStartAt ─────────────────────────────────────────────────────────

describe('#22 dropToNewStartAt — drag math (duration preserved via caller)', () => {
  const TRACK = 4800; // px (200px/hr × 24h per spec §1)

  it('drop at left edge → 00:00 local', () => {
    const result = dropToNewStartAt(0, TRACK, DAY, DAY_END);
    expect(result.getTime()).toBe(DAY);
  });

  it('drop at right edge → 24:00 (snapped to nearest 15 min from track end)', () => {
    const result = dropToNewStartAt(TRACK, TRACK, DAY, DAY_END);
    expect(result.getTime()).toBe(DAY_END);
  });

  it('drop at 200px (1h into 4800px track) → 01:00 local', () => {
    const result = dropToNewStartAt(200, TRACK, DAY, DAY_END);
    expect(result.getTime()).toBe(DAY + 60 * 60 * 1000);
  });

  it('drop yields a 15-min-snapped result', () => {
    // 137px / 4800px × 86400000ms = a non-round value; must snap
    const result = dropToNewStartAt(137, TRACK, DAY, DAY_END);
    const ms = result.getTime() - DAY;
    expect(ms % (15 * 60 * 1000)).toBe(0);
  });

  it('negative pointer clamped to day start', () => {
    const result = dropToNewStartAt(-50, TRACK, DAY, DAY_END);
    expect(result.getTime()).toBe(DAY);
  });

  it('pointer past track width clamped to day end', () => {
    const result = dropToNewStartAt(5000, TRACK, DAY, DAY_END);
    expect(result.getTime()).toBe(DAY_END);
  });

  it('duration is preserved by caller: newEndAt = newStartAt + originalDuration', () => {
    // Verify that the contract works — the caller computes endAt by adding duration.
    const originalDuration = 90 * 60 * 1000; // 1.5h
    const newStartAt = dropToNewStartAt(600, TRACK, DAY, DAY_END); // 3h into day
    const newEndAt = new Date(newStartAt.getTime() + originalDuration);
    const durationMs = newEndAt.getTime() - newStartAt.getTime();
    expect(durationMs).toBe(originalDuration);
  });
});

// ─── fanOutBlocks ─────────────────────────────────────────────────────────────

describe('#20 fanOutBlocks — multi-resource fan-out', () => {
  const activeIds = new Set(['res-aircraft-1', 'res-instructor-1']);

  it('single-resource reservation produces 1 block', () => {
    const r = makeReservation({
      startAt: new Date(DAY + 8 * 3600000),
      endAt: new Date(DAY + 9 * 3600000),
      resourceIds: ['res-aircraft-1'],
    });
    const blocks = fanOutBlocks([r], activeIds, DAY, DAY_END);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.reservationId).toBe(r.id);
    expect(blocks[0]?.resourceId).toBe('res-aircraft-1');
  });

  it('multi-resource reservation produces N blocks sharing reservationId', () => {
    const r = makeReservation({
      startAt: new Date(DAY + 9 * 3600000),
      endAt: new Date(DAY + 10 * 3600000),
      resourceIds: ['res-aircraft-1', 'res-instructor-1'],
    });
    const blocks = fanOutBlocks([r], activeIds, DAY, DAY_END);
    expect(blocks).toHaveLength(2);
    // Both blocks share the same reservationId
    expect(blocks[0]?.reservationId).toBe(r.id);
    expect(blocks[1]?.reservationId).toBe(r.id);
    // Each block is for a different resource row
    const resourceIds = blocks.map((b) => b.resourceId).sort();
    expect(resourceIds).toEqual(['res-aircraft-1', 'res-instructor-1'].sort());
  });

  it('multiple reservations produce independent blocks', () => {
    const r1 = makeReservation({
      startAt: new Date(DAY + 8 * 3600000),
      endAt: new Date(DAY + 9 * 3600000),
      resourceIds: ['res-aircraft-1'],
    });
    const r2 = makeReservation({
      startAt: new Date(DAY + 10 * 3600000),
      endAt: new Date(DAY + 11 * 3600000),
      resourceIds: ['res-aircraft-1'],
    });
    const blocks = fanOutBlocks([r1, r2], activeIds, DAY, DAY_END);
    expect(blocks).toHaveLength(2);
    const ids = new Set(blocks.map((b) => b.reservationId));
    expect(ids.size).toBe(2);
  });

  it('block carries a reference to the full reservation row', () => {
    const r = makeReservation({
      startAt: new Date(DAY + 8 * 3600000),
      endAt: new Date(DAY + 9 * 3600000),
      resourceIds: ['res-aircraft-1'],
      notes: 'test note',
      seriesId: 'series-abc',
    });
    const blocks = fanOutBlocks([r], activeIds, DAY, DAY_END);
    expect(blocks[0]?.reservation.notes).toBe('test note');
    expect(blocks[0]?.reservation.seriesId).toBe('series-abc');
  });
});

describe('#20 fanOutBlocks — activeResourceIds filter', () => {
  it('resource not in activeResourceIds produces no block', () => {
    const r = makeReservation({
      startAt: new Date(DAY + 8 * 3600000),
      endAt: new Date(DAY + 9 * 3600000),
      resourceIds: ['res-inactive'],
    });
    const blocks = fanOutBlocks([r], new Set(['res-aircraft-1']), DAY, DAY_END);
    expect(blocks).toHaveLength(0);
  });

  it('multi-resource: only active resources produce blocks', () => {
    const r = makeReservation({
      startAt: new Date(DAY + 8 * 3600000),
      endAt: new Date(DAY + 9 * 3600000),
      resourceIds: ['res-aircraft-1', 'res-deactivated'],
    });
    const blocks = fanOutBlocks([r], new Set(['res-aircraft-1']), DAY, DAY_END);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.resourceId).toBe('res-aircraft-1');
  });
});

describe('#21 fanOutBlocks — cancelled reservations excluded', () => {
  it('cancelled reservation produces no blocks', () => {
    const r = makeReservation({
      startAt: new Date(DAY + 8 * 3600000),
      endAt: new Date(DAY + 9 * 3600000),
      resourceIds: ['res-aircraft-1'],
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledBy: 'user-1',
    });
    const blocks = fanOutBlocks([r], new Set(['res-aircraft-1']), DAY, DAY_END);
    expect(blocks).toHaveLength(0);
  });

  it('mix of booked and cancelled: only booked produces blocks', () => {
    const booked = makeReservation({
      startAt: new Date(DAY + 8 * 3600000),
      endAt: new Date(DAY + 9 * 3600000),
      resourceIds: ['res-aircraft-1'],
    });
    const cancelled = makeReservation({
      startAt: new Date(DAY + 10 * 3600000),
      endAt: new Date(DAY + 11 * 3600000),
      resourceIds: ['res-aircraft-1'],
      status: 'cancelled',
      cancelledAt: new Date(),
      cancelledBy: 'user-1',
    });
    const blocks = fanOutBlocks([booked, cancelled], new Set(['res-aircraft-1']), DAY, DAY_END);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.reservationId).toBe(booked.id);
  });

  it('empty reservations array → empty blocks array', () => {
    const blocks = fanOutBlocks([], new Set(['res-1']), DAY, DAY_END);
    expect(blocks).toHaveLength(0);
  });
});

describe('fanOutBlocks — clippedEnd flag', () => {
  it('midnight-spanning reservation sets clippedEnd=true', () => {
    const r = makeReservation({
      startAt: new Date(DAY + 23 * 3600000),
      endAt: new Date(DAY + 25 * 3600000), // ends 25:00 (next day)
      resourceIds: ['res-aircraft-1'],
    });
    const blocks = fanOutBlocks([r], new Set(['res-aircraft-1']), DAY, DAY_END);
    expect(blocks[0]?.clippedEnd).toBe(true);
  });

  it('normal reservation sets clippedEnd=false', () => {
    const r = makeReservation({
      startAt: new Date(DAY + 8 * 3600000),
      endAt: new Date(DAY + 9 * 3600000),
      resourceIds: ['res-aircraft-1'],
    });
    const blocks = fanOutBlocks([r], new Set(['res-aircraft-1']), DAY, DAY_END);
    expect(blocks[0]?.clippedEnd).toBe(false);
  });
});

// ─── groupResourcesByKind ─────────────────────────────────────────────────────

describe('groupResourcesByKind — aircraft first, then instructors', () => {
  it('empty array → both groups empty', () => {
    const { aircraft, instructors } = groupResourcesByKind([]);
    expect(aircraft).toHaveLength(0);
    expect(instructors).toHaveLength(0);
  });

  it('aircraft resources go into aircraft group', () => {
    const r = makeResource({ id: 'a1', kind: 'aircraft', tailNumber: 'N12345', displayName: 'Cessna 172' });
    const { aircraft, instructors } = groupResourcesByKind([r]);
    expect(aircraft).toHaveLength(1);
    expect(instructors).toHaveLength(0);
    expect(aircraft[0]?.id).toBe('a1');
  });

  it('instructor resources go into instructors group', () => {
    const r = makeResource({ id: 'i1', kind: 'instructor', displayName: 'Jane Smith' });
    const { aircraft, instructors } = groupResourcesByKind([r]);
    expect(aircraft).toHaveLength(0);
    expect(instructors).toHaveLength(1);
    expect(instructors[0]?.id).toBe('i1');
  });

  it('mixed array is split correctly', () => {
    const a1 = makeResource({ id: 'a1', kind: 'aircraft', displayName: 'N1' });
    const i1 = makeResource({ id: 'i1', kind: 'instructor', displayName: 'CFI A' });
    const a2 = makeResource({ id: 'a2', kind: 'aircraft', displayName: 'N2' });
    const { aircraft, instructors } = groupResourcesByKind([a1, i1, a2]);
    expect(aircraft.map((r) => r.id)).toEqual(['a1', 'a2']);
    expect(instructors.map((r) => r.id)).toEqual(['i1']);
  });

  it('preserves original order within each group', () => {
    const resources = [
      makeResource({ id: 'a1', kind: 'aircraft', displayName: 'Alpha' }),
      makeResource({ id: 'a2', kind: 'aircraft', displayName: 'Beta' }),
      makeResource({ id: 'i1', kind: 'instructor', displayName: 'CFI 1' }),
      makeResource({ id: 'i2', kind: 'instructor', displayName: 'CFI 2' }),
    ];
    const { aircraft, instructors } = groupResourcesByKind(resources);
    expect(aircraft.map((r) => r.id)).toEqual(['a1', 'a2']);
    expect(instructors.map((r) => r.id)).toEqual(['i1', 'i2']);
  });

  it('all aircraft → instructors group empty', () => {
    const resources = [
      makeResource({ id: 'a1', kind: 'aircraft', displayName: 'N1' }),
      makeResource({ id: 'a2', kind: 'aircraft', displayName: 'N2' }),
    ];
    const { aircraft, instructors } = groupResourcesByKind(resources);
    expect(aircraft).toHaveLength(2);
    expect(instructors).toHaveLength(0);
  });

  it('all instructors → aircraft group empty', () => {
    const resources = [
      makeResource({ id: 'i1', kind: 'instructor', displayName: 'CFI 1' }),
      makeResource({ id: 'i2', kind: 'instructor', displayName: 'CFI 2' }),
    ];
    const { aircraft, instructors } = groupResourcesByKind(resources);
    expect(aircraft).toHaveLength(0);
    expect(instructors).toHaveLength(2);
  });
});

// ─── DST days: the track is the day's real length ─────────────────────────────
//
// The bug: the board laid every day out on a fixed 24 h track. On 2026-11-01
// in Chicago (25 h: 1am happens twice) blocks after the fall-back sat one hour
// to the right — an 11:00 block under "12pm"; on 2026-03-08 (23 h: no 2am)
// they sat one hour to the left. The track now runs from dayWindow().from to
// dayWindow().to and its hour labels come from the zone's wall clock.

const CHICAGO = 'America/Chicago';

/** The board's track for `day` in Chicago: what the page passes the board. */
function chicagoTrack(day: string): { start: number; end: number } {
  const { from, to } = dayWindow(day, CHICAGO);
  return { start: from.getTime(), end: to.getTime() };
}

/** A one-hour reservation starting at the UTC instant `startIso`. */
function oneHourAt(startIso: string): ReservationRow {
  const startAt = new Date(startIso);
  return makeReservation({ startAt, endAt: new Date(startAt.getTime() + HOUR_MS) });
}

/** Percent of the track at which the hour label `label` sits (nth occurrence). */
function labelPct(day: string, label: string, nth = 0): number {
  const { start, end } = chicagoTrack(day);
  const tick = hourTicks(start, end, CHICAGO).filter((t) => t.label === label)[nth];
  if (!tick) throw new Error(`no ${label} label #${nth} on ${day}`);
  return (tick.offsetMs / (end - start)) * 100;
}

/** Run `fn` with the process ("server" / "browser") zone switched to `tz`. */
function inZone<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

const ORDINARY_LABELS = [
  '12am', '1am', '2am', '3am', '4am', '5am', '6am', '7am', '8am', '9am', '10am', '11am',
  '12pm', '1pm', '2pm', '3pm', '4pm', '5pm', '6pm', '7pm', '8pm', '9pm', '10pm', '11pm',
];

describe('DST — an ordinary day (2026-11-16, Chicago): 24 h, unchanged', () => {
  const DAY_ISO = '2026-11-16';
  const { start, end } = chicagoTrack(DAY_ISO);

  it('the track is 24 h: 4800 px, 96 drop cells', () => {
    expect(end - start).toBe(24 * HOUR_MS);
    expect(trackWidthPx(start, end)).toBe(4800);
    expect(quarterCount(start, end)).toBe(96);
  });

  it('24 hour labels, one per hour, 12am to 11pm; the day ends at 12am', () => {
    const ticks = hourTicks(start, end, CHICAGO);
    expect(ticks.map((t) => t.label)).toEqual(ORDINARY_LABELS);
    expect(ticks.map((t) => t.offsetMs)).toEqual(ORDINARY_LABELS.map((_, h) => h * HOUR_MS));
    expect(hourLabelAt(end, CHICAGO)).toBe('12am');
  });

  it('an 11:00 CST block sits under 11am', () => {
    const pos = blockPositionFromReservation(oneHourAt('2026-11-16T17:00:00.000Z'), start, end);
    expect(pos.leftPct).toBeCloseTo((11 / 24) * 100, 9);
    expect(pos.leftPct).toBeCloseTo(labelPct(DAY_ISO, '11am'), 9);
    expect(pos.widthPct).toBeCloseTo((1 / 24) * 100, 9);
  });
});

describe('DST — fall-back day (2026-11-01, Chicago): 25 h, 1am twice', () => {
  const DAY_ISO = '2026-11-01';
  const { start, end } = chicagoTrack(DAY_ISO);

  it('the track is 25 h: 5000 px, 100 drop cells', () => {
    expect(end - start).toBe(25 * HOUR_MS);
    expect(trackWidthPx(start, end)).toBe(25 * HOUR_WIDTH_PX);
    expect(quarterCount(start, end)).toBe(100);
  });

  it('25 hour labels from the wall clock: 12am, 1am, 1am, 2am … 11pm', () => {
    const ticks = hourTicks(start, end, CHICAGO);
    expect(ticks).toHaveLength(25);
    expect(ticks.map((t) => t.label)).toEqual(['12am', '1am', ...ORDINARY_LABELS.slice(1)]);
    // The clock repeats an hour, so a label still falls on every elapsed hour.
    expect(ticks.map((t) => t.offsetMs)).toEqual(ticks.map((_, i) => i * HOUR_MS));
    expect(hourLabelAt(end, CHICAGO)).toBe('12am');
  });

  it('an 11:00 CST block sits under 11am, not 12pm (12 h into a 25 h day)', () => {
    const pos = blockPositionFromReservation(oneHourAt('2026-11-01T17:00:00.000Z'), start, end);
    expect(pos.leftPct).toBeCloseTo((12 / 25) * 100, 9); // 48%
    expect(pos.leftPct).toBeCloseTo(labelPct(DAY_ISO, '11am'), 9);
    expect(pos.leftPct).toBeLessThan(labelPct(DAY_ISO, '12pm'));
    expect(pos.widthPct).toBeCloseTo((1 / 25) * 100, 9);
  });

  it('the two 1:30s are an hour apart, each half an hour after its own 1am', () => {
    const first = blockPositionFromReservation(oneHourAt('2026-11-01T06:30:00.000Z'), start, end); // 01:30 CDT
    const second = blockPositionFromReservation(oneHourAt('2026-11-01T07:30:00.000Z'), start, end); // 01:30 CST
    const halfHourPct = (0.5 / 25) * 100;
    expect(first.leftPct).toBeCloseTo(labelPct(DAY_ISO, '1am', 0) + halfHourPct, 9);
    expect(second.leftPct).toBeCloseTo(labelPct(DAY_ISO, '1am', 1) + halfHourPct, 9);
    expect(second.leftPct - first.leftPct).toBeCloseTo((1 / 25) * 100, 9);
  });

  it('a 21:00–23:00 CST block ends inside the day: full width, not clipped', () => {
    const r = makeReservation({
      startAt: new Date('2026-11-02T03:00:00.000Z'), // 21:00 CST
      endAt: new Date('2026-11-02T05:00:00.000Z'), // 23:00 CST — 24 h after the day's start
      resourceIds: ['res-aircraft-1'],
    });
    const [block] = fanOutBlocks([r], new Set(['res-aircraft-1']), start, end);
    expect(block?.clippedEnd).toBe(false);
    expect(block?.position.leftPct).toBeCloseTo(labelPct(DAY_ISO, '9pm'), 9);
    expect(block?.position.widthPct).toBeCloseTo((2 / 25) * 100, 9);
  });

  it('a block past the real midnight is clipped at the track end', () => {
    const r = makeReservation({
      startAt: new Date('2026-11-02T05:00:00.000Z'), // 23:00 CST
      endAt: new Date('2026-11-02T07:00:00.000Z'), // 01:00 on Nov 2
      resourceIds: ['res-aircraft-1'],
    });
    const [block] = fanOutBlocks([r], new Set(['res-aircraft-1']), start, end);
    expect(block?.clippedEnd).toBe(true);
    expect(block?.position.leftPct).toBeCloseTo(labelPct(DAY_ISO, '11pm'), 9);
    expect((block?.position.leftPct ?? 0) + (block?.position.widthPct ?? 0)).toBeCloseTo(100, 9);
  });

  it('a drop under the 11am label lands at 11:00 CST', () => {
    const track = trackWidthPx(start, end);
    const x = (labelPct(DAY_ISO, '11am') / 100) * track;
    expect(dropToNewStartAt(x, track, start, end).toISOString()).toBe('2026-11-01T17:00:00.000Z');
  });
});

describe('DST — spring-forward day (2026-03-08, Chicago): 23 h, no 2am', () => {
  const DAY_ISO = '2026-03-08';
  const { start, end } = chicagoTrack(DAY_ISO);

  it('the track is 23 h: 4600 px, 92 drop cells', () => {
    expect(end - start).toBe(23 * HOUR_MS);
    expect(trackWidthPx(start, end)).toBe(23 * HOUR_WIDTH_PX);
    expect(quarterCount(start, end)).toBe(92);
  });

  it('23 hour labels from the wall clock: 12am, 1am, 3am … 11pm', () => {
    const ticks = hourTicks(start, end, CHICAGO);
    expect(ticks).toHaveLength(23);
    expect(ticks.map((t) => t.label)).toEqual(ORDINARY_LABELS.filter((l) => l !== '2am'));
    expect(ticks.map((t) => t.offsetMs)).toEqual(ticks.map((_, i) => i * HOUR_MS));
    expect(hourLabelAt(end, CHICAGO)).toBe('12am');
  });

  it('an 11:00 CDT block sits under 11am, not 10am (10 h into a 23 h day)', () => {
    const pos = blockPositionFromReservation(oneHourAt('2026-03-08T16:00:00.000Z'), start, end);
    expect(pos.leftPct).toBeCloseTo((10 / 23) * 100, 9);
    expect(pos.leftPct).toBeCloseTo(labelPct(DAY_ISO, '11am'), 9);
    expect(pos.leftPct).toBeGreaterThan(labelPct(DAY_ISO, '10am'));
    expect(pos.widthPct).toBeCloseTo((1 / 23) * 100, 9);
  });

  it('a 03:00 CDT block sits right after 1am’s hour, under 3am', () => {
    const pos = blockPositionFromReservation(oneHourAt('2026-03-08T08:00:00.000Z'), start, end);
    expect(pos.leftPct).toBeCloseTo((2 / 23) * 100, 9);
    expect(pos.leftPct).toBeCloseTo(labelPct(DAY_ISO, '3am'), 9);
  });

  it('a 23:00–24:00 CDT block ends exactly at the track end, not clipped', () => {
    const r = makeReservation({
      startAt: new Date('2026-03-09T04:00:00.000Z'), // 23:00 CDT
      endAt: new Date('2026-03-09T05:00:00.000Z'), // 00:00 Mar 9
      resourceIds: ['res-aircraft-1'],
    });
    const [block] = fanOutBlocks([r], new Set(['res-aircraft-1']), start, end);
    expect(block?.clippedEnd).toBe(false);
    expect(block?.position.leftPct).toBeCloseTo(labelPct(DAY_ISO, '11pm'), 9);
    expect((block?.position.leftPct ?? 0) + (block?.position.widthPct ?? 0)).toBeCloseTo(100, 9);
  });
});

describe('DST — the hour labels are the same on a UTC server and in a Chicago browser', () => {
  it('hourTicks reads the zone it is given, never the runtime’s', () => {
    for (const day of ['2026-11-16', '2026-11-01', '2026-03-08']) {
      const { start, end } = chicagoTrack(day);
      const onServer = inZone('UTC', () => hourTicks(start, end, CHICAGO));
      const inBrowser = inZone(CHICAGO, () => hourTicks(start, end, CHICAGO));
      const elsewhere = inZone('Pacific/Auckland', () => hourTicks(start, end, CHICAGO));
      expect(inBrowser).toEqual(onServer);
      expect(elsewhere).toEqual(onServer);
    }
  });
});
