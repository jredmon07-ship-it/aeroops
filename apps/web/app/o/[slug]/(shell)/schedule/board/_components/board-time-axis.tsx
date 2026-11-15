/**
 * board-time-axis.tsx — Sticky top row showing hour labels + 15-min tick marks.
 *
 * One calendar day at 200px per hour: 24 h (4800px) on most days, 23 h or 25 h
 * on DST days. The hour labels are the viewer's wall-clock hours
 * (hourTicks in ../_utils/board-layout.ts), placed where a block starting at
 * that time is drawn: the fall-back day shows 1am twice, the spring-forward
 * day has no 2am. A closing label marks the day's end; 15-min ticks between.
 */
import * as React from 'react';
import { HOUR_MS, HOUR_WIDTH_PX, QUARTER_MS, type HourTick } from '../_utils/board-layout';

interface BoardTimeAxisProps {
  /** The day's hour labels: hourTicks(dayStartMs, dayEndMs, timeZone). */
  ticks: HourTick[];
  /** The day's real length, dayEndMs − dayStartMs (23, 24 or 25 h). */
  dayLengthMs: number;
  /** Label at the day's end — the next day's first hour, normally "12am". */
  endLabel: string;
}

/** Pixels from the track's left edge for an offset into the day. */
function px(offsetMs: number): number {
  return (offsetMs / HOUR_MS) * HOUR_WIDTH_PX;
}

export function BoardTimeAxis({ ticks, dayLengthMs, endLabel }: BoardTimeAxisProps) {
  const hourOffsets = new Set(ticks.map((t) => t.offsetMs));
  const quarterOffsets: number[] = [];
  for (let offsetMs = QUARTER_MS; offsetMs < dayLengthMs; offsetMs += QUARTER_MS) {
    if (!hourOffsets.has(offsetMs)) quarterOffsets.push(offsetMs);
  }
  const labels = [...ticks, { offsetMs: dayLengthMs, label: endLabel }];

  return (
    <div
      className="relative h-8 flex-shrink-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800"
      style={{ width: px(dayLengthMs) }}
      aria-hidden="true"
    >
      {labels.map((t) => (
        <div
          key={t.offsetMs}
          className="absolute top-0 flex flex-col items-start"
          style={{ left: px(t.offsetMs) }}
        >
          {/* Hour label */}
          <span className="text-[0.6875rem] text-slate-500 dark:text-slate-400 font-medium pl-1 leading-tight pt-0.5">
            {t.label}
          </span>
          {/* Hour tick mark */}
          <div className="h-2 w-px bg-slate-300 dark:bg-slate-600 ml-0.5" />
        </div>
      ))}
      {/* 15-min tick marks between hours */}
      {quarterOffsets.map((offsetMs) => (
        <div
          key={`q-${offsetMs}`}
          className="absolute bottom-0 h-1 w-px bg-slate-200 dark:bg-slate-700"
          style={{ left: px(offsetMs) }}
        />
      ))}
    </div>
  );
}
