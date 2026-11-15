/**
 * board-snap-preview.tsx — Ghost block showing the proposed new time during drag.
 *
 * Rendered as a semi-transparent overlay in the drop-target row to let the
 * user see exactly where the reservation will land before releasing. Placed
 * with the same math as the blocks (the day's real length, DST days included)
 * and labelled on the viewer's clock, like them.
 */
import * as React from 'react';
import { formatTimeRange } from '../../_utils/format-time';
import { blockPositionFromReservation } from '../_utils/board-layout';

interface BoardSnapPreviewProps {
  /** Start time of the proposed new slot. */
  newStartAt: Date;
  /** End time of the proposed new slot (duration preserved). */
  newEndAt: Date;
  /** Epoch ms of the day's first instant (the track's left edge). */
  dayStartMs: number;
  /** Epoch ms of the next day's first instant (the track's right edge). */
  dayEndMs: number;
  /** The viewer's IANA zone, for the time label. */
  timeZone: string;
  /** Hue of the original block. */
  hue: number;
}

export function BoardSnapPreview({
  newStartAt,
  newEndAt,
  dayStartMs,
  dayEndMs,
  timeZone,
  hue,
}: BoardSnapPreviewProps) {
  const { leftPct, widthPct } = blockPositionFromReservation(
    { startAt: newStartAt, endAt: newEndAt },
    dayStartMs,
    dayEndMs,
  );

  return (
    <div
      className="absolute top-1 bottom-1 rounded-md pointer-events-none z-10"
      style={{
        left: `${leftPct}%`,
        width: `${widthPct}%`,
        backgroundColor: `hsl(${hue}, 60%, 45%)`,
        opacity: 0.4,
        border: `2px dashed hsl(${hue}, 60%, 35%)`,
      }}
      aria-hidden="true"
    >
      <span className="text-xs font-medium text-white px-1 truncate block pt-0.5">
        {formatTimeRange(newStartAt, newEndAt, timeZone)}
      </span>
    </div>
  );
}
