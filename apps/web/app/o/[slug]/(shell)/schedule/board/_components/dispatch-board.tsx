/**
 * dispatch-board.tsx — Client orchestration for the dispatch board.
 *
 * Manages:
 *  - Board state (reservations, resources, drag state, optimistic moves)
 *  - Native HTML5 DnD (draggable + onDragStart/onDragOver/onDrop)
 *  - Optimistic move → rescheduleAction → ok:true confirm / ok:false snap-back
 *  - "Move to…" dialog (keyboard/mobile path; fully functional fallback)
 *  - Live regions for a11y feedback
 *  - Dispatch dialogs (Slice 3a — ADDITIVE, 2c wiring untouched):
 *      CheckOutDialog, CheckInDialog, VoidDispatchDialog
 *  - Local dispatch ticket map — updated optimistically on dialog success
 *    then confirmed by router.refresh() (or local state update).
 *
 * BOUNDARY: imports only from '@aeroops/api'; never '@aeroops/db'.
 * DnD: native HTML5 only, no npm dependency.
 */
'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, XCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { ConflictBanner } from '../../new/_components/conflict-banner';
import { BoardTimeAxis, TRACK_WIDTH_PX } from './board-time-axis';
import { BoardGutter } from './board-gutter';
import { BoardResourceRow } from './board-resource-row';
import { MoveReservationDialog } from './move-reservation-dialog';
import { CheckOutDialog } from './check-out-dialog';
import { CheckInDialog } from './check-in-dialog';
import { VoidDispatchDialog } from './void-dispatch-dialog';
import {
  fanOutBlocks,
  groupResourcesByKind,
} from '../_utils/board-layout';
import { rescheduleAction } from '../../actions';
import { formatDate, formatTimeRange } from '../../_utils/format-time';
import { reservationHue } from './board-block';
import type { ReservationRow, ResourceRow, ConflictHit, PolicyViolationView, DispatchTicketView } from '@aeroops/api';
import type { BoardBlock } from '../_utils/board-layout';

// ─── DnD transfer data ────────────────────────────────────────────────────────

interface DragPayload {
  reservationId: string;
  resourceId: string;
  durationMs: number;
}

const DRAG_DATA_KEY = 'application/aeroops-board-block';

// ─── Feedback state ───────────────────────────────────────────────────────────

type FeedbackState =
  | { kind: 'none' }
  | { kind: 'conflict'; conflicts: ConflictHit[] }
  | { kind: 'policy'; violations: PolicyViolationView[] }
  | { kind: 'conflict_and_policy'; conflicts: ConflictHit[]; violations: PolicyViolationView[] }
  | { kind: 'not_found' }
  | { kind: 'validation'; message: string }
  | { kind: 'server'; message?: string };

// ─── Props ────────────────────────────────────────────────────────────────────

interface DispatchBoardProps {
  initialReservations: ReservationRow[];
  resources: ResourceRow[];
  date: Date;
  canDrag: boolean;
  /** Whether the current user has dispatch:create. Controls action button visibility. */
  canDispatch: boolean;
  /**
   * Serialized dispatch ticket map from the RSC page: array of
   * [reservationId, DispatchTicketView|null] pairs (JSON-serializable).
   * The client reconstructs a Map<string, DispatchTicketView|null> from this.
   */
  initialDispatchTickets: Array<[string, DispatchTicketView | null]>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function DispatchBoard({
  initialReservations,
  resources,
  date,
  canDrag,
  canDispatch,
  initialDispatchTickets,
}: DispatchBoardProps) {
  const router = useRouter();

  // ── State ───────────────────────────────────────────────────────────────────
  const [reservations, setReservations] = React.useState(initialReservations);
  const [pendingIds, setPendingIds] = React.useState<Set<string>>(new Set());
  const [submittingIds, setSubmittingIds] = React.useState<Set<string>>(new Set());
  const [feedback, setFeedback] = React.useState<FeedbackState>({ kind: 'none' });
  const [ariaSuccess, setAriaSuccess] = React.useState('');
  const [ariaRefused, setAriaRefused] = React.useState('');
  const [isBoardBusy, setIsBoardBusy] = React.useState(false);

  // ── Dispatch ticket map (Slice 3a) ─────────────────────────────────────────
  // Reconstructed from the serialized RSC prop; updated locally on dialog success
  // then confirmed by router.refresh() which re-fetches from the server.
  const [dispatchTickets, setDispatchTickets] = React.useState<
    Map<string, DispatchTicketView | null>
  >(() => new Map(initialDispatchTickets));

  // ── DnD state ──────────────────────────────────────────────────────────────
  const [dragPayload, setDragPayload] = React.useState<DragPayload | null>(null);
  const [hoveredDropResourceId, setHoveredDropResourceId] = React.useState<string | null>(null);
  const [hoveredCellIndex, setHoveredCellIndex] = React.useState<number | null>(null);
  const [snapPreview, setSnapPreview] = React.useState<{
    newStartAt: Date;
    newEndAt: Date;
    hue: number;
  } | null>(null);
  const [hoveredReservationId, setHoveredReservationId] = React.useState<string | null>(null);
  const [draggedReservationId, setDraggedReservationId] = React.useState<string | null>(null);

  // ── Move dialog state ──────────────────────────────────────────────────────
  const [moveDialogOpen, setMoveDialogOpen] = React.useState(false);
  const [moveDialogBlock, setMoveDialogBlock] = React.useState<BoardBlock | null>(null);
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [dialogConflicts, setDialogConflicts] = React.useState<ConflictHit[] | null>(null);
  const [dialogViolations, setDialogViolations] = React.useState<PolicyViolationView[] | null>(null);
  const [dialogSubmitting, setDialogSubmitting] = React.useState(false);

  // ── Dispatch dialog state (Slice 3a) ───────────────────────────────────────
  // Check-out dialog
  const [checkOutOpen, setCheckOutOpen] = React.useState(false);
  const [checkOutBlock, setCheckOutBlock] = React.useState<BoardBlock | null>(null);

  // Check-in dialog
  const [checkInOpen, setCheckInOpen] = React.useState(false);
  const [checkInBlock, setCheckInBlock] = React.useState<BoardBlock | null>(null);
  const [checkInTicket, setCheckInTicket] = React.useState<DispatchTicketView | null>(null);

  // Void dialog
  const [voidOpen, setVoidOpen] = React.useState(false);
  const [voidBlock, setVoidBlock] = React.useState<BoardBlock | null>(null);
  const [voidTicket, setVoidTicket] = React.useState<DispatchTicketView | null>(null);

  // ── Computed ───────────────────────────────────────────────────────────────
  const dayStartMs = React.useMemo(() => {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }, [date]);

  const activeResourceIds = React.useMemo(
    () => new Set(resources.map((r) => r.id)),
    [resources],
  );

  const blocks = React.useMemo(
    () => fanOutBlocks(reservations, activeResourceIds, dayStartMs),
    [reservations, activeResourceIds, dayStartMs],
  );

  const grouped = React.useMemo(
    () => groupResourcesByKind(resources),
    [resources],
  );

  // Blocks indexed by resource id for quick lookup
  const blocksByResource = React.useMemo(() => {
    const map = new Map<string, BoardBlock[]>();
    for (const block of blocks) {
      const arr = map.get(block.resourceId) ?? [];
      arr.push(block);
      map.set(block.resourceId, arr);
    }
    return map;
  }, [blocks]);

  // ── Feedback auto-dismiss ──────────────────────────────────────────────────
  const feedbackTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  function showFeedback(state: FeedbackState) {
    setFeedback(state);
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    if (state.kind !== 'none') {
      feedbackTimerRef.current = setTimeout(() => setFeedback({ kind: 'none' }), 8000);
    }
  }

  React.useEffect(() => {
    return () => {
      if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    };
  }, []);

  // Scroll to 06:00 on mount
  const scrollRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (scrollRef.current) {
      // 6 hours × 200px/hr = 1200px
      scrollRef.current.scrollLeft = 1200;
    }
  }, []);

  // ── Reschedule handler (shared by DnD + dialog) ────────────────────────────
  async function executeReschedule(
    reservationId: string,
    newStartAt: Date,
    newEndAt: Date,
    newResourceIds: string[] | undefined,
    onSuccess?: () => void,
    onFailure?: () => void,
  ) {
    // Find original reservation for snap-back
    const original = reservations.find((r) => r.id === reservationId);
    if (!original) return;

    // Optimistic update: mark as pending
    setPendingIds((prev) => new Set([...prev, reservationId]));
    setSubmittingIds((prev) => new Set([...prev, reservationId]));
    setIsBoardBusy(true);

    try {
      const result = await rescheduleAction({
        reservationId,
        newStartAt,
        newEndAt,
        newResourceIds,
      });

      if ('error' in result) {
        // Snap back
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(reservationId);
          return next;
        });
        setSubmittingIds((prev) => {
          const next = new Set(prev);
          next.delete(reservationId);
          return next;
        });
        onFailure?.();

        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          showFeedback({ kind: 'server', message: 'You do not have permission to reschedule.' });
          setAriaRefused('Move refused: insufficient permissions.');
        } else if (result.error === 'validation') {
          showFeedback({ kind: 'validation', message: result.message });
          setAriaRefused(`Move refused: ${result.message}`);
        } else {
          showFeedback({ kind: 'server' });
          setAriaRefused('Move refused: server error.');
        }
        return;
      }

      if (!result.ok) {
        // Snap back
        setPendingIds((prev) => {
          const next = new Set(prev);
          next.delete(reservationId);
          return next;
        });
        setSubmittingIds((prev) => {
          const next = new Set(prev);
          next.delete(reservationId);
          return next;
        });
        onFailure?.();

        if (result.reason === 'not_found') {
          showFeedback({ kind: 'not_found' });
          setAriaRefused('Reservation no longer exists; refreshing.');
          router.refresh();
          return;
        }
        if (result.reason === 'conflict') {
          showFeedback({ kind: 'conflict', conflicts: result.conflicts });
          setAriaRefused('Move refused: scheduling conflict.');
          return;
        }
        if (result.reason === 'policy') {
          showFeedback({ kind: 'policy', violations: result.violations });
          setAriaRefused('Move refused: booking policy violation.');
          return;
        }
        if (result.reason === 'conflict_and_policy') {
          showFeedback({
            kind: 'conflict_and_policy',
            conflicts: result.conflicts,
            violations: result.violations,
          });
          setAriaRefused('Move refused: conflict and booking policy violation.');
          return;
        }
        return;
      }

      // ok:true — replace the optimistic block with the returned new reservation
      const newRow: ReservationRow = {
        id: result.reservation.id,
        orgId: result.reservation.orgId,
        startAt: result.reservation.startAt,
        endAt: result.reservation.endAt,
        status: 'booked',
        notes: result.reservation.notes,
        createdBy: result.reservation.createdBy,
        cancelledAt: null,
        cancelledBy: null,
        seriesId: null, // detaches from series on reschedule
        resourceIds: result.reservation.resourceIds,
      };

      setReservations((prev) => [
        ...prev.filter((r) => r.id !== reservationId),
        newRow,
      ]);
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(reservationId);
        return next;
      });
      setSubmittingIds((prev) => {
        const next = new Set(prev);
        next.delete(reservationId);
        return next;
      });
      onSuccess?.();

      const timeLabel = formatTimeRange(result.reservation.startAt, result.reservation.endAt);
      setAriaSuccess(`Reservation moved to ${timeLabel}.`);
      setFeedback({ kind: 'none' });
    } catch {
      // Network/unexpected error — snap back
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(reservationId);
        return next;
      });
      setSubmittingIds((prev) => {
        const next = new Set(prev);
        next.delete(reservationId);
        return next;
      });
      onFailure?.();
      showFeedback({ kind: 'server', message: 'Something went wrong. Please try again.' });
      setAriaRefused('Move failed: unexpected error.');
    } finally {
      setIsBoardBusy(false);
    }
  }

  // ── DnD handlers ───────────────────────────────────────────────────────────
  function handleBlockDragStart(
    e: React.DragEvent<HTMLDivElement>,
    block: BoardBlock,
  ) {
    const payload: DragPayload = {
      reservationId: block.reservationId,
      resourceId: block.resourceId,
      durationMs: block.endAt.getTime() - block.startAt.getTime(),
    };
    e.dataTransfer.setData(DRAG_DATA_KEY, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'move';
    setDragPayload(payload);
    setDraggedReservationId(block.reservationId);
    // Optimistic pending
    setPendingIds((prev) => new Set([...prev, block.reservationId]));
    setFeedback({ kind: 'none' });
    setAriaSuccess('');
    setAriaRefused('');
  }

  function handleBlockDragEnd() {
    if (dragPayload) {
      // If no drop happened, clear pending
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(dragPayload.reservationId);
        return next;
      });
    }
    setDragPayload(null);
    setDraggedReservationId(null);
    setHoveredDropResourceId(null);
    setHoveredCellIndex(null);
    setSnapPreview(null);
  }

  function handleDropZoneDragOver(
    e: React.DragEvent<HTMLDivElement>,
    cellIndex: number,
    resourceId: string,
  ) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (!dragPayload) return;

    setHoveredDropResourceId(resourceId);
    setHoveredCellIndex(cellIndex);

    // Compute snap preview
    const cellMs = 15 * 60 * 1000;
    const newStartAt = new Date(dayStartMs + cellIndex * cellMs);
    const newEndAt = new Date(newStartAt.getTime() + dragPayload.durationMs);
    const hue = reservationHue(dragPayload.reservationId);
    setSnapPreview({ newStartAt, newEndAt, hue });
  }

  function handleDropZoneDrop(
    e: React.DragEvent<HTMLDivElement>,
    cellIndex: number,
    targetResourceId: string,
  ) {
    e.preventDefault();

    let payload = dragPayload;
    if (!payload) {
      const raw = e.dataTransfer.getData(DRAG_DATA_KEY);
      if (!raw) return;
      try {
        payload = JSON.parse(raw) as DragPayload;
      } catch {
        return;
      }
    }

    // Compute snapped new start
    const cellMs = 15 * 60 * 1000;
    const newStartAt = new Date(dayStartMs + cellIndex * cellMs);
    const newEndAt = new Date(newStartAt.getTime() + payload.durationMs);

    // Determine newResourceIds (cross-row swap or null)
    let newResourceIds: string[] | undefined;
    if (targetResourceId !== payload.resourceId) {
      // Find the original reservation to get all its resourceIds
      const original = reservations.find((r) => r.id === payload!.reservationId);
      if (original) {
        newResourceIds = original.resourceIds.map((id) =>
          id === payload!.resourceId ? targetResourceId : id,
        );
      }
    }

    // Clear DnD state
    setDragPayload(null);
    setDraggedReservationId(null);
    setHoveredDropResourceId(null);
    setHoveredCellIndex(null);
    setSnapPreview(null);

    // Capture the specific row BEFORE the optimistic mutation so we can
    // snap back only this reservation on failure (not the entire board).
    const reservationId = payload.reservationId;
    const prevRow = reservations.find((r) => r.id === reservationId);

    // Apply optimistic move to the reservation list
    setReservations((prev) =>
      prev.map((r) => {
        if (r.id !== reservationId) return r;
        return {
          ...r,
          startAt: newStartAt,
          endAt: newEndAt,
          resourceIds: newResourceIds ?? r.resourceIds,
        };
      }),
    );

    void executeReschedule(
      reservationId,
      newStartAt,
      newEndAt,
      newResourceIds,
      undefined,
      () => {
        // Snap back only the moved block — preserve all other confirmed moves.
        if (prevRow) {
          setReservations((rs) =>
            rs.map((r) => (r.id === reservationId ? prevRow : r)),
          );
        }
      },
    );
  }

  function handleDropZoneDragLeave() {
    // Only clear if leaving the row (not just moving between cells)
    // We debounce to avoid flicker
  }

  // ── Move dialog handlers ───────────────────────────────────────────────────
  function handleMoveClick(block: BoardBlock) {
    setMoveDialogBlock(block);
    setDialogError(null);
    setDialogConflicts(null);
    setDialogViolations(null);
    setMoveDialogOpen(true);
  }

  async function handleDialogSubmit(
    newStartAt: Date,
    newEndAt: Date,
    newResourceIds: string[] | undefined,
  ) {
    if (!moveDialogBlock) return;

    setDialogError(null);
    setDialogConflicts(null);
    setDialogViolations(null);
    setDialogSubmitting(true);

    const reservationId = moveDialogBlock.reservationId;

    try {
      const result = await rescheduleAction({
        reservationId,
        newStartAt,
        newEndAt,
        newResourceIds,
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          setDialogError(result.message);
        } else if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to reschedule this reservation.');
        } else {
          setDialogError('Something went wrong. Please try again.');
        }
        return;
      }

      if (!result.ok) {
        if (result.reason === 'not_found') {
          setDialogError('This reservation no longer exists.');
          router.refresh();
          setMoveDialogOpen(false);
          return;
        }
        if (result.reason === 'conflict') {
          setDialogConflicts(result.conflicts);
          return;
        }
        if (result.reason === 'policy') {
          setDialogViolations(result.violations);
          return;
        }
        if (result.reason === 'conflict_and_policy') {
          setDialogConflicts(result.conflicts);
          setDialogViolations(result.violations);
          return;
        }
        return;
      }

      // ok:true — update local state
      const newRow: ReservationRow = {
        id: result.reservation.id,
        orgId: result.reservation.orgId,
        startAt: result.reservation.startAt,
        endAt: result.reservation.endAt,
        status: 'booked',
        notes: result.reservation.notes,
        createdBy: result.reservation.createdBy,
        cancelledAt: null,
        cancelledBy: null,
        seriesId: null,
        resourceIds: result.reservation.resourceIds,
      };

      setReservations((prev) => [
        ...prev.filter((r) => r.id !== reservationId),
        newRow,
      ]);
      setMoveDialogOpen(false);
      const timeLabel = formatTimeRange(result.reservation.startAt, result.reservation.endAt);
      setAriaSuccess(`Reservation moved to ${timeLabel}.`);
    } catch {
      setDialogError('Something went wrong. Please try again.');
    } finally {
      setDialogSubmitting(false);
    }
  }

  // ── Dispatch dialog handlers (Slice 3a, additive) ─────────────────────────

  function handleCheckOut(block: BoardBlock) {
    setCheckOutBlock(block);
    setCheckOutOpen(true);
  }

  function handleCheckIn(block: BoardBlock, ticket: DispatchTicketView) {
    setCheckInBlock(block);
    setCheckInTicket(ticket);
    setCheckInOpen(true);
  }

  function handleVoidClick(block: BoardBlock, ticket: DispatchTicketView) {
    setVoidBlock(block);
    setVoidTicket(ticket);
    setVoidOpen(true);
  }

  function handleCheckOutSuccess(ticket: DispatchTicketView) {
    // Update local map optimistically; router.refresh() syncs from server.
    setDispatchTickets((prev) => {
      const next = new Map(prev);
      next.set(ticket.reservationId, ticket);
      return next;
    });
    setAriaSuccess('Aircraft checked out.');
    router.refresh();
  }

  function handleCheckInSuccess(ticket: DispatchTicketView) {
    setDispatchTickets((prev) => {
      const next = new Map(prev);
      next.set(ticket.reservationId, ticket);
      return next;
    });
    setAriaSuccess('Aircraft checked in.');
    router.refresh();
  }

  function handleVoidSuccess() {
    // The voided reservation's ticket is now voided (getDispatchForReservation
    // returns null for voided tickets per spec §3.4 "latest non-voided").
    if (voidBlock) {
      setDispatchTickets((prev) => {
        const next = new Map(prev);
        next.set(voidBlock.reservationId, null);
        return next;
      });
    }
    setAriaSuccess('Check-out voided. Aircraft is now free.');
    router.refresh();
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  const isDragActive = dragPayload !== null;

  return (
    <div
      role="region"
      aria-label={`Dispatch board for ${formatDate(date)}`}
      aria-busy={isBoardBusy}
      className="flex flex-col"
    >
      {/* ── A11y live regions ──────────────────────────────────────────── */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        id="board-success-region"
      >
        {ariaSuccess}
      </div>
      <div
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
        id="board-refused-region"
      >
        {ariaRefused}
      </div>
      {/* Screen reader hint for draggable blocks */}
      <p id="board-move-hint" className="sr-only">
        Press Enter or Space to open the move dialog.
      </p>

      {/* ── Read-only badge ────────────────────────────────────────────── */}
      {!canDrag && (
        <div className="mb-2 flex items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-slate-200 px-2.5 py-0.5 text-xs font-semibold text-slate-600">
            View only
          </span>
          <span className="text-xs text-slate-500">
            You do not have permission to reschedule reservations.
          </span>
        </div>
      )}

      {/* ── Feedback zone (refused-drop banner) ───────────────────────── */}
      {feedback.kind !== 'none' && (
        <div className="mb-3">
          {feedback.kind === 'conflict' && (
            <ConflictBanner
              state="conflict"
              conflicts={feedback.conflicts}
              submitConflicts={feedback.conflicts}
            />
          )}
          {feedback.kind === 'policy' && (
            <ConflictBanner
              state="policy"
              conflicts={[]}
              policyViolations={feedback.violations}
              submitViolations={feedback.violations}
            />
          )}
          {feedback.kind === 'conflict_and_policy' && (
            <ConflictBanner
              state="conflict_and_policy"
              conflicts={feedback.conflicts}
              policyViolations={feedback.violations}
              submitConflicts={feedback.conflicts}
              submitViolations={feedback.violations}
            />
          )}
          {feedback.kind === 'not_found' && (
            <Alert variant="destructive" role="alert">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>
                That reservation no longer exists — refreshing the board.
              </AlertDescription>
            </Alert>
          )}
          {(feedback.kind === 'validation' || feedback.kind === 'server') && (
            <Alert variant="destructive" role="alert">
              <XCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>
                {feedback.kind === 'validation'
                  ? feedback.message
                  : (feedback.message ?? 'Something went wrong. Please try again.')}
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}

      {/* ── Board grid ────────────────────────────────────────────────── */}
      <div className="flex border border-slate-200 rounded-lg overflow-hidden bg-white">
        {/* Left gutter (sticky) */}
        <div className="flex-shrink-0 sticky left-0 z-30">
          {/* Axis header spacer */}
          <div className="h-8 bg-white border-b border-slate-200 w-36" />
          <BoardGutter grouped={grouped} />
        </div>

        {/* Scrollable time track */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-x-auto"
          style={{ position: 'relative' }}
        >
          {/* Sticky time axis */}
          <div className="sticky top-0 z-20">
            <BoardTimeAxis />
          </div>

          {/* Resource rows — group headers mirror the gutter so rows stay aligned. */}
          <div style={{ width: TRACK_WIDTH_PX }}>
            {/* Aircraft group */}
            {grouped.aircraft.length > 0 && (
              <>
                {/* Group header spacer — matches gutter h-8 Aircraft header */}
                <div
                  aria-hidden="true"
                  className="h-8 border-b border-slate-200 bg-white"
                />
                {grouped.aircraft.map((resource) => (
                  <BoardResourceRow
                    key={resource.id}
                    resource={resource}
                    blocks={blocksByResource.get(resource.id) ?? []}
                    canDrag={canDrag}
                    canDispatch={canDispatch}
                    isDragActive={isDragActive}
                    draggedReservationId={draggedReservationId}
                    hoveredReservationId={hoveredReservationId}
                    pendingReservationIds={pendingIds}
                    submittingReservationIds={submittingIds}
                    isDropTarget={hoveredDropResourceId === resource.id}
                    snapPreview={
                      hoveredDropResourceId === resource.id ? snapPreview : null
                    }
                    dayStartMs={dayStartMs}
                    dispatchTickets={dispatchTickets}
                    onBlockDragStart={handleBlockDragStart}
                    onBlockDragEnd={handleBlockDragEnd}
                    onHoverEnter={(id) => setHoveredReservationId(id)}
                    onHoverLeave={() => setHoveredReservationId(null)}
                    onMoveClick={handleMoveClick}
                    onCheckOut={handleCheckOut}
                    onCheckIn={handleCheckIn}
                    onVoid={handleVoidClick}
                    onDropZoneDragOver={handleDropZoneDragOver}
                    onDropZoneDrop={handleDropZoneDrop}
                    onDropZoneDragLeave={handleDropZoneDragLeave}
                    hoveredCellIndex={hoveredCellIndex}
                    resources={resources}
                  />
                ))}
              </>
            )}

            {/* Group separator — matches gutter h-px separator */}
            {grouped.aircraft.length > 0 && grouped.instructors.length > 0 && (
              <div aria-hidden="true" className="h-px bg-slate-300" />
            )}

            {/* Instructors group */}
            {grouped.instructors.length > 0 && (
              <>
                {/* Group header spacer — matches gutter h-8 Instructors header */}
                <div
                  aria-hidden="true"
                  className="h-8 border-b border-slate-200 bg-white"
                />
                {grouped.instructors.map((resource) => (
                  <BoardResourceRow
                    key={resource.id}
                    resource={resource}
                    blocks={blocksByResource.get(resource.id) ?? []}
                    canDrag={canDrag}
                    canDispatch={canDispatch}
                    isDragActive={isDragActive}
                    draggedReservationId={draggedReservationId}
                    hoveredReservationId={hoveredReservationId}
                    pendingReservationIds={pendingIds}
                    submittingReservationIds={submittingIds}
                    isDropTarget={hoveredDropResourceId === resource.id}
                    snapPreview={
                      hoveredDropResourceId === resource.id ? snapPreview : null
                    }
                    dayStartMs={dayStartMs}
                    dispatchTickets={dispatchTickets}
                    onBlockDragStart={handleBlockDragStart}
                    onBlockDragEnd={handleBlockDragEnd}
                    onHoverEnter={(id) => setHoveredReservationId(id)}
                    onHoverLeave={() => setHoveredReservationId(null)}
                    onMoveClick={handleMoveClick}
                    onCheckOut={handleCheckOut}
                    onCheckIn={handleCheckIn}
                    onVoid={handleVoidClick}
                    onDropZoneDragOver={handleDropZoneDragOver}
                    onDropZoneDrop={handleDropZoneDrop}
                    onDropZoneDragLeave={handleDropZoneDragLeave}
                    hoveredCellIndex={hoveredCellIndex}
                    resources={resources}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Move dialog ───────────────────────────────────────────────── */}
      <MoveReservationDialog
        block={moveDialogBlock}
        resources={resources}
        open={moveDialogOpen}
        onOpenChange={setMoveDialogOpen}
        onSubmit={handleDialogSubmit}
        isSubmitting={dialogSubmitting}
        dialogError={dialogError}
        dialogConflicts={dialogConflicts}
        dialogViolations={dialogViolations}
        onClearError={() => {
          setDialogError(null);
          setDialogConflicts(null);
          setDialogViolations(null);
        }}
      />

      {/* ── Dispatch dialogs (Slice 3a, additive) ─────────────────────── */}

      {/* Check-out dialog — open when canDispatch + no current ticket */}
      {checkOutBlock && (
        <CheckOutDialog
          open={checkOutOpen}
          onOpenChange={setCheckOutOpen}
          reservationId={checkOutBlock.reservationId}
          resourceId={checkOutBlock.resourceId}
          onSuccess={handleCheckOutSuccess}
        />
      )}

      {/* Check-in dialog — open when canDispatch + ticket is 'open' */}
      {checkInBlock && checkInTicket && (
        <CheckInDialog
          open={checkInOpen}
          onOpenChange={setCheckInOpen}
          ticket={checkInTicket}
          onSuccess={handleCheckInSuccess}
        />
      )}

      {/* Void dialog — open when canDispatch + ticket is 'open' */}
      {voidBlock && voidTicket && (
        <VoidDispatchDialog
          open={voidOpen}
          onOpenChange={setVoidOpen}
          ticketId={voidTicket.id}
          onSuccess={handleVoidSuccess}
        />
      )}
    </div>
  );
}
