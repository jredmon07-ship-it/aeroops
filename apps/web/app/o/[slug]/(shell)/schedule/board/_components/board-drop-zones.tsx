/**
 * board-drop-zones.tsx — 15-min drop cells rendered during an active drag.
 *
 * Covers the full 24-hour track with 96 cells (24h × 4 quarters each).
 * Active cell is highlighted; accepts onDrop / onDragOver per cell.
 */
'use client';

import * as React from 'react';
import { TRACK_WIDTH_PX } from './board-time-axis';

/** Total 15-min cells in a day (24h × 4 quarters). */
const CELL_COUNT = 96;
const CELL_WIDTH = TRACK_WIDTH_PX / CELL_COUNT;

interface BoardDropZonesProps {
  /** Index of the currently-hovered cell (null = none). */
  hoveredCellIndex: number | null;
  onDragOver: (e: React.DragEvent<HTMLDivElement>, cellIndex: number) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>, cellIndex: number) => void;
  onDragLeave: () => void;
}

export function BoardDropZones({
  hoveredCellIndex,
  onDragOver,
  onDrop,
  onDragLeave,
}: BoardDropZonesProps) {
  return (
    <div
      className="absolute inset-0 flex"
      style={{ width: TRACK_WIDTH_PX }}
      aria-hidden="true"
    >
      {Array.from({ length: CELL_COUNT }, (_, i) => (
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
