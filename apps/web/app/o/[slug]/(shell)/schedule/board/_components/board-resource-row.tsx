/**
 * board-resource-row.tsx — One horizontal resource row in the board grid.
 *
 * Contains:
 *  - All BoardBlock elements for this resource
 *  - BoardDropZones (rendered only during active drag)
 *  - BoardSnapPreview (rendered only when this is the hovered drop-target row)
 */
'use client';

import * as React from 'react';
import type { ResourceRow } from '@aeroops/api';
import type { BoardBlock as BoardBlockData } from '../_utils/board-layout';
import { BoardBlock } from './board-block';
import { BoardDropZones } from './board-drop-zones';
import { BoardSnapPreview } from './board-snap-preview';
import { reservationHue } from './board-block';
import { TRACK_WIDTH_PX } from './board-time-axis';

interface BoardResourceRowProps {
  resource: ResourceRow;
  blocks: BoardBlockData[];
  canDrag: boolean;
  isDragActive: boolean;
  draggedReservationId: string | null;
  hoveredReservationId: string | null;
  pendingReservationIds: Set<string>;
  submittingReservationIds: Set<string>;
  /** Which resource row is currently being dragged over (for snap preview). */
  isDropTarget: boolean;
  /** Snap-preview slot (only shown when isDropTarget). */
  snapPreview: { newStartAt: Date; newEndAt: Date; hue: number } | null;
  dayStartMs: number;
  onBlockDragStart: (e: React.DragEvent<HTMLDivElement>, block: BoardBlockData) => void;
  onBlockDragEnd: () => void;
  onHoverEnter: (reservationId: string) => void;
  onHoverLeave: () => void;
  onMoveClick: (block: BoardBlockData) => void;
  onDropZoneDragOver: (e: React.DragEvent<HTMLDivElement>, cellIndex: number, resourceId: string) => void;
  onDropZoneDrop: (e: React.DragEvent<HTMLDivElement>, cellIndex: number, resourceId: string) => void;
  onDropZoneDragLeave: () => void;
  hoveredCellIndex: number | null;
  resources: ResourceRow[];
}

export function BoardResourceRow({
  resource,
  blocks,
  canDrag,
  isDragActive,
  draggedReservationId,
  hoveredReservationId,
  pendingReservationIds,
  submittingReservationIds,
  isDropTarget,
  snapPreview,
  dayStartMs,
  onBlockDragStart,
  onBlockDragEnd,
  onHoverEnter,
  onHoverLeave,
  onMoveClick,
  onDropZoneDragOver,
  onDropZoneDrop,
  onDropZoneDragLeave,
  hoveredCellIndex,
  resources,
}: BoardResourceRowProps) {
  return (
    <div
      role="row"
      aria-label={`${resource.kind === 'aircraft' ? 'Aircraft' : 'Instructor'} ${resource.displayName}`}
      className="relative h-16 border-b border-slate-100 flex-shrink-0"
      style={{ width: TRACK_WIDTH_PX }}
    >
      {/* Drop zones — only during active drag */}
      {isDragActive && (
        <BoardDropZones
          hoveredCellIndex={isDropTarget ? hoveredCellIndex : null}
          onDragOver={(e, cellIndex) =>
            onDropZoneDragOver(e, cellIndex, resource.id)
          }
          onDrop={(e, cellIndex) =>
            onDropZoneDrop(e, cellIndex, resource.id)
          }
          onDragLeave={onDropZoneDragLeave}
        />
      )}

      {/* Snap preview — only on the current drop-target row */}
      {isDropTarget && snapPreview && (
        <BoardSnapPreview
          newStartAt={snapPreview.newStartAt}
          newEndAt={snapPreview.newEndAt}
          dayStartMs={dayStartMs}
          hue={snapPreview.hue}
        />
      )}

      {/* Reservation blocks */}
      {blocks.map((block) => (
        <BoardBlock
          key={`${block.reservationId}-${block.resourceId}`}
          block={block}
          canDrag={canDrag}
          draggedReservationId={draggedReservationId}
          hoveredReservationId={hoveredReservationId}
          resources={resources}
          isPending={pendingReservationIds.has(block.reservationId)}
          isSubmitting={submittingReservationIds.has(block.reservationId)}
          onDragStart={onBlockDragStart}
          onDragEnd={onBlockDragEnd}
          onHoverEnter={onHoverEnter}
          onHoverLeave={onHoverLeave}
          onMoveClick={onMoveClick}
        />
      ))}
    </div>
  );
}
