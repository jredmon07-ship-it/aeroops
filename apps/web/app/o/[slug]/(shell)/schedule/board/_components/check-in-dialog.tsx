/**
 * check-in-dialog.tsx — "Check in" dialog for closing a dispatch ticket.
 *
 * Renders on a board block whose dispatch ticket is status='open'.
 *
 * Fields: Hobbs IN (step 0.1), Tach IN (step 0.1).
 * Client-side derived-time preview via deriveFlightTime(ticket.hobbsOut, hobbsIn):
 *   - Updates live as the user types Hobbs IN.
 *   - Guards RangeError (hobbsIn < hobbsOut) → shows "Hobbs in must be ≥ Hobbs out"
 *     and disables submit.
 *   - aria-live="polite" on the preview so assistive tech announces the update.
 *
 * Result mapping:
 *   ok:true                       → close + onSuccess(ticket)
 *   ok:false reason:'not_open'   → inline "This check-out is already closed"
 *   ok:false reason:'not_found'  → inline "Ticket no longer available"
 *   { error: 'validation' }      → inline field error
 *   { error: 'forbidden' }       → inline auth error
 *   { error: 'server' }          → generic inline error
 *
 * Cancel: "Keep as-is" (safer default; autofocused).
 *
 * BOUNDARY: imports @aeroops/core for deriveFlightTime (pure); @aeroops/api
 * only through the server action. Never '@aeroops/db'.
 */
'use client';

import * as React from 'react';
import { XCircle } from 'lucide-react';
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
import { deriveFlightTime } from '@aeroops/core';
import { closeDispatchAction } from '../../actions';
import { reportSquawkAction } from '../../../maintenance/actions';
import type { DispatchTicketView } from '@aeroops/api';

// ─── Props ────────────────────────────────────────────────────────────────────

interface CheckInDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The open dispatch ticket being closed. */
  ticket: DispatchTicketView;
  /** Called on successful check-in — board should reflect the closed state. */
  onSuccess: (ticket: DispatchTicketView) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CheckInDialog({
  open,
  onOpenChange,
  ticket,
  onSuccess,
}: CheckInDialogProps) {
  // ── Form state ─────────────────────────────────────────────────────────────
  const [hobbsIn, setHobbsIn] = React.useState('');
  const [tachIn, setTachIn] = React.useState('');

  // ── Field-level errors ─────────────────────────────────────────────────────
  const [hobbsError, setHobbsError] = React.useState<string | null>(null);
  const [tachError, setTachError] = React.useState<string | null>(null);

  // ── Dialog-level error ─────────────────────────────────────────────────────
  const [dialogError, setDialogError] = React.useState<string | null>(null);

  // ── Submission state ───────────────────────────────────────────────────────
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  // ── Squawk-on-return state (Slice 3b.3) ───────────────────────────────────
  const [squawkOpen, setSquawkOpen] = React.useState(false);
  const [squawkTitle, setSquawkTitle] = React.useState('');
  const [squawkDescription, setSquawkDescription] = React.useState('');
  const [squawkSeverity, setSquawkSeverity] = React.useState<'low' | 'medium' | 'high' | 'grounding'>('low');
  const [squawkTitleError, setSquawkTitleError] = React.useState<string | null>(null);
  // Non-blocking squawk result message (shown after check-in succeeds)
  const [squawkMessage, setSquawkMessage] = React.useState<string | null>(null);

  // ── Reset form when dialog opens ───────────────────────────────────────────
  React.useEffect(() => {
    if (open) {
      setHobbsIn('');
      setTachIn('');
      setHobbsError(null);
      setTachError(null);
      setDialogError(null);
      setSquawkOpen(false);
      setSquawkTitle('');
      setSquawkDescription('');
      setSquawkSeverity('low');
      setSquawkTitleError(null);
      setSquawkMessage(null);
    }
  }, [open]);

  // ── Client-side derived flight time preview ────────────────────────────────
  // Updated live as hobbsIn changes; guarded against RangeError.
  const derivedPreview = React.useMemo<{
    hours: number;
    error: string | null;
  }>(() => {
    const val = parseFloat(hobbsIn);
    if (hobbsIn.trim() === '' || isNaN(val)) return { hours: 0, error: null };
    try {
      const hours = deriveFlightTime(ticket.hobbsOut, val);
      return { hours, error: null };
    } catch {
      return { hours: 0, error: 'Hobbs in must be ≥ Hobbs out.' };
    }
  }, [hobbsIn, ticket.hobbsOut]);

  // Submit is disabled when hobbsIn is below hobbsOut
  const previewBlocked = derivedPreview.error !== null && hobbsIn.trim() !== '';

  // ── Validation ─────────────────────────────────────────────────────────────
  function validate(): boolean {
    let valid = true;

    const hobbsVal = parseFloat(hobbsIn);
    if (hobbsIn.trim() === '' || isNaN(hobbsVal) || hobbsVal < 0) {
      setHobbsError('Hobbs in must be a non-negative number.');
      valid = false;
    } else if (hobbsVal < ticket.hobbsOut) {
      setHobbsError('Hobbs in must be ≥ Hobbs out.');
      valid = false;
    } else {
      setHobbsError(null);
    }

    const tachVal = parseFloat(tachIn);
    if (tachIn.trim() === '' || isNaN(tachVal) || tachVal < 0) {
      setTachError('Tach in must be a non-negative number.');
      valid = false;
    } else if (tachVal < ticket.tachOut) {
      setTachError('Tach in must be ≥ Tach out.');
      valid = false;
    } else {
      setTachError(null);
    }

    return valid;
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDialogError(null);

    if (!validate()) return;

    setIsSubmitting(true);
    try {
      const result = await closeDispatchAction({
        ticketId: ticket.id,
        hobbsIn: parseFloat(hobbsIn),
        tachIn: parseFloat(tachIn),
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          const msg = result.message.toLowerCase();
          if (msg.includes('hobbs')) {
            setHobbsError(result.message);
          } else if (msg.includes('tach')) {
            setTachError(result.message);
          } else {
            setDialogError(result.message);
          }
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to check in aircraft.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      if (!result.ok) {
        if (result.reason === 'not_open') {
          setDialogError('This check-out is already closed.');
          return;
        }
        if (result.reason === 'not_found') {
          setDialogError('Ticket no longer available.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      // ok:true — check-in succeeded
      const closedTicket = result.ticket;

      // Squawk-on-return (3b.3): fire reportSquawkAction after close succeeds.
      // Independent — a squawk failure does NOT un-close the ticket.
      if (squawkOpen && squawkTitle.trim()) {
        try {
          const squawkResult = await reportSquawkAction({
            resourceId: closedTicket.resourceId,
            title: squawkTitle.trim(),
            description: squawkDescription.trim() || undefined,
            severity: squawkSeverity,
            dispatchTicketId: closedTicket.id,
          });
          if ('ok' in squawkResult && squawkResult.ok) {
            setSquawkMessage('Squawk reported.');
          } else {
            setSquawkMessage('Check-in saved; squawk could not be saved (try again from Maintenance).');
          }
        } catch {
          setSquawkMessage('Check-in saved; squawk could not be saved (try again from Maintenance).');
        }
      }

      onSuccess(closedTicket);
      onOpenChange(false);
    } catch {
      setDialogError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Check in aircraft</DialogTitle>
        </DialogHeader>

        {/* Reference OUT readings */}
        <div className="rounded-md bg-slate-50 border border-slate-200 px-3 py-2 text-sm text-slate-600 space-y-0.5">
          <p>
            <span className="font-medium">Hobbs out:</span>{' '}
            {ticket.hobbsOut.toFixed(1)}
          </p>
          <p>
            <span className="font-medium">Tach out:</span>{' '}
            {ticket.tachOut.toFixed(1)}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {/* ── Hobbs IN ──────────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <Label htmlFor="ci-hobbs-in">
              Hobbs IN <span aria-hidden="true" className="text-red-500">*</span>
            </Label>
            <Input
              id="ci-hobbs-in"
              type="number"
              inputMode="decimal"
              step="0.1"
              min={ticket.hobbsOut}
              placeholder={`>= ${ticket.hobbsOut.toFixed(1)}`}
              value={hobbsIn}
              onChange={(e) => setHobbsIn(e.target.value)}
              aria-required="true"
              aria-invalid={hobbsError ? 'true' : undefined}
              aria-describedby={
                [
                  hobbsError ? 'ci-hobbs-in-err' : null,
                  'ci-flight-preview',
                ]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
              disabled={isSubmitting}
            />
            {hobbsError && (
              <p
                id="ci-hobbs-in-err"
                role="alert"
                className="text-xs text-red-600"
              >
                {hobbsError}
              </p>
            )}

            {/* Derived flight time preview — aria-live so screen readers announce */}
            <p
              id="ci-flight-preview"
              aria-live="polite"
              aria-atomic="true"
              className="text-xs"
            >
              {hobbsIn.trim() !== '' && !derivedPreview.error && (
                <span className="text-slate-600">
                  Derived flight time:{' '}
                  <strong>{derivedPreview.hours.toFixed(1)} hr</strong>
                </span>
              )}
              {derivedPreview.error && (
                <span className="text-red-600">{derivedPreview.error}</span>
              )}
            </p>
          </div>

          {/* ── Tach IN ───────────────────────────────────────────────────── */}
          <div className="space-y-1.5">
            <Label htmlFor="ci-tach-in">
              Tach IN <span aria-hidden="true" className="text-red-500">*</span>
            </Label>
            <Input
              id="ci-tach-in"
              type="number"
              inputMode="decimal"
              step="0.1"
              min={ticket.tachOut}
              placeholder={`>= ${ticket.tachOut.toFixed(1)}`}
              value={tachIn}
              onChange={(e) => setTachIn(e.target.value)}
              aria-required="true"
              aria-invalid={tachError ? 'true' : undefined}
              aria-describedby={tachError ? 'ci-tach-in-err' : undefined}
              disabled={isSubmitting}
            />
            {tachError && (
              <p
                id="ci-tach-in-err"
                role="alert"
                className="text-xs text-red-600"
              >
                {tachError}
              </p>
            )}
          </div>

          {/* ── Dialog-level error ────────────────────────────────────────── */}
          {dialogError && (
            <Alert variant="destructive" role="alert" aria-live="assertive">
              <XCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{dialogError}</AlertDescription>
            </Alert>
          )}

          {/* ── Squawk-on-return (Slice 3b.3) ─────────────────────────────── */}
          <div className="border border-slate-200 rounded-md overflow-hidden">
            <button
              type="button"
              onClick={() => setSquawkOpen((v) => !v)}
              aria-expanded={squawkOpen}
              aria-controls="ci-squawk-section"
              className="w-full flex items-center justify-between px-3 py-2 text-sm text-slate-700 bg-slate-50 hover:bg-slate-100 transition-colors"
            >
              <span className="font-medium">Report a squawk? (optional)</span>
              <span aria-hidden="true" className="text-slate-400">
                {squawkOpen ? '▲' : '▼'}
              </span>
            </button>

            {squawkOpen && (
              <div id="ci-squawk-section" className="p-3 space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ci-squawk-title">
                    Title{' '}
                    <span aria-hidden="true" className="text-destructive">
                      *
                    </span>
                  </Label>
                  <Input
                    id="ci-squawk-title"
                    type="text"
                    placeholder="Brief description of the issue"
                    value={squawkTitle}
                    onChange={(e) => {
                      setSquawkTitle(e.target.value);
                      if (squawkTitleError) setSquawkTitleError(null);
                    }}
                    aria-required="true"
                    aria-invalid={squawkTitleError ? 'true' : undefined}
                    aria-describedby={squawkTitleError ? 'ci-squawk-title-err' : undefined}
                    disabled={isSubmitting}
                    maxLength={200}
                  />
                  {squawkTitleError && (
                    <p
                      id="ci-squawk-title-err"
                      role="alert"
                      className="text-xs text-destructive"
                    >
                      {squawkTitleError}
                    </p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="ci-squawk-desc">Description (optional)</Label>
                  <textarea
                    id="ci-squawk-desc"
                    rows={2}
                    maxLength={1000}
                    placeholder="Additional details…"
                    value={squawkDescription}
                    onChange={(e) => setSquawkDescription(e.target.value)}
                    disabled={isSubmitting}
                    className="flex w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 hover:border-slate-400 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0 disabled:opacity-50 resize-none transition-colors"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="ci-squawk-severity">Severity</Label>
                  <select
                    id="ci-squawk-severity"
                    value={squawkSeverity}
                    onChange={(e) => setSquawkSeverity(e.target.value as typeof squawkSeverity)}
                    disabled={isSubmitting}
                    className="flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm hover:border-slate-400 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0 disabled:opacity-50 transition-colors"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="grounding">Grounding (advisory label only)</option>
                  </select>
                  <p className="text-xs text-slate-500">
                    Severity is an operator triage label. Squawks do not automatically ground aircraft.
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Non-blocking squawk message (shown briefly before dialog closes) */}
          {squawkMessage && (
            <p role="status" aria-live="polite" className="text-xs text-slate-600">
              {squawkMessage}
            </p>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                autoFocus
                disabled={isSubmitting}
              >
                Keep as-is
              </Button>
            </DialogClose>
            <Button
              type="submit"
              disabled={isSubmitting || previewBlocked}
              title={
                previewBlocked
                  ? 'Hobbs in must be ≥ Hobbs out'
                  : undefined
              }
            >
              {isSubmitting ? 'Checking in…' : 'Check in'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
