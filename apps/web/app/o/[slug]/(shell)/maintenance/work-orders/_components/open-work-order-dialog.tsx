/**
 * open-work-order-dialog.tsx — "Open work order" dialog (Slice M1.3).
 *
 * Fields:
 *   - Aircraft select (required; preselected when preselectResourceId is provided)
 *   - Title (required)
 *   - Description (optional)
 *   - Linked squawk picker (optional; loads THIS aircraft's open/deferred squawks)
 *   - Work performed (optional initial notes)
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 * [VERIFY-M1-E]: resource constraint enforced server-side in openWorkOrder.
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
import {
  openWorkOrderAction,
  listSquawksForAircraftAction,
} from '../actions';
import type { SerializedWorkOrderView, SerializedSquawkView } from '../actions';
import type { AircraftListRow } from '@aeroops/api';

// ─── Props ────────────────────────────────────────────────────────────────────

interface OpenWorkOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  aircraft: AircraftListRow[];
  /** Pre-select a specific aircraft (e.g. when launched from Fleet detail). */
  preselectResourceId?: string;
  onSuccess: (workOrder: SerializedWorkOrderView) => void;
  /** Render as trigger button (default) or controlled open only. */
  children?: React.ReactNode;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function OpenWorkOrderDialog({
  open,
  onOpenChange,
  aircraft,
  preselectResourceId,
  onSuccess,
}: OpenWorkOrderDialogProps) {
  const [resourceId, setResourceId] = React.useState(preselectResourceId ?? '');
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [squawkId, setSquawkId] = React.useState('');
  const [workPerformed, setWorkPerformed] = React.useState('');

  // Squawk picker state (loads when aircraft changes)
  const [squawks, setSquawks] = React.useState<SerializedSquawkView[]>([]);
  const [squawksLoading, setSquawksLoading] = React.useState(false);

  // Validation errors
  const [resourceError, setResourceError] = React.useState<string | null>(null);
  const [titleError, setTitleError] = React.useState<string | null>(null);
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  // Reset on open
  React.useEffect(() => {
    if (open) {
      setResourceId(preselectResourceId ?? '');
      setTitle('');
      setDescription('');
      setSquawkId('');
      setWorkPerformed('');
      setSquawks([]);
      setResourceError(null);
      setTitleError(null);
      setDialogError(null);
    }
  }, [open, preselectResourceId]);

  // Load squawks when aircraft selection changes
  React.useEffect(() => {
    if (!resourceId) {
      setSquawks([]);
      setSquawkId('');
      return;
    }
    setSquawksLoading(true);
    setSquawkId('');
    listSquawksForAircraftAction({ resourceId })
      .then((result) => {
        if ('ok' in result && result.ok) {
          setSquawks(result.squawks);
        } else {
          setSquawks([]);
        }
      })
      .catch(() => setSquawks([]))
      .finally(() => setSquawksLoading(false));
  }, [resourceId]);

  // Auto-load squawks if preselectResourceId is set when dialog opens
  React.useEffect(() => {
    if (open && preselectResourceId) {
      setSquawksLoading(true);
      listSquawksForAircraftAction({ resourceId: preselectResourceId })
        .then((result) => {
          if ('ok' in result && result.ok) {
            setSquawks(result.squawks);
          }
        })
        .catch(() => {})
        .finally(() => setSquawksLoading(false));
    }
  }, [open, preselectResourceId]);

  function validate(): boolean {
    let valid = true;
    if (!resourceId) {
      setResourceError('Aircraft is required.');
      valid = false;
    } else {
      setResourceError(null);
    }
    if (!title.trim()) {
      setTitleError('Title is required.');
      valid = false;
    } else {
      setTitleError(null);
    }
    return valid;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDialogError(null);
    if (!validate()) return;

    setIsSubmitting(true);
    try {
      const result = await openWorkOrderAction({
        resourceId,
        title: title.trim(),
        description: description.trim() || undefined,
        squawkId: squawkId || undefined,
        workPerformed: workPerformed.trim() || undefined,
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          setDialogError(result.message);
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to open work orders.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      onSuccess(result.workOrder);
      onOpenChange(false);
    } catch {
      setDialogError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  const selectedAircraft = aircraft.find((a) => a.id === resourceId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Open work order</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {/* Aircraft */}
          <div className="space-y-1.5">
            <Label htmlFor="wo-aircraft">
              Aircraft{' '}
              <span aria-hidden="true" className="text-destructive">*</span>
            </Label>
            <select
              id="wo-aircraft"
              value={resourceId}
              onChange={(e) => {
                setResourceId(e.target.value);
                if (resourceError) setResourceError(null);
              }}
              aria-required="true"
              aria-invalid={resourceError ? 'true' : undefined}
              aria-describedby={resourceError ? 'wo-aircraft-err' : undefined}
              disabled={isSubmitting || !!preselectResourceId}
              className="flex h-10 w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 hover:border-slate-400 dark:hover:border-slate-500 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0 disabled:opacity-50 transition-colors"
            >
              <option value="">— Select aircraft —</option>
              {aircraft.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.tailNumber
                    ? `${a.tailNumber}${a.make || a.model ? ` — ${[a.make, a.model].filter(Boolean).join(' ')}` : ''}`
                    : a.tailNumber}
                </option>
              ))}
            </select>
            {resourceError && (
              <p id="wo-aircraft-err" role="alert" className="text-xs text-destructive">
                {resourceError}
              </p>
            )}
          </div>

          {/* Title */}
          <div className="space-y-1.5">
            <Label htmlFor="wo-title">
              Title{' '}
              <span aria-hidden="true" className="text-destructive">*</span>
            </Label>
            <Input
              id="wo-title"
              type="text"
              placeholder="Brief description of work to be done"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                if (titleError) setTitleError(null);
              }}
              aria-required="true"
              aria-invalid={titleError ? 'true' : undefined}
              aria-describedby={titleError ? 'wo-title-err' : undefined}
              disabled={isSubmitting}
              maxLength={200}
            />
            {titleError && (
              <p id="wo-title-err" role="alert" className="text-xs text-destructive">
                {titleError}
              </p>
            )}
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label htmlFor="wo-desc">Description (optional)</Label>
            <textarea
              id="wo-desc"
              rows={3}
              maxLength={2000}
              placeholder="Additional context, problem description…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isSubmitting}
              className="flex w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm placeholder:text-slate-400 hover:border-slate-400 dark:hover:border-slate-500 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0 disabled:opacity-50 resize-none transition-colors"
            />
          </div>

          {/* Linked squawk picker (only shown when aircraft is selected) */}
          {resourceId && (
            <div className="space-y-1.5">
              <Label htmlFor="wo-squawk">Link a squawk (optional)</Label>
              <select
                id="wo-squawk"
                value={squawkId}
                onChange={(e) => setSquawkId(e.target.value)}
                disabled={isSubmitting || squawksLoading}
                className="flex h-10 w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 hover:border-slate-400 dark:hover:border-slate-500 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0 disabled:opacity-50 transition-colors"
              >
                <option value="">
                  {squawksLoading
                    ? 'Loading squawks…'
                    : squawks.length === 0
                    ? `No open/deferred squawks for ${selectedAircraft?.tailNumber ?? 'this aircraft'}`
                    : '— None —'}
                </option>
                {squawks.map((s) => (
                  <option key={s.id} value={s.id}>
                    [{s.status}] {s.title}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Only open or deferred squawks on{' '}
                {selectedAircraft?.tailNumber ?? 'this aircraft'} are shown.
              </p>
            </div>
          )}

          {/* Work performed (initial notes) */}
          <div className="space-y-1.5">
            <Label htmlFor="wo-work">Initial work notes (optional)</Label>
            <textarea
              id="wo-work"
              rows={2}
              maxLength={4000}
              placeholder="Any initial work performed or notes…"
              value={workPerformed}
              onChange={(e) => setWorkPerformed(e.target.value)}
              disabled={isSubmitting}
              className="flex w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm placeholder:text-slate-400 hover:border-slate-400 dark:hover:border-slate-500 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0 disabled:opacity-50 resize-none transition-colors"
            />
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
              {isSubmitting ? 'Opening…' : 'Open work order'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
