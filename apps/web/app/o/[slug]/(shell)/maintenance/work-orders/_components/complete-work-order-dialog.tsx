/**
 * complete-work-order-dialog.tsx — "Complete work order" dialog (Slice M1.3).
 *
 * The orchestration loop:
 *   - Work performed notes (optional)
 *   - Sign-off notes (optional)
 *   - "Resolve linked squawk" checkbox — ONLY if WO has a linked squawk
 *     still open/deferred AND hasCapability(maintenance:squawk)
 *   - "Return aircraft to service (unground)" checkbox — ONLY if aircraft is
 *     grounded AND basis matches this WO's squawk AND hasCapability(maintenance:ground)
 *   - MANDATORY compliance disclaimer (verbatim, load-bearing [VERIFY-M1-A/C])
 *
 * Shows result panel with applied/skipped summary [VERIFY-M1-D].
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 */
'use client';

import * as React from 'react';
import { XCircle, CheckCircle2, Info } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { completeWorkOrderAction } from '../actions';
import { formatCompleteResultSummary } from './work-order-utils';
import type { SerializedWorkOrderView, SerializedSquawkView, SerializedCompleteWorkOrderResult } from '../actions';

// ─── Props ────────────────────────────────────────────────────────────────────

interface CompleteWorkOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workOrder: SerializedWorkOrderView;
  /** The linked squawk (if any). Used to decide whether to show resolve option. */
  linkedSquawk: SerializedSquawkView | null;
  /** Whether the aircraft is currently grounded. */
  isGrounded: boolean;
  /**
   * Whether the grounding basis matches this WO's squawk.
   * Only relevant if isGrounded=true. When false, shows disabled info message.
   */
  groundingMatchesSquawk: boolean;
  /** Whether the session has maintenance:squawk cap (show resolve checkbox). */
  canResolveSquawk: boolean;
  /** Whether the session has maintenance:ground cap (show unground checkbox). */
  canUnground: boolean;
  onSuccess: (result: Extract<SerializedCompleteWorkOrderResult, { ok: true }>) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CompleteWorkOrderDialog({
  open,
  onOpenChange,
  workOrder,
  linkedSquawk,
  isGrounded,
  groundingMatchesSquawk,
  canResolveSquawk,
  canUnground,
  onSuccess,
}: CompleteWorkOrderDialogProps) {
  const [workPerformed, setWorkPerformed] = React.useState('');
  const [signOffNotes, setSignOffNotes] = React.useState('');
  const [resolveSquawk, setResolveSquawk] = React.useState(false);
  const [squawkResolutionNotes, setSquawkResolutionNotes] = React.useState('');
  const [unground, setUnground] = React.useState(false);

  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setWorkPerformed('');
      setSignOffNotes('');
      setResolveSquawk(false);
      setSquawkResolutionNotes('');
      setUnground(false);
      setDialogError(null);
    }
  }, [open]);

  // Determine if resolve squawk option should be shown
  const canShowResolveSquawk =
    canResolveSquawk &&
    linkedSquawk !== null &&
    (linkedSquawk.status === 'open' || linkedSquawk.status === 'deferred');

  // Determine if unground option should be shown
  const canShowUnground = canUnground && isGrounded;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDialogError(null);
    setIsSubmitting(true);

    try {
      const result = await completeWorkOrderAction({
        workOrderId: workOrder.id,
        workPerformed: workPerformed.trim() || undefined,
        signOffNotes: signOffNotes.trim() || undefined,
        resolveSquawk: canShowResolveSquawk ? resolveSquawk : undefined,
        squawkResolutionNotes:
          canShowResolveSquawk && resolveSquawk && squawkResolutionNotes.trim()
            ? squawkResolutionNotes.trim()
            : undefined,
        unground: canShowUnground && groundingMatchesSquawk ? unground : undefined,
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          setDialogError(result.message);
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to complete this work order.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      if (!result.ok) {
        if (result.reason === 'not_found') {
          setDialogError('Work order not found.');
          return;
        }
        if (result.reason === 'not_completable') {
          setDialogError('This work order has already been completed or cancelled.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      onSuccess(result);
      onOpenChange(false);
    } catch {
      setDialogError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Complete work order</DialogTitle>
        </DialogHeader>

        <div className="rounded-md bg-slate-50 border border-slate-200 px-3 py-2 text-sm text-slate-700">
          <p className="font-medium truncate">{workOrder.title}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {/* Work performed */}
          <div className="space-y-1.5">
            <Label htmlFor="co-work-performed">Work performed (optional)</Label>
            <textarea
              id="co-work-performed"
              rows={3}
              maxLength={4000}
              placeholder="Describe the work performed…"
              value={workPerformed}
              onChange={(e) => setWorkPerformed(e.target.value)}
              disabled={isSubmitting}
              className="flex w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 disabled:opacity-50 resize-none"
            />
          </div>

          {/* Sign-off notes */}
          <div className="space-y-1.5">
            <Label htmlFor="co-sign-off-notes">Sign-off notes (optional)</Label>
            <textarea
              id="co-sign-off-notes"
              rows={2}
              maxLength={2000}
              placeholder="Inspector/mechanic notes for the sign-off record…"
              value={signOffNotes}
              onChange={(e) => setSignOffNotes(e.target.value)}
              disabled={isSubmitting}
              className="flex w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 disabled:opacity-50 resize-none"
            />
          </div>

          {/* Resolve linked squawk option */}
          {canShowResolveSquawk && (
            <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
              <label className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  id="co-resolve-squawk"
                  checked={resolveSquawk}
                  onChange={(e) => setResolveSquawk(e.target.checked)}
                  disabled={isSubmitting}
                  className="mt-0.5 h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-600"
                />
                <span className="text-sm text-slate-700">
                  <span className="font-medium">Resolve linked squawk</span>
                  {' — '}
                  <span className="text-slate-500 truncate">{linkedSquawk?.title}</span>
                </span>
              </label>

              {resolveSquawk && (
                <div className="space-y-1.5 ml-6.5">
                  <Label htmlFor="co-squawk-notes" className="text-xs">
                    Resolution notes (optional)
                  </Label>
                  <textarea
                    id="co-squawk-notes"
                    rows={2}
                    maxLength={1000}
                    placeholder="How was this squawk resolved?"
                    value={squawkResolutionNotes}
                    onChange={(e) => setSquawkResolutionNotes(e.target.value)}
                    disabled={isSubmitting}
                    className="flex w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 disabled:opacity-50 resize-none"
                  />
                </div>
              )}
            </div>
          )}

          {/* Unground option */}
          {canShowUnground && (
            <div className="rounded-md border border-slate-200 bg-slate-50 p-3">
              {groundingMatchesSquawk ? (
                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    id="co-unground"
                    checked={unground}
                    onChange={(e) => setUnground(e.target.checked)}
                    disabled={isSubmitting}
                    className="mt-0.5 h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-sky-600"
                  />
                  <span className="text-sm text-slate-700">
                    <span className="font-medium">Return aircraft to service (unground)</span>
                    {' — '}
                    <span className="text-slate-500">
                      releases the current operator grounding
                    </span>
                  </span>
                </label>
              ) : (
                <div className="flex items-start gap-2 text-sm text-slate-500">
                  <Info className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
                  <span>
                    Grounded for a different reason — remains grounded. Only the
                    operator can release it from the dispatch board.
                  </span>
                </div>
              )}
            </div>
          )}

          {/* MANDATORY compliance disclaimer [VERIFY-M1-A/C] — verbatim, load-bearing */}
          <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <p>
              A sign-off is an operator/mechanic maintenance record — it is NOT an FAA
              return-to-service or §43.9/§43.11 determination, and the system makes no
              airworthiness determination.
            </p>
          </div>

          {dialogError && (
            <Alert variant="destructive" role="alert" aria-live="assertive">
              <XCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{dialogError}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" autoFocus disabled={isSubmitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Completing…' : 'Complete work order'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── CompleteResultPanel ──────────────────────────────────────────────────────

/**
 * CompleteResultPanel — inline summary shown after a successful completion.
 * Describes which sub-actions applied or were skipped. [VERIFY-M1-D]
 */
interface CompleteResultPanelProps {
  result: Extract<SerializedCompleteWorkOrderResult, { ok: true }>;
  requestedResolveSquawk: boolean;
  requestedUnground: boolean;
}

export function CompleteResultPanel({
  result,
  requestedResolveSquawk,
  requestedUnground,
}: CompleteResultPanelProps) {
  const lines = formatCompleteResultSummary({
    squawkResolveSkipped: result.squawkResolveSkipped,
    ungrounded: result.ungrounded,
    ungroundSkipped: result.ungroundSkipped,
    requestedResolveSquawk,
    requestedUnground,
  });

  return (
    <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2.5 space-y-1">
      <p className="text-sm font-semibold text-green-900">Work order completed.</p>
      <ul className="space-y-0.5" aria-label="Completion summary">
        {lines.slice(1).map((line, i) => (
          <li key={i} className="flex items-start gap-1.5 text-xs text-green-800">
            {line.applied ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5 text-green-600" aria-hidden="true" />
            ) : (
              <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-green-700 opacity-60" aria-hidden="true" />
            )}
            <span>{line.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
