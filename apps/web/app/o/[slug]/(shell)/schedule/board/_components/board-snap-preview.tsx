/**
 * board-snap-preview.tsx — Ghost block showing the proposed new time during drag.
 *
 * Rendered as a semi-transparent overlay in the drop-target row to let the
 * user see exactly where the reservation will land before releasing.
 */
import * as React from 'react';
import { formatTimeRange } from '../../_utils/format-time';

interface BoardSnapPreviewProps {
  /** Start time of the proposed new slot. */
  newStartAt: Date;
  /** End time of the proposed new slot (duration preserved). */
  newEndAt: Date;
  /** Day start epoch ms (midnight). */
  dayStartMs: number;
  /** Hue of the original block. */
  hue: number;
}

export function BoardSnapPreview({
  newStartAt,
  newEndAt,
  dayStartMs,
  hue,
}: BoardSnapPreviewProps) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const leftPct = Math.max(
    0,
    Math.min(
      100,
      ((newStartAt.getTime() - dayStartMs) / DAY_MS) * 100,
    ),
  );
  const rawWidth =
    ((newEndAt.getTime() - newStartAt.getTime()) / DAY_MS) * 100;
  const widthPct = Math.max(0, Math.min(100 - leftPct, rawWidth));

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
        {formatTimeRange(newStartAt, newEndAt)}
      </span>
    </div>
  );
}
