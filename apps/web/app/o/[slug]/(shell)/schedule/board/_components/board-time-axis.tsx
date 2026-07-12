/**
 * board-time-axis.tsx — Sticky top row showing hour labels + 15-min tick marks.
 *
 * Full day 00:00–24:00 rendered at 200px/hr (total track width 4800px).
 * Hour labels shown at each hour mark; 15-min ticks between hours.
 */
import * as React from 'react';

/** Total track width in pixels (24 hr × 200 px/hr). */
export const TRACK_WIDTH_PX = 4800;
/** Width per hour in pixels. */
export const HOUR_WIDTH_PX = 200;

/** Format an hour number (0–24) as a short string, e.g. 0→"12am", 6→"6am". */
function hourLabel(h: number): string {
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  if (h < 12) return `${h}am`;
  return `${h - 12}pm`;
}

export function BoardTimeAxis() {
  return (
    <div
      className="relative h-8 flex-shrink-0 bg-white border-b border-slate-200"
      style={{ width: TRACK_WIDTH_PX }}
      aria-hidden="true"
    >
      {Array.from({ length: 25 }, (_, h) => (
        <div
          key={h}
          className="absolute top-0 flex flex-col items-start"
          style={{ left: h * HOUR_WIDTH_PX }}
        >
          {/* Hour label */}
          <span className="text-[0.6875rem] text-slate-400 font-medium pl-1 leading-tight pt-0.5">
            {hourLabel(h)}
          </span>
          {/* Hour tick mark */}
          <div className="h-2 w-px bg-slate-300 ml-0.5" />
        </div>
      ))}
      {/* 15-min tick marks between hours */}
      {Array.from({ length: 24 }, (_, h) =>
        [1, 2, 3].map((q) => (
          <div
            key={`${h}-${q}`}
            className="absolute bottom-0 h-1 w-px bg-slate-200"
            style={{ left: h * HOUR_WIDTH_PX + q * (HOUR_WIDTH_PX / 4) }}
          />
        )),
      )}
    </div>
  );
}
