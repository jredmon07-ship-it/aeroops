/**
 * ground-aircraft-dialog.tsx — Ground and Release dialogs for an aircraft.
 *
 * GroundAircraftDialog: requires a reason (textarea), optional squawk link.
 * ReleaseAircraftDialog: AlertDialog confirm — destructive action.
 *
 * Design: matches existing dispatch dialogs (tight corners, hairline borders,
 * brand tokens via shadcn primitives). Grounded = red/destructive chip.
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 */
'use client';

import * as React from 'react';
import { XCircle, ShieldAlert } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
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
import { Textarea } from '@/components/ui/textarea';
import { groundAircraftAction, unGroundAircraftAction } from '../../../maintenance/actions';

// ─── GroundAircraftDialog ─────────────────────────────────────────────────────

interface GroundAircraftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceId: string;
  /** Display name for the aircraft (tail # or displayName). */
  displayName: string;
  onSuccess: () => void;
}

export function GroundAircraftDialog({
  open,
  onOpenChange,
  resourceId,
  displayName,
  onSuccess,
}: GroundAircraftDialogProps) {
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
      setReasonError('Reason is required to ground an aircraft.');
      return;
    }
    setReasonError(null);

    setIsSubmitting(true);
    try {
      const result = await groundAircraftAction({ resourceId, reason: reason.trim() });

      if ('error' in result) {
        if (result.error === 'validation') {
          setDialogError(result.message);
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to ground aircraft.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      // ok:true (including alreadyGrounded idempotent case)
      onSuccess();
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
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-destructive" aria-hidden="true" />
            Ground {displayName}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <p className="text-sm text-slate-600">
            Grounding this aircraft will prevent it from being dispatched until
            released. This is operator data — it does not constitute a
            regulatory airworthiness determination.
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="ground-reason">
              Reason{' '}
              <span aria-hidden="true" className="text-destructive">
                *
              </span>
            </Label>
            <Textarea
              id="ground-reason"
              rows={3}
              maxLength={500}
              placeholder="Describe why this aircraft is being grounded…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-required="true"
              aria-invalid={reasonError ? 'true' : undefined}
              aria-describedby={reasonError ? 'ground-reason-err' : undefined}
              disabled={isSubmitting}
            />
            {reasonError && (
              <p
                id="ground-reason-err"
                role="alert"
                className="text-xs text-destructive"
              >
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

          <DialogFooter>
            <DialogClose asChild>
              <Button
                type="button"
                variant="outline"
                autoFocus
                disabled={isSubmitting}
              >
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="submit"
              variant="destructive"
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Grounding…' : 'Ground aircraft'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── ReleaseAircraftDialog ────────────────────────────────────────────────────

interface ReleaseAircraftDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceId: string;
  displayName: string;
  onSuccess: () => void;
}

export function ReleaseAircraftDialog({
  open,
  onOpenChange,
  resourceId,
  displayName,
  onSuccess,
}: ReleaseAircraftDialogProps) {
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setDialogError(null);
    }
  }, [open]);

  async function handleRelease() {
    setDialogError(null);
    setIsSubmitting(true);
    try {
      const result = await unGroundAircraftAction({ resourceId });

      if ('error' in result) {
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to release aircraft.');
          return;
        }
        if (result.error === 'validation') {
          setDialogError(result.message);
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      // ok:true (including alreadyReleased idempotent case)
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
          <AlertDialogTitle>Release {displayName} from grounding?</AlertDialogTitle>
          <AlertDialogDescription>
            This will allow {displayName} to be dispatched again. The grounding
            event is preserved in the audit log.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {dialogError && (
          <Alert variant="destructive" role="alert" aria-live="assertive" className="mt-2">
            <XCircle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>{dialogError}</AlertDescription>
          </Alert>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel autoFocus disabled={isSubmitting}>
            Keep grounded
          </AlertDialogCancel>
          <Button
            variant="default"
            onClick={handleRelease}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Releasing…' : 'Release aircraft'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
