/**
 * void-dispatch-dialog.tsx — "Void check-out" confirmation dialog.
 *
 * Renders as an AlertDialog (destructive confirm) when a block has an open
 * dispatch ticket. Provides a reason input (required) and maps the result.
 *
 * Safer default: "Keep checked out" (the cancel / safer path is autofocused).
 *
 * Result mapping:
 *   ok:true                      → close + onSuccess()
 *   ok:false reason:'not_open'  → inline "This check-out is already closed or voided"
 *   ok:false reason:'not_found' → inline "Ticket no longer available"
 *   { error: 'forbidden' }      → inline auth error
 *   { error: 'server' }         → generic inline error
 *
 * BOUNDARY: imports only from '@aeroops/api'. No '@aeroops/db'.
 */
'use client';

import * as React from 'react';
import { XCircle } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { voidDispatchAction } from '../../actions';

// ─── Props ────────────────────────────────────────────────────────────────────

interface VoidDispatchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The open dispatch ticket being voided. */
  ticketId: string;
  /** Called on successful void — board should reflect the freed/none state. */
  onSuccess: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function VoidDispatchDialog({
  open,
  onOpenChange,
  ticketId,
  onSuccess,
}: VoidDispatchDialogProps) {
  // ── Form state ─────────────────────────────────────────────────────────────
  const [reason, setReason] = React.useState('');
  const [reasonError, setReasonError] = React.useState<string | null>(null);
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  // ── Reset when dialog opens ────────────────────────────────────────────────
  React.useEffect(() => {
    if (open) {
      setReason('');
      setReasonError(null);
      setDialogError(null);
    }
  }, [open]);

  // ── Submit ─────────────────────────────────────────────────────────────────
  async function handleVoid() {
    setDialogError(null);

    if (!reason.trim()) {
      setReasonError('Reason is required.');
      return;
    }
    setReasonError(null);

    setIsSubmitting(true);
    try {
      const result = await voidDispatchAction({
        ticketId,
        reason: reason.trim(),
      });

      if ('error' in result) {
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to void this check-out.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      if (!result.ok) {
        if (result.reason === 'not_open') {
          setDialogError('This check-out is already closed or voided.');
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
      onSuccess();
      onOpenChange(false);
    } catch {
      setDialogError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Void this check-out?</AlertDialogTitle>
          <AlertDialogDescription>
            This will mark the dispatch ticket as voided and free the aircraft
            for a new check-out. This action cannot be undone in Slice 3a.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Reason input — inside the alert dialog body */}
        <div className="space-y-1.5 mt-2">
          <Label htmlFor="void-reason">
            Reason <span aria-hidden="true" className="text-red-500 dark:text-red-400">*</span>
          </Label>
          <Input
            id="void-reason"
            type="text"
            placeholder="e.g. Entered wrong aircraft"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-required="true"
            aria-invalid={reasonError ? 'true' : undefined}
            aria-describedby={reasonError ? 'void-reason-err' : undefined}
            disabled={isSubmitting}
          />
          {reasonError && (
            <p
              id="void-reason-err"
              role="alert"
              className="text-xs text-red-600 dark:text-red-400"
            >
              {reasonError}
            </p>
          )}
        </div>

        {/* Dialog-level error */}
        {dialogError && (
          <Alert variant="destructive" role="alert" aria-live="assertive" className="mt-2">
            <XCircle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>{dialogError}</AlertDescription>
          </Alert>
        )}

        <AlertDialogFooter>
          {/* Safer default: "Keep checked out" is the cancel / do-nothing path.
              AlertDialogCancel maps to the Radix cancel button which is the
              focus target on open per AlertDialog spec. */}
          <AlertDialogCancel
            autoFocus
            disabled={isSubmitting}
            onClick={() => onOpenChange(false)}
          >
            Keep checked out
          </AlertDialogCancel>
          {/* Destructive confirm */}
          <Button
            variant="destructive"
            onClick={handleVoid}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Voiding…' : 'Void check-out'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
