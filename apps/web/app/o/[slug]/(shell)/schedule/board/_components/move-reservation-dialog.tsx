/**
 * move-reservation-dialog.tsx — "Move to…" dialog for keyboard/mobile reschedule.
 *
 * Duration is preserved (only date, time, and optionally resource change).
 * Cancel button ("Keep as-is") is autofocused per spec §3.
 * Same result handling as DnD: ok:true confirm, ok:false snap-back + feedback.
 *
 * For multi-resource reservations, shows a resource <select> so the user can
 * swap which row the dragged resource maps to.
 */
'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { XCircle } from 'lucide-react';
import { toDateInputValue, formatTimeRange } from '../../_utils/format-time';
import type { BoardBlock } from '../_utils/board-layout';
import type { ResourceRow, ConflictHit, PolicyViolationView } from '@aeroops/api';

/** Convert a Date to "HH:MM" for <input type="time"> */
function toTimeInputValue(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/** Parse "YYYY-MM-DD" + "HH:MM" → Date (local time). */
function parseDateTime(dateStr: string, timeStr: string): Date | null {
  const dt = new Date(`${dateStr}T${timeStr}:00`);
  if (isNaN(dt.getTime())) return null;
  return dt;
}

export type MoveDialogResult =
  | { kind: 'moved'; newStartAt: Date; newEndAt: Date; newResourceIds?: string[] }
  | { kind: 'cancelled' };

interface MoveReservationDialogProps {
  /** The block being moved (provides id, duration, current resource). */
  block: BoardBlock | null;
  /** All active resources (for the optional resource swap select). */
  resources: ResourceRow[];
  /** Whether the dialog is open. */
  open: boolean;
  /** Called when dialog should close. */
  onOpenChange: (open: boolean) => void;
  /**
   * Called when the user submits the move form.
   * The parent (dispatch-board.tsx) executes the reschedule and handles results.
   */
  onSubmit: (
    newStartAt: Date,
    newEndAt: Date,
    newResourceIds: string[] | undefined,
  ) => Promise<void>;
  /** Submission state — disables form while pending. */
  isSubmitting: boolean;
  /** Inline error to show inside the dialog after a failed move. */
  dialogError: string | null;
  /** Conflict hits to show in dialog (refused-conflict from server). */
  dialogConflicts: ConflictHit[] | null;
  /** Policy violations to show in dialog (refused-policy from server). */
  dialogViolations: PolicyViolationView[] | null;
  onClearError: () => void;
}

export function MoveReservationDialog({
  block,
  resources,
  open,
  onOpenChange,
  onSubmit,
  isSubmitting,
  dialogError,
  dialogConflicts,
  dialogViolations,
  onClearError,
}: MoveReservationDialogProps) {
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  // Local form state
  const [dateStr, setDateStr] = React.useState('');
  const [timeStr, setTimeStr] = React.useState('');
  const [resourceId, setResourceId] = React.useState('');
  const [fieldError, setFieldError] = React.useState<string | null>(null);

  // Populate form when dialog opens with a new block
  React.useEffect(() => {
    if (block && open) {
      setDateStr(toDateInputValue(block.startAt));
      setTimeStr(toTimeInputValue(block.startAt));
      setResourceId(block.resourceId);
      setFieldError(null);
    }
  }, [block, open]);

  if (!block) return null;

  // Capture a non-null local so TypeScript narrows correctly inside handleSubmit.
  const currentBlock = block;

  const durationMs =
    currentBlock.endAt.getTime() - currentBlock.startAt.getTime();

  // Is this a multi-resource reservation?
  const isMultiResource = currentBlock.reservation.resourceIds.length > 1;

  // Resources of the same kind as the block's resource (for swapping)
  const thisResource = resources.find((r) => r.id === currentBlock.resourceId);
  const swappableResources = thisResource
    ? resources.filter(
        (r) => r.kind === thisResource.kind && r.id !== currentBlock.resourceId,
      )
    : [];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onClearError();
    setFieldError(null);

    const newStartAt = parseDateTime(dateStr, timeStr);
    if (!newStartAt) {
      setFieldError('Please enter a valid date and time.');
      return;
    }
    const newEndAt = new Date(newStartAt.getTime() + durationMs);
    if (newEndAt <= newStartAt) {
      setFieldError('End time must be after start time.');
      return;
    }

    // Compute newResourceIds if a resource swap is involved
    let newResourceIds: string[] | undefined;
    if (resourceId !== currentBlock.resourceId) {
      // Swap the current resource for the selected one in the full resource set
      newResourceIds = currentBlock.reservation.resourceIds.map((id) =>
        id === currentBlock.resourceId ? resourceId : id,
      );
    }

    await onSubmit(newStartAt, newEndAt, newResourceIds);
  }

  const hasConflict = (dialogConflicts?.length ?? 0) > 0;
  const hasViolation = (dialogViolations?.length ?? 0) > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move reservation</DialogTitle>
        </DialogHeader>

        {/* Current time display */}
        <p className="text-sm text-slate-500">
          Currently: {formatTimeRange(currentBlock.startAt, currentBlock.endAt)}
          {currentBlock.reservation.seriesId && (
            <span className="ml-2 text-xs text-slate-400">(series)</span>
          )}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Date */}
          <div className="space-y-1.5">
            <Label htmlFor="move-date">New date</Label>
            <Input
              id="move-date"
              type="date"
              value={dateStr}
              onChange={(e) => setDateStr(e.target.value)}
              required
              aria-required="true"
              disabled={isSubmitting}
            />
          </div>

          {/* Start time (step=900 = 15 min) */}
          <div className="space-y-1.5">
            <Label htmlFor="move-time">New start time</Label>
            <Input
              id="move-time"
              type="time"
              step={900}
              value={timeStr}
              onChange={(e) => setTimeStr(e.target.value)}
              required
              aria-required="true"
              disabled={isSubmitting}
            />
            <p className="text-xs text-slate-400">
              Duration is preserved ({Math.round(durationMs / 60000)} min)
            </p>
          </div>

          {/* Resource swap (only for multi-resource reservations) */}
          {isMultiResource && swappableResources.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="move-resource">
                {thisResource?.kind === 'aircraft' ? 'Aircraft' : 'Instructor'}
              </Label>
              <select
                id="move-resource"
                value={resourceId}
                onChange={(e) => setResourceId(e.target.value)}
                disabled={isSubmitting}
                className="flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 disabled:opacity-50"
              >
                <option value={currentBlock.resourceId}>
                  {thisResource?.displayName ?? currentBlock.resourceId} (current)
                </option>
                {swappableResources.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.displayName}
                    {r.tailNumber ? ` (${r.tailNumber})` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Inline field validation error */}
          {fieldError && (
            <Alert variant="destructive" role="alert" aria-live="assertive">
              <XCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{fieldError}</AlertDescription>
            </Alert>
          )}

          {/* Server conflict error */}
          {(hasConflict || hasViolation) && (
            <Alert variant="destructive" role="alert" aria-live="assertive">
              <XCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>
                <p className="font-medium mb-1">
                  This slot is not available:
                </p>
                {hasConflict && (
                  <ul className="list-disc list-inside text-sm space-y-0.5 mb-1">
                    {dialogConflicts!.map((hit) => (
                      <li key={`${hit.resourceId}-${hit.start.toString()}`}>
                        {hit.resourceDisplayName} is booked during this time
                      </li>
                    ))}
                  </ul>
                )}
                {hasViolation && (
                  <ul className="list-disc list-inside text-sm space-y-0.5">
                    {dialogViolations!.map((v, i) => (
                      <li key={i}>{v.kind.replace(/_/g, ' ')}</li>
                    ))}
                  </ul>
                )}
              </AlertDescription>
            </Alert>
          )}

          {/* Generic server error */}
          {dialogError && !hasConflict && !hasViolation && (
            <Alert variant="destructive" role="alert" aria-live="assertive">
              <XCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{dialogError}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            {/* Cancel is autofocused per spec §3 */}
            <DialogClose asChild>
              <Button
                ref={cancelRef}
                type="button"
                variant="outline"
                autoFocus
                disabled={isSubmitting}
              >
                Keep as-is
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Moving…' : 'Move reservation'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
