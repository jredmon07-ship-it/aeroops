/**
 * cancel-series-dialog.tsx — AlertDialog confirmation for cancelling a reservation series.
 *
 * Spec §4.2 (Slice 2b): "This cancels N future occurrences (past occurrences are kept)".
 * Mirrors cancel-reservation-dialog.tsx in pattern.
 *
 * States: idle / confirming (dialog open) / submitting / success (toast) /
 *         error / not_found / permission-denied.
 *
 * Gate: schedule:create_reservation — trigger hidden if caller does not pass canCancel.
 */
'use client';

import * as React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { cancelSeriesAction } from '../../../actions';

interface CancelSeriesDialogProps {
  seriesId: string;
  /** Number of future booked occurrences that will be cancelled. */
  futureBookedCount: number;
  /** Whether the current user has schedule:create_reservation (hides trigger if false). */
  canCancel: boolean;
  onSuccess: (cancelledCount: number) => void;
  onError: (message: string) => void;
}

export function CancelSeriesDialog({
  seriesId,
  futureBookedCount,
  canCancel,
  onSuccess,
  onError,
}: CancelSeriesDialogProps) {
  const [pending, setPending] = React.useState(false);

  // Capability gate: hide trigger entirely if user cannot cancel
  if (!canCancel) return null;

  const handleCancel = async () => {
    setPending(true);
    try {
      const result = await cancelSeriesAction({ seriesId });

      if ('error' in result) {
        if (result.error === 'forbidden') {
          onError('You do not have permission to cancel this series.');
        } else {
          onError('Could not cancel the series. Please try again.');
        }
        return;
      }

      if (!result.ok && result.reason === 'not_found') {
        onError('Series not found. It may have already been cancelled or removed.');
        return;
      }

      if (result.ok) {
        onSuccess(result.cancelledCount);
      }
    } catch {
      onError('Something went wrong. Please try again.');
    } finally {
      setPending(false);
    }
  };

  const futureLabel =
    futureBookedCount === 1
      ? '1 future occurrence'
      : `${futureBookedCount} future occurrences`;

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="destructive"
          size="sm"
          aria-label="Cancel all future occurrences in this series"
        >
          Cancel Series
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this series?</AlertDialogTitle>
          <AlertDialogDescription>
            This cancels {futureLabel}. Past occurrences are kept and their
            records are preserved. This action is recorded.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus disabled={pending}>
            Keep series
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void handleCancel();
            }}
            disabled={pending}
          >
            {pending ? 'Cancelling…' : 'Cancel series'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
