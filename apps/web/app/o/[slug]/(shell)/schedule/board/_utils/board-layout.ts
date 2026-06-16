/**
 * board/_utils/board-layout.ts — Pure layout helpers for the dispatch board.
 *
 * All functions are stateless and side-effect-free; they take plain values and
 * return plain values.  No React, no Next.js, no I/O.  Unit-testable in vitest
 * with a node environment.
 *
 * CONVENTIONS:
 *   - The board renders a full 24-hour day (00:00–24:00).
 *   - DAY_DURATION_MS = 24 * 60 * 60 * 1000 ms = 86 400 000 ms.
 *   - leftPct / widthPct are clamped to [0, 100] so midnight-spanning events
 *     clip cleanly to the visible track edges.
 *   - All percentages are numbers in [0, 100]; callers apply them as `left`/`width`
 *     CSS via inline style or utility classes.
 *   - The 15-minute snap grid is enforced by snapTo15Min (rounds to nearest 15).
 */

import type { ReservationRow } from '@aeroops/api';
import type { ResourceRow } from '@aeroops/api';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Full-day duration in milliseconds (24 h). */
export const DAY_DURATION_MS = 24 * 60 * 60 * 1000;

/** 15-minute snap quantum in milliseconds. */
const SNAP_MS = 15 * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * BlockPosition — the CSS-ready percentage values for a board block's
 * horizontal placement inside the time track.
 *
 *   leftPct  — distance from the track's left edge (day start) in %.
 *   widthPct — block width as a percentage of the total track width.
 *
 * Both are clamped to [0, 100] and their sum never exceeds 100.
 * A midnight-spanning event that extends beyond 24:00 will have a reduced
 * widthPct (clamped) and should be rendered with a dashed right border to
 * signal the truncation (per board UX spec §1).
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

// ─── blockPositionFromReservation ─────────────────────────────────────────────

/**
 * blockPositionFromReservation — compute the left/width percentages for a
 * reservation block given the day's start epoch (ms).
 *
 * Formula (per board UX spec §1):
 *   leftPct  = clamp((startAt - dayStart) / DAY_DURATION_MS * 100, 0, 100)
 *   widthPct = clamp((endAt - startAt) / DAY_DURATION_MS * 100, 0, 100 - leftPct)
 *
 * An event starting before day-start is clamped to leftPct=0.
 * An event ending after 24:00 has its width clamped so left+width ≤ 100.
 *
 * @param reservation  - The reservation row (startAt / endAt as Date objects).
 * @param dayStartMs   - The day-start epoch in ms (midnight of the board day).
 * @returns            - { leftPct, widthPct } both in [0, 100]; sum ≤ 100.
 */
export function blockPositionFromReservation(
  reservation: Pick<ReservationRow, 'startAt' | 'endAt'>,
  dayStartMs: number,
): BlockPosition {
  const dayEndMs = dayStartMs + DAY_DURATION_MS;

  // Clamp the event's visible window to [dayStart, dayEnd].
  const visibleStart = Math.max(reservation.startAt.getTime(), dayStartMs);
  const visibleEnd = Math.min(reservation.endAt.getTime(), dayEndMs);

  // Event entirely outside the day (before or after): render as zero-size.
  if (visibleEnd <= visibleStart) {
    return { leftPct: 0, widthPct: 0 };
  }

  const leftPct = ((visibleStart - dayStartMs) / DAY_DURATION_MS) * 100;
  const widthPct = ((visibleEnd - visibleStart) / DAY_DURATION_MS) * 100;

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
  return Math.round(ms / SNAP_MS) * SNAP_MS;
}

// ─── dropToNewStartAt ─────────────────────────────────────────────────────────

/**
 * dropToNewStartAt — convert a pointer X offset (px) into a snapped start Date
 * for a drag-and-drop reschedule operation.
 *
 * The time track is `trackWidth` pixels wide and represents `DAY_DURATION_MS`
 * milliseconds starting at `dayStartMs`.
 *
 * @param pointerX  - Horizontal position of the drop event relative to the track's
 *                    left edge (pixels, ≥ 0).
 * @param trackWidth - Total width of the time track in pixels (> 0).
 * @param dayStartMs - Epoch ms for the start of the board day (midnight).
 * @returns          - A Date snapped to the nearest 15-minute boundary.
 */
export function dropToNewStartAt(
  pointerX: number,
  trackWidth: number,
  dayStartMs: number,
): Date {
  // Clamp pointer to [0, trackWidth] to handle drops at the very edges.
  const clampedX = Math.max(0, Math.min(trackWidth, pointerX));
  const rawMs = dayStartMs + (clampedX / trackWidth) * DAY_DURATION_MS;
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
 * @param reservations    - The reservations returned by listReservations (active only).
 * @param activeResourceIds - Set of resource ids currently present on the board.
 * @param dayStartMs      - Epoch ms for midnight of the board day.
 * @returns               - Flat array of BoardBlock, one per (reservation × resource).
 */
export function fanOutBlocks(
  reservations: ReservationRow[],
  activeResourceIds: Set<string>,
  dayStartMs: number,
): BoardBlock[] {
  const blocks: BoardBlock[] = [];

  for (const reservation of reservations) {
    // Cancelled are excluded (listReservations defaults to booked-only, but
    // guard here too in case includeCancelled was passed).
    if (reservation.status === 'cancelled') continue;

    const position = blockPositionFromReservation(reservation, dayStartMs);

    // Detect midnight-spanning: if the raw right edge exceeds 100.
    const rawLeft = ((reservation.startAt.getTime() - dayStartMs) / DAY_DURATION_MS) * 100;
    const rawWidth = ((reservation.endAt.getTime() - reservation.startAt.getTime()) / DAY_DURATION_MS) * 100;
    const clippedEnd = rawLeft + rawWidth > 100;

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
