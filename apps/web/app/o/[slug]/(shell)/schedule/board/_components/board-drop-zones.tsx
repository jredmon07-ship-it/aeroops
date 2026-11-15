/**
 * board-drop-zones.tsx — 15-min drop cells rendered during an active drag.
 *
 * Covers the whole day's track: one cell per quarter hour from the day's first
 * instant — 96 on most days, 92 / 100 on DST days (quarterCount). Cell i
 * starts at dayStartMs + i × 15 min. Active cell is highlighted; accepts
 * onDrop / onDragOver per cell.
 */
'use client';

import * as React from 'react';
import { HOUR_WIDTH_PX } from '../_utils/board-layout';

/** One 15-min cell: a quarter of an hour's width. */
const CELL_WIDTH = HOUR_WIDTH_PX / 4;

interface BoardDropZonesProps {
  /** The day's 15-min cells: quarterCount(dayStartMs, dayEndMs). */
  cellCount: number;
  /** Index of the currently-hovered cell (null = none). */
  hoveredCellIndex: number | null;
  onDragOver: (e: React.DragEvent<HTMLDivElement>, cellIndex: number) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>, cellIndex: number) => void;
  onDragLeave: () => void;
}

export function BoardDropZones({
  cellCount,
  hoveredCellIndex,
  onDragOver,
  onDrop,
  onDragLeave,
}: BoardDropZonesProps) {
  return (
    <div
      className="absolute inset-0 flex"
      style={{ width: cellCount * CELL_WIDTH }}
      aria-hidden="true"
    >
      {Array.from({ length: cellCount }, (_, i) => (
        <div
          key={i}
          className={[
            'h-full flex-shrink-0 border-r border-transparent transition-colors duration-75',
            hoveredCellIndex === i
              ? 'bg-brand/10 border-brand/40'
              : '',
          ].join(' ')}
          style={{ width: CELL_WIDTH }}
          onDragOver={(e) => onDragOver(e, i)}
          onDrop={(e) => onDrop(e, i)}
          onDragLeave={onDragLeave}
        />
      ))}
    </div>
  );
}
