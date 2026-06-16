/**
 * board-block.tsx — One reservation block on the dispatch board.
 *
 * Absolute-positioned div inside the resource row's time track.
 * Color = deterministic hue from reservationId (hsl(hue,60%,45%), white text).
 * Draggable when canDrag=true and screen width >= 640px.
 * "Move" trigger (Enter/Space on focus, or click on mobile) opens Move dialog.
 *
 * Multi-resource linkage: sibling highlight driven by hoveredReservationId prop.
 *
 * Slice 3a additions (ADDITIVE — 2c move/drag wiring untouched):
 *   - Dispatch state badge: none / open / closed.
 *   - Action affordances (canDispatch=true only):
 *       none+aircraft  → "Check out" button → onCheckOut callback
 *       open           → "Check in" + "Void" buttons → onCheckIn / onVoid
 *       closed         → read-only summary (flight time)
 *   - Dispatch ticket (optional) passed in; no fetching here.
 */
'use client';

import * as React from 'react';
import { formatTimeRange } from '../../_utils/format-time';
import type { BoardBlock as BoardBlockData } from '../_utils/board-layout';
import type { ResourceRow, DispatchTicketView } from '@aeroops/api';

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
  /** Whether the current user has dispatch:create (controls action buttons). */
  canDispatch: boolean;
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
  /**
   * The latest non-voided dispatch ticket for this reservation+resource combo,
   * or null/undefined when there is no open or closed ticket.
   */
  dispatchTicket?: DispatchTicketView | null;
  /** Callbacks */
  onDragStart: (e: React.DragEvent<HTMLDivElement>, block: BoardBlockData) => void;
  onDragEnd: () => void;
  onHoverEnter: (reservationId: string) => void;
  onHoverLeave: () => void;
  /** Called when "Move" is triggered (keyboard path / mobile tap). */
  onMoveClick: (block: BoardBlockData) => void;
  /** Called when "Check out" is triggered on a none block (aircraft only). */
  onCheckOut: (block: BoardBlockData) => void;
  /** Called when "Check in" is triggered on an open block. */
  onCheckIn: (block: BoardBlockData, ticket: DispatchTicketView) => void;
  /** Called when "Void" is triggered on an open block. */
  onVoid: (block: BoardBlockData, ticket: DispatchTicketView) => void;
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
  canDispatch,
  draggedReservationId,
  hoveredReservationId,
  resources,
  isPending,
  isSubmitting,
  dispatchTicket,
  onDragStart,
  onDragEnd,
  onHoverEnter,
  onHoverLeave,
  onMoveClick,
  onCheckOut,
  onCheckIn,
  onVoid,
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

  // ── Dispatch state (Slice 3a, additive) ──────────────────────────────────
  // Dispatch badges and action buttons only appear for aircraft resources.
  // Instructor resource rows carry the same reservation but dispatch only
  // happens at the aircraft level (resourceId is the aircraft).
  const thisResource = resourceMap.get(block.resourceId);
  const isAircraft = thisResource?.kind === 'aircraft';

  // Guard: treat the ticket as belonging to THIS block only when its resourceId
  // matches this block's aircraft. The dispatch ticket map is keyed by
  // reservationId (one ticket per reservation), but a reservation can span
  // multiple aircraft. Without this guard, a ticket opened on aircraft A would
  // show the 'Checked out' badge and Check-in/Void actions on aircraft B's
  // block — a silent records-integrity hazard (meters attributed to wrong tail).
  const ticketForThisResource =
    dispatchTicket && dispatchTicket.resourceId === block.resourceId
      ? dispatchTicket
      : null;

  const dispatchStatus = ticketForThisResource?.status ?? null;
  // 'none'  = no ticket (dispatchStatus === null)
  // 'open'  = ticket with status='open'
  // 'closed' = ticket with status='closed'
  // voided tickets come back as null from getDispatchForReservation (spec §3.4)

  const ariaLabel = [
    `Reservation ${formatTimeRange(block.startAt, block.endAt)}`,
    partnerNames ? `linked with ${partnerNames}` : null,
    block.reservation.seriesId ? 'recurring series' : null,
    isAircraft && dispatchStatus === 'open' ? 'checked out' : null,
    isAircraft && dispatchStatus === 'closed' ? 'checked in' : null,
    !canDrag ? '(read-only)' : null,
  ]
    .filter(Boolean)
    .join(', ');

  // Whether dispatch action buttons will be visible in this block.
  // When true, the outer container must NOT carry role="button" + tabIndex so
  // that real <button> descendants are not nested inside an interactive ARIA
  // role (WAI-ARIA prohibits focusable descendants inside role="button").
  const hasDispatchActions =
    isAircraft &&
    !isNarrow &&
    (canDispatch ||
      dispatchStatus === 'open' ||
      dispatchStatus === 'closed' ||
      dispatchStatus === null);

  // When the user can both drag/move AND has dispatch actions, we must NOT put
  // role="button" on the outer wrapper (would nest <button>s inside it).
  // Instead we render a dedicated "Move" button for the keyboard/move affordance.
  const useButtonWrapper = canDrag && !hasDispatchActions;

  // Outer wrapper key-down: only used when there are no dispatch actions and the
  // block itself acts as the button (the 2c original pattern).
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onMoveClick(block);
    }
  }

  // ── Shared position + visual classes ─────────────────────────────────────
  const wrapperClasses = [
    'absolute top-1 bottom-1 rounded-md flex flex-col justify-between overflow-hidden',
    'transition-all duration-150 select-none',
    isDraggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
    isPending ? 'opacity-60 ring-2 ring-white/50' : '',
    isSubmitting ? 'opacity-40 animate-pulse' : '',
    isSiblingDragging
      ? 'ring-2 ring-yellow-300 ring-offset-1 opacity-50'
      : '',
    isSiblingHovered ? 'ring-2 ring-white ring-offset-2' : '',
    block.clippedEnd ? 'border-r-2 border-dashed border-white/60' : '',
    // Focus ring only on the wrapper itself when it acts as a button.
    useButtonWrapper
      ? 'focus:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-1'
      : '',
  ]
    .filter(Boolean)
    .join(' ');

  const wrapperStyle: React.CSSProperties = {
    left: `${leftPct}%`,
    width: `${widthPct}%`,
    backgroundColor: blockColor,
    minWidth: '2px',
  };

  // ── Inner content (shared across both wrapper modes) ─────────────────────
  const blockContent = (
    <>
      {/* ── Primary content row ─────────────────────────────────────────── */}
      <div className="flex flex-col justify-center min-w-0 px-2 pt-1">
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

        {/* Move handle — only shown when dispatch actions are also present,
            so the drag/move affordance has a proper interactive target that is
            NOT an ancestor of the dispatch buttons (fixes ARIA nesting). */}
        {canDrag && hasDispatchActions && (
          <button
            type="button"
            onClick={() => onMoveClick(block)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onMoveClick(block);
              }
            }}
            disabled={isSubmitting}
            className="mt-0.5 self-start inline-flex items-center rounded px-1 py-0.5 text-[9px] font-medium bg-white/15 hover:bg-white/25 text-white/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white transition-colors leading-none"
            aria-label={`Move reservation ${formatTimeRange(block.startAt, block.endAt)}`}
            aria-describedby="board-move-hint"
          >
            Move
          </button>
        )}
      </div>

      {/* ── Dispatch section (Slice 3a, aircraft rows only) ─────────────── */}
      {isAircraft && !isNarrow && (
        <div
          className="flex items-center gap-1 mt-0.5 pb-1 px-2 flex-wrap"
          aria-label="Dispatch actions"
        >
          {/* ── none → Check out (canDispatch only) ───────────────────── */}
          {dispatchStatus === null && canDispatch && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCheckOut(block);
              }}
              className="inline-flex items-center rounded px-1 py-0.5 text-[10px] font-semibold bg-white/20 hover:bg-white/30 text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white transition-colors leading-none"
              aria-label="Check out aircraft"
            >
              Check out
            </button>
          )}

          {/* ── none → badge (viewer, no action) ─────────────────────── */}
          {dispatchStatus === null && !canDispatch && (
            <span className="inline-flex items-center rounded px-1 py-0.5 text-[10px] font-medium bg-white/15 text-white/70 leading-none">
              Not checked out
            </span>
          )}

          {/* ── open → badge + Check in + Void ────────────────────────── */}
          {dispatchStatus === 'open' && ticketForThisResource && (
            <>
              <span className="inline-flex items-center rounded px-1 py-0.5 text-[10px] font-semibold bg-amber-400/90 text-amber-900 leading-none">
                Checked out
              </span>
              {!isNarrow && (
                <span className="text-[9px] text-white/70 leading-none truncate">
                  Hobbs {ticketForThisResource.hobbsOut.toFixed(1)}
                </span>
              )}
              {canDispatch && (
                <>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCheckIn(block, ticketForThisResource);
                    }}
                    className="inline-flex items-center rounded px-1 py-0.5 text-[10px] font-semibold bg-white/20 hover:bg-white/30 text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white transition-colors leading-none"
                    aria-label="Check in aircraft"
                  >
                    Check in
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onVoid(block, ticketForThisResource);
                    }}
                    className="inline-flex items-center rounded px-1 py-0.5 text-[10px] font-semibold bg-red-500/60 hover:bg-red-500/80 text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white transition-colors leading-none"
                    aria-label="Void check-out"
                  >
                    Void
                  </button>
                </>
              )}
            </>
          )}

          {/* ── closed → read-only summary ─────────────────────────────── */}
          {dispatchStatus === 'closed' && ticketForThisResource && (
            <>
              <span className="inline-flex items-center rounded px-1 py-0.5 text-[10px] font-semibold bg-emerald-400/80 text-emerald-900 leading-none">
                Checked in
              </span>
              {ticketForThisResource.flightTimeHours !== null && (
                <span className="text-[9px] text-white/70 leading-none">
                  {ticketForThisResource.flightTimeHours.toFixed(1)} hr
                </span>
              )}
            </>
          )}
        </div>
      )}
    </>
  );

  // ── Render: two wrapper modes ─────────────────────────────────────────────
  //
  // Mode A (useButtonWrapper=true): no dispatch action buttons → safe to use
  //   role="button" on the wrapper (2c original pattern; fully backward compat).
  //
  // Mode B (hasDispatchActions=true): dispatch <button>s are present → outer
  //   wrapper is a plain article/div so real buttons are never nested inside
  //   role="button" (WAI-ARIA prohibits focusable descendants inside role="button").
  //   A dedicated "Move" button handle is rendered inside the content area above.

  if (useButtonWrapper) {
    return (
      <div
        role="button"
        aria-label={ariaLabel}
        aria-disabled={isSubmitting || undefined}
        aria-describedby="board-move-hint"
        tabIndex={0}
        draggable={isDraggable}
        className={wrapperClasses}
        style={wrapperStyle}
        onMouseEnter={() => onHoverEnter(block.reservationId)}
        onMouseLeave={onHoverLeave}
        onFocus={() => onHoverEnter(block.reservationId)}
        onBlur={onHoverLeave}
        onDragStart={isDraggable ? (e) => onDragStart(e, block) : undefined}
        onDragEnd={isDraggable ? onDragEnd : undefined}
        onKeyDown={handleKeyDown}
        onClick={() => onMoveClick(block)}
      >
        {blockContent}
      </div>
    );
  }

  // Mode B: plain container (article or div), move affordance is a child button.
  return (
    <div
      role="article"
      aria-label={ariaLabel}
      draggable={isDraggable}
      className={wrapperClasses}
      style={wrapperStyle}
      onMouseEnter={() => onHoverEnter(block.reservationId)}
      onMouseLeave={onHoverLeave}
      onFocus={() => onHoverEnter(block.reservationId)}
      onBlur={onHoverLeave}
      onDragStart={isDraggable ? (e) => onDragStart(e, block) : undefined}
      onDragEnd={isDraggable ? onDragEnd : undefined}
    >
      {blockContent}
    </div>
  );
}
