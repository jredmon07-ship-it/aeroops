/**
 * board-block.tsx — One reservation block on the dispatch board.
 *
 * Absolute-positioned div inside the resource row's time track.
 * Color = deterministic hue from reservationId (hsl(hue,60%,45%), white text).
 * Draggable when canDrag=true and screen width >= 640px.
 * "Move" trigger (Enter/Space on focus, or click on mobile) opens Move dialog.
 *
 * Multi-resource linkage: sibling highlight driven by hoveredReservationId prop.
 */
'use client';

import * as React from 'react';
import { formatTimeRange } from '../../_utils/format-time';
import type { BoardBlock as BoardBlockData } from '../_utils/board-layout';
import type { ResourceRow } from '@aeroops/api';

/** Derive a deterministic hue in [30, 330) from a reservation id. */
export function reservationHue(reservationId: string): number {
  const hex = reservationId.replace(/-/g, '').slice(0, 8);
  const n = parseInt(hex, 16);
  return (isNaN(n) ? 0 : n % 300) + 30;
}

interface BoardBlockProps {
  block: BoardBlockData;
  /** Whether the current user has schedule:create_reservation. */
  canDrag: boolean;
  /** The resource id being dragged (to show sibling ring). */
  draggedReservationId: string | null;
  /** The reservation id being hovered (to show peer highlight). */
  hoveredReservationId: string | null;
  /** All active resources (to find partner names for multi-resource). */
  resources: ResourceRow[];
  /** Whether this block is currently in optimistic-pending state. */
  isPending: boolean;
  /** Whether this block's action is being submitted. */
  isSubmitting: boolean;
  /** Callbacks */
  onDragStart: (e: React.DragEvent<HTMLDivElement>, block: BoardBlockData) => void;
  onDragEnd: () => void;
  onHoverEnter: (reservationId: string) => void;
  onHoverLeave: () => void;
  /** Called when "Move" is triggered (keyboard path / mobile tap). */
  onMoveClick: (block: BoardBlockData) => void;
}

/** Returns true when the viewport is at least 640 px wide (sm breakpoint). */
function useIsWide(): boolean {
  const [isWide, setIsWide] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') return true; // SSR: default true, corrected on mount
    return window.matchMedia('(min-width: 640px)').matches;
  });

  React.useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)');
    setIsWide(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsWide(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  return isWide;
}

export function BoardBlock({
  block,
  canDrag,
  draggedReservationId,
  hoveredReservationId,
  resources,
  isPending,
  isSubmitting,
  onDragStart,
  onDragEnd,
  onHoverEnter,
  onHoverLeave,
  onMoveClick,
}: BoardBlockProps) {
  const hue = reservationHue(block.reservationId);
  const isSiblingDragging =
    draggedReservationId === block.reservationId &&
    draggedReservationId !== null;
  const isSiblingHovered =
    hoveredReservationId === block.reservationId &&
    hoveredReservationId !== null;

  // Disable native drag on mobile (<640px) per spec §3.
  const isWide = useIsWide();

  // Partner resource names for multi-resource blocks
  const resourceMap = React.useMemo(
    () => new Map(resources.map((r) => [r.id, r])),
    [resources],
  );
  const partnerNames = block.reservation.resourceIds
    .filter((id) => id !== block.resourceId)
    .map((id) => resourceMap.get(id)?.displayName ?? 'Unknown')
    .join(', ');

  const blockColor = `hsl(${hue}, 60%, 45%)`;
  const { leftPct, widthPct } = block.position;

  // Is this block narrow? (<4% ≈ ~58min on a full-day 4800px track)
  const isNarrow = widthPct < 4;

  // Drag is available for mouse/keyboard users on non-mobile viewports only.
  const isDraggable = canDrag && !isSubmitting && isWide;

  const ariaLabel = [
    `Reservation ${formatTimeRange(block.startAt, block.endAt)}`,
    partnerNames ? `linked with ${partnerNames}` : null,
    block.reservation.seriesId ? 'recurring series' : null,
    !canDrag ? '(read-only)' : null,
  ]
    .filter(Boolean)
    .join(', ');

  // Only interactive (click/keydown) when the user has the move capability.
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onMoveClick(block);
    }
  }

  return (
    <div
      role={canDrag ? 'button' : 'article'}
      aria-label={ariaLabel}
      aria-disabled={!canDrag || isSubmitting || undefined}
      aria-describedby={canDrag ? 'board-move-hint' : undefined}
      tabIndex={canDrag ? 0 : undefined}
      draggable={isDraggable}
      className={[
        'absolute top-1 bottom-1 rounded-md px-2 flex flex-col justify-center overflow-hidden',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-1',
        'transition-all duration-150 select-none',
        isDraggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
        isPending ? 'opacity-60 ring-2 ring-white/50' : '',
        isSubmitting ? 'opacity-40 animate-pulse' : '',
        isSiblingDragging
          ? 'ring-2 ring-yellow-300 ring-offset-1 opacity-50'
          : '',
        isSiblingHovered ? 'ring-2 ring-white ring-offset-2' : '',
        block.clippedEnd ? 'border-r-2 border-dashed border-white/60' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      style={{
        left: `${leftPct}%`,
        width: `${widthPct}%`,
        backgroundColor: blockColor,
        minWidth: '2px',
      }}
      onMouseEnter={() => onHoverEnter(block.reservationId)}
      onMouseLeave={onHoverLeave}
      onFocus={() => onHoverEnter(block.reservationId)}
      onBlur={onHoverLeave}
      onDragStart={isDraggable ? (e) => onDragStart(e, block) : undefined}
      onDragEnd={isDraggable ? onDragEnd : undefined}
      onKeyDown={canDrag ? handleKeyDown : undefined}
      onClick={canDrag ? () => onMoveClick(block) : undefined}
    >
      {/* Time range */}
      <span className="text-xs font-medium text-white leading-tight truncate">
        {formatTimeRange(block.startAt, block.endAt)}
      </span>

      {/* Partner resource line (hidden on narrow blocks) */}
      {!isNarrow && partnerNames && (
        <span className="text-[10px] text-white/80 leading-tight truncate">
          {partnerNames}
        </span>
      )}

      {/* Series pill */}
      {!isNarrow && block.reservation.seriesId && (
        <span className="inline-flex items-center gap-0.5 text-[10px] text-white/90 mt-0.5">
          <span aria-hidden="true">⟳</span> Series
        </span>
      )}
    </div>
  );
}
