/**
 * cancel-reservation-dialog.tsx — AlertDialog confirmation for cancelling a reservation.
 *
 * Spec §7: Title "Cancel this reservation?", safer default "Keep reservation".
 * Calls cancelReservationAction and notifies parent via onSuccess/onError.
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
import { Textarea } from '@/components/ui/textarea';
import { cancelReservationAction } from '../actions';

interface CancelReservationDialogProps {
  reservationId: string;
  timeRange: string;
  resourceNames: string;
  onSuccess: () => void;
  onError: (message: string) => void;
}

export function CancelReservationDialog({
  reservationId,
  timeRange,
  resourceNames,
  onSuccess,
  onError,
}: CancelReservationDialogProps) {
  const [pending, setPending] = React.useState(false);
  const [reason, setReason] = React.useState('');

  const handleCancel = async () => {
    setPending(true);
    try {
      const trimmed = reason.trim();
      const result = await cancelReservationAction({
        reservationId,
        ...(trimmed ? { reason: trimmed } : {}),
      });
      if ('error' in result) {
        onError('Could not cancel the reservation. Please try again.');
        return;
      }
      if (!result.ok && result.reason === 'not_found') {
        onError('Reservation not found. It may have already been cancelled.');
        return;
      }
      onSuccess();
    } catch {
      onError('Something went wrong. Please try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Cancel reservation ${timeRange}`}
        >
          Cancel
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel this reservation?</AlertDialogTitle>
          <AlertDialogDescription>
            This will cancel the {timeRange} reservation for {resourceNames}. This
            action is recorded.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1.5">
          <label htmlFor="cancel-reservation-reason" className="text-sm font-medium text-slate-700">
            Reason <span className="font-normal text-slate-400">(optional)</span>
          </label>
          <Textarea
            id="cancel-reservation-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. weather, maintenance, member request…"
            rows={2}
            maxLength={500}
            disabled={pending}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus disabled={pending}>
            Keep reservation
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void handleCancel();
            }}
            disabled={pending}
          >
            {pending ? 'Cancelling…' : 'Cancel reservation'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
