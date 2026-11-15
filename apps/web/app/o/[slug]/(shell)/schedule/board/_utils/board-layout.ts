/**
 * board/_utils/board-layout.ts — Pure layout helpers for the dispatch board.
 *
 * All functions are stateless and side-effect-free; they take plain values and
 * return plain values.  No React, no Next.js, no I/O.  Unit-testable in vitest
 * with a node environment.
 *
 * CONVENTIONS:
 *   - The track is ONE calendar day in the viewer's zone: from the day's first
 *     instant to the next day's first instant, dayWindow(day, tz) in
 *     lib/schedule-day.ts. That is 24 h on most days, 23 h on the
 *     spring-forward day and 25 h on the fall-back day. Callers pass both ends
 *     (dayStartMs, dayEndMs); nothing here assumes 24 h. (It used to: on
 *     2026-11-01 in Chicago an 11:00 block sat under "12pm".)
 *   - leftPct / widthPct are percentages of that real length, clamped to
 *     [0, 100] so midnight-spanning events clip cleanly to the track edges.
 *   - One hour is HOUR_WIDTH_PX wide on every day, so the track is
 *     trackWidthPx(dayStartMs, dayEndMs) wide: 4600 / 4800 / 5000 px.
 *   - Hour labels come from the zone's wall clock (hourTicks): 25 on the
 *     fall-back day with 1am twice, 23 on the spring-forward day without 2am.
 *   - The 15-minute snap grid is enforced by snapTo15Min (rounds to nearest 15).
 */

import type { ReservationRow } from '@aeroops/api';
import type { ResourceRow } from '@aeroops/api';

// ─── Constants ────────────────────────────────────────────────────────────────

/** One hour in milliseconds. */
export const HOUR_MS = 60 * 60 * 1000;

/** Width of one hour on the track, in pixels (every day, DST days included). */
export const HOUR_WIDTH_PX = 200;

/** 15-minute snap quantum in milliseconds; also the size of one drop cell. */
export const QUARTER_MS = 15 * 60 * 1000;

/** An ordinary day; only the default for callers that omit the day's end. */
const ORDINARY_DAY_MS = 24 * HOUR_MS;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * BlockPosition — the CSS-ready percentage values for a board block's
 * horizontal placement inside the time track.
 *
 *   leftPct  — distance from the track's left edge (day start) in %.
 *   widthPct — block width as a percentage of the total track width.
 *
 * Both are clamped to [0, 100] and their sum never exceeds 100.
 * A midnight-spanning event that extends beyond the day's end will have a
 * reduced widthPct (clamped) and should be rendered with a dashed right border
 * to signal the truncation (per board UX spec §1).
 */
export interface BlockPosition {
  leftPct: number;
  widthPct: number;
}

/**
 * BoardBlock — one rendered block on the dispatch board.
 *
 * Multi-resource reservations produce N blocks (one per resource row they
 * occupy), all sharing the same reservationId (and therefore the same hue).
 * The block's resourceId identifies which row it lives in.
 */
export interface BoardBlock {
  /** The reservation this block belongs to. */
  reservationId: string;
  /** The resource row this block occupies (one of reservation.resourceIds). */
  resourceId: string;
  /** Half-open window — matches the reservation's startAt/endAt. */
  startAt: Date;
  endAt: Date;
  /** Precomputed position for the board renderer. */
  position: BlockPosition;
  /** Whether the block's right edge is clipped (midnight-spanning). */
  clippedEnd: boolean;
  /** The full reservation row — gives the renderer access to notes, seriesId, etc. */
  reservation: ReservationRow;
}

/**
 * GroupedResources — resources split by kind (aircraft first, then instructors),
 * preserving the display order from the API (already kind-then-displayName sorted).
 */
export interface GroupedResources {
  aircraft: ResourceRow[];
  instructors: ResourceRow[];
}

/** HourTick — one hour label on the time axis. */
export interface HourTick {
  /** Milliseconds from the track's left edge (the day's first instant). */
  offsetMs: number;
  /** The zone's wall-clock hour at that instant, 0–23. */
  hour: number;
  /** "12am", "1am", … "11pm". */
  label: string;
}

// ─── Track scale ──────────────────────────────────────────────────────────────

/**
 * trackWidthPx — the track's width for the day [dayStartMs, dayEndMs):
 * HOUR_WIDTH_PX per real hour (4800 px for 24 h, 4600 for 23 h, 5000 for 25 h).
 */
export function trackWidthPx(dayStartMs: number, dayEndMs: number): number {
  return ((dayEndMs - dayStartMs) / HOUR_MS) * HOUR_WIDTH_PX;
}

/**
 * quarterCount — the day's 15-minute drop cells (96 / 92 / 100). Cell i
 * starts at dayStartMs + i × QUARTER_MS.
 */
export function quarterCount(dayStartMs: number, dayEndMs: number): number {
  return Math.ceil((dayEndMs - dayStartMs) / QUARTER_MS);
}

// ─── Hour labels ──────────────────────────────────────────────────────────────

/** Format a wall-clock hour (0–23) as a short label, e.g. 0→"12am", 6→"6am", 13→"1pm". */
export function hourLabel(h: number): string {
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  if (h < 12) return `${h}am`;
  return `${h - 12}pm`;
}

const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

/** The wall-clock hour and minute of the instant `ms` in `timeZone`. */
function wallClock(ms: number, timeZone: string): { hour: number; minute: number } {
  let fmt = wallClockFormatters.get(timeZone);
  if (!fmt) {
    // The zone comes from a cookie; keep the cache bounded.
    if (wallClockFormatters.size >= 64) wallClockFormatters.clear();
    const options: Intl.DateTimeFormatOptions = { hourCycle: 'h23', hour: 'numeric', minute: 'numeric' };
    try {
      fmt = new Intl.DateTimeFormat('en-US', { ...options, timeZone });
    } catch {
      // The page validated the zone; never let an unknown one crash the board.
      fmt = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
    }
    wallClockFormatters.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return { hour: get('hour') % 24, minute: get('minute') }; // some engines print midnight as 24
}

/** hourLabelAt — the hour label of the instant `ms` on `timeZone`'s wall clock. */
export function hourLabelAt(ms: number, timeZone: string): string {
  return hourLabel(wallClock(ms, timeZone).hour);
}

/**
 * hourTicks — the time axis's hour labels for the day [dayStartMs, dayEndMs):
 * every instant at which `timeZone`'s wall clock reads HH:00, in order.
 *
 * 24 on an ordinary day. On a fall-back day 25: the clock reads 1:00 twice
 * (2026-11-01 in Chicago: 12am, 1am, 1am, 2am, …). On a spring-forward day
 * 23: the clock never reads 2:00 (2026-03-08: 12am, 1am, 3am, …). Each tick
 * sits exactly where a block starting at that wall-clock time is drawn.
 *
 * Walks the day in quarter-hour steps from its first instant (a local
 * midnight, or the DST jump that replaced it). Every zone offset in use since
 * 1972 is a whole number of quarter hours, so the steps land on every HH:00,
 * including after a half-hour shift (Lord Howe).
 */
export function hourTicks(dayStartMs: number, dayEndMs: number, timeZone: string): HourTick[] {
  const ticks: HourTick[] = [];
  for (let t = dayStartMs; t < dayEndMs; t += QUARTER_MS) {
    const { hour, minute } = wallClock(t, timeZone);
    if (minute === 0) ticks.push({ offsetMs: t - dayStartMs, hour, label: hourLabel(hour) });
  }
  return ticks;
}

// ─── blockPositionFromReservation ─────────────────────────────────────────────

/**
 * blockPositionFromReservation — compute the left/width percentages for a
 * reservation block on the day [dayStartMs, dayEndMs).
 *
 * Formula (per board UX spec §1), with dayLength = dayEndMs − dayStartMs:
 *   leftPct  = clamp((startAt - dayStart) / dayLength * 100, 0, 100)
 *   widthPct = clamp((endAt - startAt) / dayLength * 100, 0, 100 - leftPct)
 *
 * An event starting before day-start is clamped to leftPct=0.
 * An event ending after the day's end has its width clamped so left+width ≤ 100.
 *
 * @param reservation  - The reservation row (startAt / endAt as Date objects).
 * @param dayStartMs   - The day's first instant, epoch ms (dayWindow(day, tz).from).
 * @param dayEndMs     - The next day's first instant, epoch ms (dayWindow(day, tz).to).
 *                       The board always passes it: DST days are 23 or 25 h long.
 *                       Omitted, the day is taken to be an ordinary 24 h.
 * @returns            - { leftPct, widthPct } both in [0, 100]; sum ≤ 100.
 */
export function blockPositionFromReservation(
  reservation: Pick<ReservationRow, 'startAt' | 'endAt'>,
  dayStartMs: number,
  dayEndMs: number = dayStartMs + ORDINARY_DAY_MS,
): BlockPosition {
  const dayLengthMs = dayEndMs - dayStartMs;

  // Clamp the event's visible window to [dayStart, dayEnd].
  const visibleStart = Math.max(reservation.startAt.getTime(), dayStartMs);
  const visibleEnd = Math.min(reservation.endAt.getTime(), dayEndMs);

  // Event entirely outside the day (before or after): render as zero-size.
  if (visibleEnd <= visibleStart) {
    return { leftPct: 0, widthPct: 0 };
  }

  const leftPct = ((visibleStart - dayStartMs) / dayLengthMs) * 100;
  const widthPct = ((visibleEnd - visibleStart) / dayLengthMs) * 100;

  // Clamp for floating-point safety — sum must not exceed 100.
  const clampedLeft = Math.max(0, Math.min(100, leftPct));
  const clampedWidth = Math.max(0, Math.min(100 - clampedLeft, widthPct));

  return { leftPct: clampedLeft, widthPct: clampedWidth };
}

// ─── snapTo15Min ──────────────────────────────────────────────────────────────

/**
 * snapTo15Min — round an epoch-ms timestamp to the nearest 15-minute boundary.
 *
 * Uses standard rounding (ties round up).  The result is an epoch-ms value
 * that falls exactly on a 15-minute mark (i.e. ms % (15*60*1000) === 0).
 *
 * @param ms - The epoch timestamp to snap, in milliseconds.
 * @returns  - The snapped epoch timestamp (ms).
 */
export function snapTo15Min(ms: number): number {
  return Math.round(ms / QUARTER_MS) * QUARTER_MS;
}

// ─── dropToNewStartAt ─────────────────────────────────────────────────────────

/**
 * dropToNewStartAt — convert a pointer X offset (px) into a snapped start Date
 * for a drag-and-drop reschedule operation.
 *
 * The time track is `trackWidth` pixels wide and represents the day
 * [dayStartMs, dayEndMs) — 23, 24 or 25 hours.
 *
 * @param pointerX   - Horizontal position of the drop event relative to the track's
 *                     left edge (pixels, ≥ 0).
 * @param trackWidth - Total width of the time track in pixels (> 0).
 * @param dayStartMs - Epoch ms of the day's first instant.
 * @param dayEndMs   - Epoch ms of the next day's first instant.
 * @returns          - A Date snapped to the nearest 15-minute boundary.
 */
export function dropToNewStartAt(
  pointerX: number,
  trackWidth: number,
  dayStartMs: number,
  dayEndMs: number,
): Date {
  // Clamp pointer to [0, trackWidth] to handle drops at the very edges.
  const clampedX = Math.max(0, Math.min(trackWidth, pointerX));
  const rawMs = dayStartMs + (clampedX / trackWidth) * (dayEndMs - dayStartMs);
  return new Date(snapTo15Min(rawMs));
}

// ─── fanOutBlocks ─────────────────────────────────────────────────────────────

/**
 * fanOutBlocks — expand reservations into a flat list of BoardBlocks: one block
 * per (reservation × resource-row the reservation occupies).
 *
 * Multi-resource reservations produce N blocks — e.g. an aircraft+instructor
 * booking yields one block in the aircraft row and one in the instructor row,
 * both sharing reservationId and therefore rendering with the same hue.
 *
 * Cancelled reservations are excluded (spec §3: "Cancelled never rendered").
 *
 * Only resources that exist in `activeResourceIds` produce a block — this
 * prevents dangling blocks for resources that were deactivated after the
 * reservation was created.
 *
 * @param reservations      - The reservations returned by listReservations (active only).
 * @param activeResourceIds - Set of resource ids currently present on the board.
 * @param dayStartMs        - Epoch ms of the day's first instant.
 * @param dayEndMs          - Epoch ms of the next day's first instant.
 * @returns                 - Flat array of BoardBlock, one per (reservation × resource).
 */
export function fanOutBlocks(
  reservations: ReservationRow[],
  activeResourceIds: Set<string>,
  dayStartMs: number,
  dayEndMs: number,
): BoardBlock[] {
  const blocks: BoardBlock[] = [];

  for (const reservation of reservations) {
    // Cancelled are excluded (listReservations defaults to booked-only, but
    // guard here too in case includeCancelled was passed).
    if (reservation.status === 'cancelled') continue;

    const position = blockPositionFromReservation(reservation, dayStartMs, dayEndMs);

    // Midnight-spanning: the reservation runs past the day's last instant.
    const clippedEnd = reservation.endAt.getTime() > dayEndMs;

    for (const resourceId of reservation.resourceIds) {
      if (!activeResourceIds.has(resourceId)) continue;

      blocks.push({
        reservationId: reservation.id,
        resourceId,
        startAt: reservation.startAt,
        endAt: reservation.endAt,
        position,
        clippedEnd,
        reservation,
      });
    }
  }

  return blocks;
}

// ─── groupResourcesByKind ──────────────────────────────────────────────────────

/**
 * groupResourcesByKind — split an array of ResourceRows into aircraft and
 * instructor groups, preserving the original order within each group.
 *
 * The API already returns resources ordered by kind then displayName (see
 * list-resources.ts), so this is a simple partition rather than a sort.
 *
 * Board rendering order: aircraft rows first, then a group separator, then
 * instructor rows (per board UX spec §1).
 *
 * @param resources - ResourceRow[] (typically active-only from listResources({})).
 * @returns         - { aircraft: ResourceRow[], instructors: ResourceRow[] }.
 */
export function groupResourcesByKind(resources: ResourceRow[]): GroupedResources {
  const aircraft: ResourceRow[] = [];
  const instructors: ResourceRow[] = [];

  for (const r of resources) {
    if (r.kind === 'aircraft') {
      aircraft.push(r);
    } else {
      // Any non-aircraft kind is treated as an instructor for display purposes.
      instructors.push(r);
    }
  }

  return { aircraft, instructors };
}
