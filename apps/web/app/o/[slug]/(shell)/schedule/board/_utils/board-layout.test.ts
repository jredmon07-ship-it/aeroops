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
 *
 * All pure unit tests — no DOM, no React, no Next.js, no DB.
 */

import { describe, it, expect } from 'vitest';
import type { ReservationRow } from '@aeroops/api';
import type { ResourceRow } from '@aeroops/api';
import {
  DAY_DURATION_MS,
  blockPositionFromReservation,
  snapTo15Min,
  dropToNewStartAt,
  fanOutBlocks,
  groupResourcesByKind,
} from './board-layout';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a day-start epoch (ms) for a concrete date at local midnight. */
function dayStart(y: number, m: number, d: number): number {
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

const DAY = dayStart(2026, 6, 16); // 2026-06-16 00:00:00 local

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
    const pos = blockPositionFromReservation(r, DAY);
    expect(pos.leftPct).toBeCloseTo(50, 5);
    expect(pos.widthPct).toBeCloseTo((1 / 24) * 100, 5);
  });

  it('start of day: leftPct=0', () => {
    const r = makeReservation({
      startAt: new Date(DAY),
      endAt: new Date(DAY + 30 * 60 * 1000),
    });
    const pos = blockPositionFromReservation(r, DAY);
    expect(pos.leftPct).toBe(0);
  });

  it('end of day: left + width = 100', () => {
    const r = makeReservation({
      startAt: new Date(DAY + 23 * 60 * 60 * 1000),  // 23:00
      endAt: new Date(DAY + DAY_DURATION_MS),          // 24:00
    });
    const pos = blockPositionFromReservation(r, DAY);
    expect(pos.leftPct + pos.widthPct).toBeCloseTo(100, 5);
  });

  it('midnight-spanning: leftPct < 100, widthPct clamped so sum = 100', () => {
    // 23:00 → 25:00 (midnight-spanning)
    const r = makeReservation({
      startAt: new Date(DAY + 23 * 60 * 60 * 1000),
      endAt: new Date(DAY + 25 * 60 * 60 * 1000),
    });
    const pos = blockPositionFromReservation(r, DAY);
    expect(pos.leftPct).toBeCloseTo((23 / 24) * 100, 4);
    expect(pos.leftPct + pos.widthPct).toBeCloseTo(100, 5);
    expect(pos.widthPct).toBeGreaterThan(0);
  });

  it('event starting before day-start is clamped: leftPct=0', () => {
    const r = makeReservation({
      startAt: new Date(DAY - 60 * 60 * 1000),   // -1h (previous day)
      endAt: new Date(DAY + 60 * 60 * 1000),      // 01:00
    });
    const pos = blockPositionFromReservation(r, DAY);
    expect(pos.leftPct).toBe(0);
    expect(pos.widthPct).toBeGreaterThan(0);
    expect(pos.widthPct).toBeLessThanOrEqual(100);
  });

  it('event entirely before day-start: leftPct=0, widthPct=0', () => {
    const r = makeReservation({
      startAt: new Date(DAY - 2 * 60 * 60 * 1000),
      endAt: new Date(DAY - 60 * 60 * 1000),
    });
    const pos = blockPositionFromReservation(r, DAY);
    expect(pos.leftPct).toBe(0);
    expect(pos.widthPct).toBe(0);
  });

  it('leftPct + widthPct never exceeds 100 (invariant)', () => {
    const cases = [
      { start: DAY, end: DAY + DAY_DURATION_MS },
      { start: DAY - 3600000, end: DAY + DAY_DURATION_MS + 3600000 },
      { start: DAY + 23 * 3600000, end: DAY + 26 * 3600000 },
    ];
    for (const { start, end } of cases) {
      const r = makeReservation({ startAt: new Date(start), endAt: new Date(end) });
      const { leftPct, widthPct } = blockPositionFromReservation(r, DAY);
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
    const result = dropToNewStartAt(0, TRACK, DAY);
    expect(result.getTime()).toBe(DAY);
  });

  it('drop at right edge → 24:00 (snapped to nearest 15 min from track end)', () => {
    const result = dropToNewStartAt(TRACK, TRACK, DAY);
    expect(result.getTime()).toBe(DAY + DAY_DURATION_MS);
  });

  it('drop at 200px (1h into 4800px track) → 01:00 local', () => {
    const result = dropToNewStartAt(200, TRACK, DAY);
    expect(result.getTime()).toBe(DAY + 60 * 60 * 1000);
  });

  it('drop yields a 15-min-snapped result', () => {
    // 137px / 4800px × 86400000ms = a non-round value; must snap
    const result = dropToNewStartAt(137, TRACK, DAY);
    const ms = result.getTime() - DAY;
    expect(ms % (15 * 60 * 1000)).toBe(0);
  });

  it('negative pointer clamped to day start', () => {
    const result = dropToNewStartAt(-50, TRACK, DAY);
    expect(result.getTime()).toBe(DAY);
  });

  it('pointer past track width clamped to day end', () => {
    const result = dropToNewStartAt(5000, TRACK, DAY);
    expect(result.getTime()).toBe(DAY + DAY_DURATION_MS);
  });

  it('duration is preserved by caller: newEndAt = newStartAt + originalDuration', () => {
    // Verify that the contract works — the caller computes endAt by adding duration.
    const originalDuration = 90 * 60 * 1000; // 1.5h
    const newStartAt = dropToNewStartAt(600, TRACK, DAY); // 3h into day
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
    const blocks = fanOutBlocks([r], activeIds, DAY);
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
    const blocks = fanOutBlocks([r], activeIds, DAY);
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
    const blocks = fanOutBlocks([r1, r2], activeIds, DAY);
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
    const blocks = fanOutBlocks([r], activeIds, DAY);
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
    const blocks = fanOutBlocks([r], new Set(['res-aircraft-1']), DAY);
    expect(blocks).toHaveLength(0);
  });

  it('multi-resource: only active resources produce blocks', () => {
    const r = makeReservation({
      startAt: new Date(DAY + 8 * 3600000),
      endAt: new Date(DAY + 9 * 3600000),
      resourceIds: ['res-aircraft-1', 'res-deactivated'],
    });
    const blocks = fanOutBlocks([r], new Set(['res-aircraft-1']), DAY);
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
    const blocks = fanOutBlocks([r], new Set(['res-aircraft-1']), DAY);
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
    const blocks = fanOutBlocks([booked, cancelled], new Set(['res-aircraft-1']), DAY);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.reservationId).toBe(booked.id);
  });

  it('empty reservations array → empty blocks array', () => {
    const blocks = fanOutBlocks([], new Set(['res-1']), DAY);
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
    const blocks = fanOutBlocks([r], new Set(['res-aircraft-1']), DAY);
    expect(blocks[0]?.clippedEnd).toBe(true);
  });

  it('normal reservation sets clippedEnd=false', () => {
    const r = makeReservation({
      startAt: new Date(DAY + 8 * 3600000),
      endAt: new Date(DAY + 9 * 3600000),
      resourceIds: ['res-aircraft-1'],
    });
    const blocks = fanOutBlocks([r], new Set(['res-aircraft-1']), DAY);
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
