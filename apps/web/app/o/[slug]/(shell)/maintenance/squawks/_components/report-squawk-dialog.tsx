/**
 * report-squawk-dialog.tsx — "Report squawk" dialog.
 *
 * Fields: aircraft select (required), title (required), description (optional),
 * severity select. On severity='grounding' + maintenance:ground, a follow-up
 * prompt asks "Ground <tail #> now?".
 *
 * Result mapping:
 *   ok:true → close + onSuccess(squawk); optionally open grounding prompt.
 *   { error: 'validation' } → inline field errors.
 *   { error: 'forbidden' }  → inline auth error.
 *   { error: 'server' }     → generic inline error.
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
import { reportSquawkAction, groundAircraftAction } from '../../actions';
import type { SquawkView } from '@aeroops/api';
import type { ResourceRow } from '@aeroops/api';

// ─── Props ────────────────────────────────────────────────────────────────────

interface ReportSquawkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Active aircraft resources for the aircraft select. */
  aircraft: ResourceRow[];
  /** Whether the user has maintenance:ground (shows ground-now follow-up). */
  canGround: boolean;
  onSuccess: (squawk: SquawkView) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ReportSquawkDialog({
  open,
  onOpenChange,
  aircraft,
  canGround,
  onSuccess,
}: ReportSquawkDialogProps) {
  const [resourceId, setResourceId] = React.useState('');
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [severity, setSeverity] = React.useState<'low' | 'medium' | 'high' | 'grounding'>('low');

  const [resourceError, setResourceError] = React.useState<string | null>(null);
  const [titleError, setTitleError] = React.useState<string | null>(null);
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  // Ground-now follow-up state
  const [groundNowOpen, setGroundNowOpen] = React.useState(false);
  const [createdSquawk, setCreatedSquawk] = React.useState<SquawkView | null>(null);
  const [isGrounding, setIsGrounding] = React.useState(false);
  const [groundError, setGroundError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setResourceId('');
      setTitle('');
      setDescription('');
      setSeverity('low');
      setResourceError(null);
      setTitleError(null);
      setDialogError(null);
    }
  }, [open]);

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
      const result = await reportSquawkAction({
        resourceId,
        title: title.trim(),
        description: description.trim() || undefined,
        severity,
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          setDialogError(result.message);
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to report squawks.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      // ok:true
      const squawk = result.squawk;

      // If severity='grounding' and canGround, show the follow-up prompt.
      if (severity === 'grounding' && canGround) {
        setCreatedSquawk(squawk);
        setGroundNowOpen(true);
        onOpenChange(false); // close report dialog
        return;
      }

      onSuccess(squawk);
      onOpenChange(false);
    } catch {
      setDialogError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleGroundNow() {
    if (!createdSquawk) return;
    setGroundError(null);
    setIsGrounding(true);
    try {
      const result = await groundAircraftAction({
        resourceId: createdSquawk.resourceId,
        reason: createdSquawk.title,
        squawkId: createdSquawk.id,
      });
      if ('error' in result) {
        setGroundError('Could not ground aircraft. You can do it manually from the dispatch board.');
        return;
      }
      // ok:true — close ground-now dialog and callback
      setGroundNowOpen(false);
      onSuccess(createdSquawk);
    } catch {
      setGroundError('Could not ground aircraft. You can do it manually from the dispatch board.');
    } finally {
      setIsGrounding(false);
    }
  }

  function handleSkipGrounding() {
    setGroundNowOpen(false);
    if (createdSquawk) onSuccess(createdSquawk);
  }

  const selectedAircraft = aircraft.find((r) => r.id === resourceId);
  const aircraftName = selectedAircraft?.tailNumber ?? selectedAircraft?.displayName ?? '';

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Report squawk</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            {/* Aircraft select */}
            <div className="space-y-1.5">
              <Label htmlFor="sq-aircraft">
                Aircraft{' '}
                <span aria-hidden="true" className="text-destructive">
                  *
                </span>
              </Label>
              <select
                id="sq-aircraft"
                value={resourceId}
                onChange={(e) => {
                  setResourceId(e.target.value);
                  if (resourceError) setResourceError(null);
                }}
                aria-required="true"
                aria-invalid={resourceError ? 'true' : undefined}
                aria-describedby={resourceError ? 'sq-aircraft-err' : undefined}
                disabled={isSubmitting}
                className="flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 disabled:opacity-50"
              >
                <option value="">— Select aircraft —</option>
                {aircraft.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.tailNumber ? `${r.tailNumber} — ${r.displayName}` : r.displayName}
                  </option>
                ))}
              </select>
              {resourceError && (
                <p
                  id="sq-aircraft-err"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {resourceError}
                </p>
              )}
            </div>

            {/* Title */}
            <div className="space-y-1.5">
              <Label htmlFor="sq-title">
                Title{' '}
                <span aria-hidden="true" className="text-destructive">
                  *
                </span>
              </Label>
              <Input
                id="sq-title"
                type="text"
                placeholder="Brief description of the issue"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (titleError) setTitleError(null);
                }}
                aria-required="true"
                aria-invalid={titleError ? 'true' : undefined}
                aria-describedby={titleError ? 'sq-title-err' : undefined}
                disabled={isSubmitting}
                maxLength={200}
              />
              {titleError && (
                <p
                  id="sq-title-err"
                  role="alert"
                  className="text-xs text-destructive"
                >
                  {titleError}
                </p>
              )}
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <Label htmlFor="sq-desc">Description (optional)</Label>
              <textarea
                id="sq-desc"
                rows={3}
                maxLength={1000}
                placeholder="Additional details, symptoms, conditions…"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={isSubmitting}
                className="flex w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 disabled:opacity-50 resize-none"
              />
            </div>

            {/* Severity */}
            <div className="space-y-1.5">
              <Label htmlFor="sq-severity">Severity</Label>
              <select
                id="sq-severity"
                value={severity}
                onChange={(e) => setSeverity(e.target.value as typeof severity)}
                disabled={isSubmitting}
                className="flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 disabled:opacity-50"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="grounding">Grounding (advisory label only)</option>
              </select>
              {severity === 'grounding' && (
                <p className="text-xs text-slate-500">
                  Severity &ldquo;Grounding&rdquo; is a triage label only — it does not
                  automatically ground the aircraft.
                  {canGround && " You'll be asked if you want to ground now."}
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
              <Button type="submit" disabled={isSubmitting}>
                {isSubmitting ? 'Reporting…' : 'Report squawk'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Ground-now follow-up dialog */}
      <AlertDialog open={groundNowOpen} onOpenChange={setGroundNowOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Ground <span className="nums font-mono">{aircraftName}</span> now?
            </AlertDialogTitle>
            <AlertDialogDescription>
              You reported a grounding-severity squawk. Do you want to ground{' '}
              <span className="nums font-mono">{aircraftName}</span> immediately to prevent dispatch?
              This action can be undone by releasing the aircraft.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {groundError && (
            <Alert variant="destructive" role="alert" className="mt-2">
              <XCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{groundError}</AlertDescription>
            </Alert>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel autoFocus disabled={isGrounding} onClick={handleSkipGrounding}>
              Not now
            </AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={handleGroundNow}
              disabled={isGrounding}
            >
              {isGrounding ? 'Grounding…' : 'Ground aircraft'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
