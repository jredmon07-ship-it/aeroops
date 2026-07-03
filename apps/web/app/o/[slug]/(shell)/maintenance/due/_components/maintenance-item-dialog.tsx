/**
 * maintenance-item-dialog.tsx — Create/edit dialog for a maintenance_item
 * (Slice P1.5).
 *
 * mode='create': aircraft select + title + track-by toggle (hours/date) +
 *   basis-appropriate fields (all editable).
 * mode='edit': resourceId/trackBy/meterBasis shown read-only (write-once);
 *   title/dueValue|dueDate/warnThreshold|warnLeadDays/notes editable.
 *
 * COMPLIANCE: verbatim disclaimer — operator-entered tracking thresholds,
 * NOT a computed FAA/Part-43/91.409 airworthiness or inspection-due
 * determination. A mechanic/IA makes the airworthiness call.
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
import { createMaintenanceItemAction, updateMaintenanceItemAction } from '../../due-actions';
import type { SerializedMaintenanceDueView, SerializedMaintenanceItemView } from '../../due-actions';
import type { ResourceRow } from '@aeroops/api';

// ─── Props ────────────────────────────────────────────────────────────────────

interface MaintenanceItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  /** Active aircraft for the create-mode select. */
  aircraft: ResourceRow[];
  /** Pre-select this aircraft in create mode (e.g. from the fleet-detail facet). */
  preselectResourceId?: string;
  /** Required in edit mode — the item being edited. */
  item?: SerializedMaintenanceDueView;
  /**
   * Called with the plain MaintenanceItemView returned by create/update
   * (no due-status fields — the caller re-derives/merges status locally;
   * see maintenance-due-list.tsx handleCreateSuccess/handleEditSuccess).
   */
  onSuccess: (item: SerializedMaintenanceItemView) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MaintenanceItemDialog({
  open,
  onOpenChange,
  mode,
  aircraft,
  preselectResourceId,
  item,
  onSuccess,
}: MaintenanceItemDialogProps) {
  const [resourceId, setResourceId] = React.useState(preselectResourceId ?? '');
  const [title, setTitle] = React.useState('');
  const [trackBy, setTrackBy] = React.useState<'hours' | 'date'>('hours');
  const [meterBasis, setMeterBasis] = React.useState<'hobbs' | 'tach'>('hobbs');
  const [dueValueHours, setDueValueHours] = React.useState('');
  const [dueDate, setDueDate] = React.useState('');
  const [warnThresholdHours, setWarnThresholdHours] = React.useState('');
  const [warnLeadDays, setWarnLeadDays] = React.useState('');
  const [notes, setNotes] = React.useState('');

  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setDialogError(null);
    setFieldError(null);
    if (mode === 'edit' && item) {
      setResourceId(item.resourceId);
      setTitle(item.title);
      setTrackBy(item.trackBy);
      setMeterBasis(item.meterBasis ?? 'hobbs');
      setDueValueHours(item.dueValueHours != null ? String(item.dueValueHours) : '');
      setDueDate(item.dueDate ?? '');
      setWarnThresholdHours(item.warnThresholdHours != null ? String(item.warnThresholdHours) : '');
      setWarnLeadDays(item.warnLeadDays != null ? String(item.warnLeadDays) : '');
      setNotes(item.notes ?? '');
    } else {
      setResourceId(preselectResourceId ?? '');
      setTitle('');
      setTrackBy('hours');
      setMeterBasis('hobbs');
      setDueValueHours('');
      setDueDate('');
      setWarnThresholdHours('');
      setWarnLeadDays('');
      setNotes('');
    }
  }, [open, mode, item, preselectResourceId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDialogError(null);
    setFieldError(null);

    if (mode === 'create' && !resourceId) {
      setFieldError('Aircraft is required.');
      return;
    }
    if (!title.trim()) {
      setFieldError('Title is required.');
      return;
    }
    if (trackBy === 'hours' && dueValueHours.trim() === '') {
      setFieldError('Due at (hours) is required.');
      return;
    }
    if (trackBy === 'date' && dueDate.trim() === '') {
      setFieldError('Due date is required.');
      return;
    }

    setIsSubmitting(true);
    try {
      if (mode === 'create') {
        const result = await createMaintenanceItemAction({
          resourceId,
          title: title.trim(),
          trackBy,
          meterBasis: trackBy === 'hours' ? meterBasis : undefined,
          dueValueHours: trackBy === 'hours' ? Number(dueValueHours) : undefined,
          dueDate: trackBy === 'date' ? dueDate : undefined,
          warnThresholdHours:
            trackBy === 'hours' && warnThresholdHours.trim() !== '' ? Number(warnThresholdHours) : undefined,
          warnLeadDays: trackBy === 'date' && warnLeadDays.trim() !== '' ? Number(warnLeadDays) : undefined,
          notes: notes.trim() || undefined,
        });
        if ('error' in result) {
          if (result.error === 'validation') { setDialogError(result.message); return; }
          if (result.error === 'forbidden' || result.error === 'unauthenticated') {
            setDialogError('You do not have permission to add maintenance items.');
            return;
          }
          setDialogError('Something went wrong. Please try again.');
          return;
        }
        onSuccess(result.item);
        onOpenChange(false);
      } else if (item) {
        const result = await updateMaintenanceItemAction({
          itemId: item.id,
          title: title.trim(),
          dueValueHours: item.trackBy === 'hours' ? Number(dueValueHours) : undefined,
          dueDate: item.trackBy === 'date' ? dueDate : undefined,
          warnThresholdHours:
            item.trackBy === 'hours'
              ? (warnThresholdHours.trim() !== '' ? Number(warnThresholdHours) : null)
              : undefined,
          warnLeadDays:
            item.trackBy === 'date'
              ? (warnLeadDays.trim() !== '' ? Number(warnLeadDays) : null)
              : undefined,
          notes: notes.trim() || null,
        });
        if ('error' in result) {
          if (result.error === 'validation') { setDialogError(result.message); return; }
          if (result.error === 'forbidden' || result.error === 'unauthenticated') {
            setDialogError('You do not have permission to edit maintenance items.');
            return;
          }
          setDialogError('Something went wrong. Please try again.');
          return;
        }
        if (!result.ok) {
          setDialogError('That item could not be found.');
          return;
        }
        onSuccess(result.item);
        onOpenChange(false);
      }
    } catch {
      setDialogError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  const effectiveTrackBy = mode === 'edit' && item ? item.trackBy : trackBy;
  const effectiveBasis = mode === 'edit' && item ? item.meterBasis : meterBasis;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Add maintenance item' : 'Edit maintenance item'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {mode === 'create' && (
            <div className="space-y-1.5">
              <Label htmlFor="mi-aircraft">
                Aircraft <span aria-hidden="true" className="text-destructive">*</span>
              </Label>
              <select
                id="mi-aircraft"
                value={resourceId}
                onChange={(e) => setResourceId(e.target.value)}
                disabled={isSubmitting || !!preselectResourceId}
                aria-required="true"
                className="flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-400 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-50 transition-colors"
              >
                <option value="">— Select aircraft —</option>
                {aircraft.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.tailNumber ? `${r.tailNumber} — ${r.displayName}` : r.displayName}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="mi-title">
              Title <span aria-hidden="true" className="text-destructive">*</span>
            </Label>
            <Input
              id="mi-title"
              type="text"
              placeholder="e.g. Annual inspection, Oil change, 100-hour"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={isSubmitting}
              maxLength={200}
              aria-required="true"
            />
          </div>

          {mode === 'create' && (
            <div className="space-y-1.5">
              <Label htmlFor="mi-track-by">Tracked by</Label>
              <select
                id="mi-track-by"
                value={trackBy}
                onChange={(e) => setTrackBy(e.target.value as 'hours' | 'date')}
                disabled={isSubmitting}
                className="flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-400 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-50 transition-colors"
              >
                <option value="hours">Meter hours (Hobbs/tach)</option>
                <option value="date">Calendar date</option>
              </select>
            </div>
          )}

          {effectiveTrackBy === 'hours' && (
            <>
              {mode === 'create' && (
                <div className="space-y-1.5">
                  <Label htmlFor="mi-basis">Meter</Label>
                  <select
                    id="mi-basis"
                    value={meterBasis}
                    onChange={(e) => setMeterBasis(e.target.value as 'hobbs' | 'tach')}
                    disabled={isSubmitting}
                    className="flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-400 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-50 transition-colors"
                  >
                    <option value="hobbs">Hobbs</option>
                    <option value="tach">Tach</option>
                  </select>
                </div>
              )}
              {mode === 'edit' && (
                <p className="text-xs text-slate-500">
                  Tracked by {effectiveBasis === 'tach' ? 'tach' : 'Hobbs'} hours.
                </p>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="mi-due-hours">
                  Due at ({effectiveBasis ?? 'meter'} reading){' '}
                  <span aria-hidden="true" className="text-destructive">*</span>
                </Label>
                <Input
                  id="mi-due-hours"
                  type="number"
                  step="0.1"
                  min="0"
                  value={dueValueHours}
                  onChange={(e) => setDueValueHours(e.target.value)}
                  disabled={isSubmitting}
                  aria-required="true"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mi-warn-hours">Warn when within (hours, optional)</Label>
                <Input
                  id="mi-warn-hours"
                  type="number"
                  step="0.1"
                  min="0"
                  value={warnThresholdHours}
                  onChange={(e) => setWarnThresholdHours(e.target.value)}
                  disabled={isSubmitting}
                />
              </div>
            </>
          )}

          {effectiveTrackBy === 'date' && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="mi-due-date">
                  Due date <span aria-hidden="true" className="text-destructive">*</span>
                </Label>
                <Input
                  id="mi-due-date"
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  disabled={isSubmitting}
                  aria-required="true"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="mi-warn-days">Warn when within (days, optional)</Label>
                <Input
                  id="mi-warn-days"
                  type="number"
                  step="1"
                  min="0"
                  value={warnLeadDays}
                  onChange={(e) => setWarnLeadDays(e.target.value)}
                  disabled={isSubmitting}
                />
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="mi-notes">Notes (optional)</Label>
            <Textarea
              id="mi-notes"
              rows={3}
              maxLength={1000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={isSubmitting}
            />
          </div>

          <p className="text-xs text-slate-500">
            This is operator-entered tracking data and an arithmetic reminder — not a computed
            Part-43/91.409 airworthiness or inspection-due determination. A mechanic/IA makes the
            airworthiness call.
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
              {isSubmitting ? 'Saving…' : mode === 'create' ? 'Add item' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
