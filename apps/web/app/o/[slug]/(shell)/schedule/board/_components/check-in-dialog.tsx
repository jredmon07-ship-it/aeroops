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

  // ── Reset form when dialog opens ───────────────────────────────────────────
  React.useEffect(() => {
    if (open) {
      setHobbsIn('');
      setTachIn('');
      setHobbsError(null);
      setTachError(null);
      setDialogError(null);
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

      // ok:true
      onSuccess(result.ticket);
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
