/**
 * mark-serviced-dialog.tsx — "Mark serviced" dialog (Slice P1.5).
 *
 * Records that the operator addressed the item and advances its due
 * threshold to a new value the operator supplies. Basis-aware: hours-tracked
 * items ask for the next due meter reading; date-tracked items ask for the
 * next due date.
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
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
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { markMaintenanceItemServicedAction } from '../../due-actions';
import type { SerializedMaintenanceDueView } from '../../due-actions';

interface MarkServicedDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: SerializedMaintenanceDueView;
  onSuccess: (item: SerializedMaintenanceDueView) => void;
}

export function MarkServicedDialog({ open, onOpenChange, item, onSuccess }: MarkServicedDialogProps) {
  const [newDueValueHours, setNewDueValueHours] = React.useState('');
  const [newDueDate, setNewDueDate] = React.useState('');
  const [note, setNote] = React.useState('');
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setNewDueValueHours('');
    setNewDueDate('');
    setNote('');
    setFieldError(null);
    setDialogError(null);
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDialogError(null);
    setFieldError(null);

    if (item.trackBy === 'hours' && newDueValueHours.trim() === '') {
      setFieldError('Next due (hours) is required.');
      return;
    }
    if (item.trackBy === 'date' && newDueDate.trim() === '') {
      setFieldError('Next due date is required.');
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await markMaintenanceItemServicedAction({
        itemId: item.id,
        newDueValueHours: item.trackBy === 'hours' ? Number(newDueValueHours) : undefined,
        newDueDate: item.trackBy === 'date' ? newDueDate : undefined,
        note: note.trim() || undefined,
      });
      if ('error' in result) {
        if (result.error === 'validation') { setDialogError(result.message); return; }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to mark items serviced.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }
      if (!result.ok) {
        setDialogError('That item could not be found.');
        return;
      }
      onSuccess(result.item as SerializedMaintenanceDueView);
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
          <DialogTitle>Mark &ldquo;{item.title}&rdquo; serviced</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {item.trackBy === 'hours' ? (
            <div className="space-y-1.5">
              <Label htmlFor="ms-hours">
                Next due at ({item.meterBasis ?? 'meter'} reading){' '}
                <span aria-hidden="true" className="text-destructive">*</span>
              </Label>
              <Input
                id="ms-hours"
                type="number"
                step="0.1"
                min="0"
                value={newDueValueHours}
                onChange={(e) => setNewDueValueHours(e.target.value)}
                disabled={isSubmitting}
                aria-required="true"
              />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="ms-date">
                Next due date <span aria-hidden="true" className="text-destructive">*</span>
              </Label>
              <Input
                id="ms-date"
                type="date"
                value={newDueDate}
                onChange={(e) => setNewDueDate(e.target.value)}
                disabled={isSubmitting}
                aria-required="true"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="ms-note">Note (optional)</Label>
            <Textarea
              id="ms-note"
              rows={2}
              maxLength={500}
              placeholder="What was done"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={isSubmitting}
            />
          </div>

          <p className="text-xs text-slate-500 dark:text-slate-400">
            This records that you addressed the item and sets the next due threshold — it is
            operator data entry, not a return-to-service or airworthiness sign-off.
          </p>

          {fieldError && (
            <Alert variant="destructive" role="alert">
              <XCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{fieldError}</AlertDescription>
            </Alert>
          )}
          {dialogError && (
            <Alert variant="destructive" role="alert" aria-live="assertive">
              <XCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{dialogError}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isSubmitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving…' : 'Mark serviced'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
