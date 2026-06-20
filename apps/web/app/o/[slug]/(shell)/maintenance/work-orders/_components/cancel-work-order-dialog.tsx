/**
 * cancel-work-order-dialog.tsx — "Cancel work order" dialog (Slice M1.3).
 *
 * Requires a cancellation reason (non-empty).
 * Displays copy clarifying that cancellation does NOT resolve squawks or
 * return the aircraft to service. Destructive confirm pattern.
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
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
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cancelWorkOrderAction } from '../actions';
import type { SerializedWorkOrderView } from '../actions';

// ─── Props ────────────────────────────────────────────────────────────────────

interface CancelWorkOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workOrder: SerializedWorkOrderView;
  onSuccess: (workOrder: SerializedWorkOrderView) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CancelWorkOrderDialog({
  open,
  onOpenChange,
  workOrder,
  onSuccess,
}: CancelWorkOrderDialogProps) {
  const [reason, setReason] = React.useState('');
  const [reasonError, setReasonError] = React.useState<string | null>(null);
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setReason('');
      setReasonError(null);
      setDialogError(null);
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDialogError(null);

    if (!reason.trim()) {
      setReasonError('Cancellation reason is required.');
      return;
    }
    setReasonError(null);
    setIsSubmitting(true);

    try {
      const result = await cancelWorkOrderAction({
        workOrderId: workOrder.id,
        cancelledReason: reason.trim(),
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          setDialogError(result.message);
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to cancel this work order.');
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
        if (result.reason === 'not_cancellable') {
          setDialogError('This work order has already been completed or cancelled.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      // ok:true — result.workOrder is already SerializedWorkOrderView from the action.
      onSuccess(result.workOrder);
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
          <AlertDialogTitle>Cancel work order</AlertDialogTitle>
          <AlertDialogDescription>
            This will cancel <span className="font-medium">&ldquo;{workOrder.title}&rdquo;</span>.{' '}
            Cancelling does not resolve squawks or return the aircraft to service.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="cancel-reason">
              Cancellation reason{' '}
              <span aria-hidden="true" className="text-destructive">*</span>
            </Label>
            <textarea
              id="cancel-reason"
              rows={3}
              maxLength={1000}
              placeholder="Why is this work order being cancelled?"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (reasonError) setReasonError(null);
              }}
              aria-required="true"
              aria-invalid={reasonError ? 'true' : undefined}
              aria-describedby={reasonError ? 'cancel-reason-err' : undefined}
              disabled={isSubmitting}
              className="flex w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 disabled:opacity-50 resize-none"
            />
            {reasonError && (
              <p id="cancel-reason-err" role="alert" className="text-xs text-destructive">
                {reasonError}
              </p>
            )}
          </div>

          {dialogError && (
            <Alert variant="destructive" role="alert" aria-live="assertive">
              <XCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{dialogError}</AlertDescription>
            </Alert>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel autoFocus disabled={isSubmitting}>
              Keep open
            </AlertDialogCancel>
            <Button type="submit" variant="destructive" disabled={isSubmitting}>
              {isSubmitting ? 'Cancelling…' : 'Cancel work order'}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
