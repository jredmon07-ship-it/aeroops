/**
 * resolve-squawk-dialog.tsx — "Resolve" or "Defer" squawk dialog.
 *
 * Used for both resolve and defer transitions (open → resolved/deferred).
 * Resolution notes are optional for defer, optional for resolve.
 *
 * Result mapping:
 *   ok:true           → close + onSuccess(squawk).
 *   ok:false not_open → inline "Already resolved or deferred".
 *   ok:false not_found → inline "Squawk not found".
 *   { error: 'validation' } → inline error.
 *   { error: 'forbidden' }  → inline error.
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
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { updateSquawkStatusAction } from '../../actions';
import type { SquawkView } from '@aeroops/api';

// ─── Props ────────────────────────────────────────────────────────────────────

interface ResolveSquawkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  squawk: SquawkView;
  /** 'resolved' or 'deferred' — controls dialog title and action label. */
  mode: 'resolved' | 'deferred';
  onSuccess: (squawk: SquawkView) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ResolveSquawkDialog({
  open,
  onOpenChange,
  squawk,
  mode,
  onSuccess,
}: ResolveSquawkDialogProps) {
  const [notes, setNotes] = React.useState('');
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setNotes('');
      setDialogError(null);
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDialogError(null);
    setIsSubmitting(true);
    try {
      const result = await updateSquawkStatusAction({
        squawkId: squawk.id,
        status: mode,
        resolutionNotes: notes.trim() || undefined,
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          setDialogError(result.message);
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to update this squawk.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      if (!result.ok) {
        if (result.reason === 'not_open') {
          setDialogError('This squawk is already resolved or deferred.');
          return;
        }
        if (result.reason === 'not_found') {
          setDialogError('Squawk not found.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      onSuccess(result.squawk);
      onOpenChange(false);
    } catch {
      setDialogError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  const title = mode === 'resolved' ? 'Resolve squawk' : 'Defer squawk';
  const actionLabel = mode === 'resolved' ? 'Resolve' : 'Defer';
  const submittingLabel = mode === 'resolved' ? 'Resolving…' : 'Deferring…';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="rounded-md bg-slate-50 border border-slate-200 px-3 py-2 text-sm text-slate-700 space-y-0.5">
          <p className="font-medium truncate">{squawk.title}</p>
          {squawk.description && (
            <p className="text-xs text-slate-500 line-clamp-2">{squawk.description}</p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="resolve-notes">
              {mode === 'deferred' ? 'Defer notes (optional)' : 'Resolution notes (optional)'}
            </Label>
            <textarea
              id="resolve-notes"
              rows={3}
              maxLength={1000}
              placeholder={
                mode === 'deferred'
                  ? 'Why is this being deferred? When will it be addressed?'
                  : 'Describe how this was resolved…'
              }
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={isSubmitting}
              className="flex w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm placeholder:text-slate-400 hover:border-slate-400 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0 disabled:opacity-50 resize-none transition-colors"
            />
          </div>

          {mode === 'deferred' && (
            <p className="text-xs text-slate-500">
              Deferred is a plain operator status with a reason — it does not
              constitute an MEL or airworthiness determination.
            </p>
          )}

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
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? submittingLabel : actionLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
