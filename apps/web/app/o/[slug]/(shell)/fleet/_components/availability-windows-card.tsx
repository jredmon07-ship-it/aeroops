/**
 * availability-windows-card.tsx — "Operating hours" card for the fleet detail
 * page (Slice AV1.3).
 *
 * Shows weekly availability windows on an aircraft resource. Windows are grouped
 * by day (Mon-Sun ISO order). Each window shows formatted times (HH:MM-HH:MM).
 *
 * States:
 *   loading    - Skeleton placeholder.
 *   empty      - "No operating hours set" notice + optional Add button.
 *   populated  - Day groups with windows + per-window remove control.
 *   error      - Non-fatal inline alert.
 *   permission-denied - Card absent (no canManageResources cap).
 *
 * Add dialog: day-of-week select + start/end time pickers + timezone.
 * Auto-splits overnight entries (e.g. 22:00-02:00) into two rows before
 * calling createAvailabilityWindowAction.
 *
 * [VERIFY-AV1-A]: availability windows = OPERATOR operating-hours data ONLY.
 * NOT an FAA duty-time, rest-period, Part-117/135/121, or flight-time-limit
 * determination. The disclaimer MUST be shown.
 *
 * BOUNDARY: imports ONLY from @aeroops/api. Never @aeroops/db.
 */
'use client';

import * as React from 'react';
import { Clock, Plus, X, Loader2, AlertCircle, XCircle, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
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
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  listAvailabilityWindowsAction,
  createAvailabilityWindowAction,
  deleteAvailabilityWindowAction,
} from '../availability-actions';
import type { SerializedAvailabilityWindowView } from '../availability-actions';
import {
  minutesToHHMM,
  hhmmToMinutes,
  splitOvernightWindow,
  groupWindowsByDay,
} from '../_utils/availability-display';

// ─── Props ─────────────────────────────────────────────────────────────────────

interface AvailabilityWindowsCardProps {
  resourceId: string;
  /**
   * Whether the session has schedule:manage_resources.
   * Controls visibility of Add / Remove controls.
   * The server action re-gates independently.
   */
  canManageResources: boolean;
}

// ─── Browser timezone helper ───────────────────────────────────────────────────

function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

// ─── Add window dialog ─────────────────────────────────────────────────────────

interface AddWindowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceId: string;
  onSuccess: (windows: SerializedAvailabilityWindowView[]) => void;
}

const DOW_OPTIONS = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 7, label: 'Sunday' },
];

function AddWindowDialog({ open, onOpenChange, resourceId, onSuccess }: AddWindowDialogProps) {
  const [dayOfWeek, setDayOfWeek] = React.useState<number>(1);
  const [startTime, setStartTime] = React.useState('07:00');
  const [endTime, setEndTime] = React.useState('21:00');
  const [tz, setTz] = React.useState(() => browserTz());
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<{
    startTime?: string;
    endTime?: string;
    tz?: string;
  }>({});

  // Reset when dialog opens.
  React.useEffect(() => {
    if (!open) return;
    setDayOfWeek(1);
    setStartTime('07:00');
    setEndTime('21:00');
    setTz(browserTz());
    setError(null);
    setFieldErrors({});
  }, [open]);

  // Derive whether the entry crosses midnight (overnight indicator).
  const startMinute = hhmmToMinutes(startTime);
  const endMinute = hhmmToMinutes(endTime);
  const isOvernight =
    startMinute !== null && endMinute !== null && endMinute <= startMinute && endMinute !== 0;
  // Special case: endTime = "24:00" (1440) is end-of-day, not overnight.
  const isEndOfDay = endMinute === 1440;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    // Client-side validation.
    const errors: typeof fieldErrors = {};
    if (startMinute === null) errors.startTime = 'Enter a valid start time (HH:MM).';
    if (endMinute === null) errors.endTime = 'Enter a valid end time (HH:MM).';
    if (!tz.trim()) errors.tz = 'Timezone is required.';
    if (startMinute !== null && endMinute !== null && startMinute === endMinute) {
      errors.endTime = 'End time must differ from start time.';
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    // Split overnight if needed.
    const windows = splitOvernightWindow(startMinute!, endMinute!, dayOfWeek, tz.trim());

    setSubmitting(true);
    try {
      let lastWindows: SerializedAvailabilityWindowView[] = [];
      for (const w of windows) {
        const result = await createAvailabilityWindowAction({
          resourceId,
          dayOfWeek: w.dayOfWeek,
          startMinute: w.startMinute,
          endMinute: w.endMinute,
          tz: w.tz,
        });
        if ('error' in result) {
          if (result.error === 'validation') {
            setError(result.message);
            return;
          }
          if (result.error === 'forbidden' || result.error === 'unauthenticated') {
            setError('You do not have permission to add operating hours.');
            return;
          }
          setError('Something went wrong. Please try again.');
          return;
        }
        if (!result.ok) {
          if (result.reason === 'duplicate') {
            setError('A window with the same day and times already exists.');
            return;
          }
          if (result.reason === 'not_found') {
            setError('Aircraft not found or inactive.');
            return;
          }
          setError('Something went wrong. Please try again.');
          return;
        }
        lastWindows = result.windows;
      }
      onSuccess(lastWindows);
      onOpenChange(false);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add operating hours window</DialogTitle>
        </DialogHeader>

        {/* [VERIFY-AV1-A] operator-data copy */}
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Set the hours this aircraft is available for scheduling on a given day.
          These are operator-defined operating hours — not a regulatory determination.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {/* Day of week */}
          <div className="space-y-1.5">
            <Label htmlFor="aw-dow">
              Day of week <span aria-hidden="true" className="text-red-500 dark:text-red-400">*</span>
            </Label>
            <select
              id="aw-dow"
              value={dayOfWeek}
              onChange={(e) => setDayOfWeek(Number(e.target.value))}
              disabled={submitting}
              className="flex h-10 w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 hover:border-slate-400 dark:hover:border-slate-500 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 disabled:opacity-50"
            >
              {DOW_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Start / end time */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="aw-start">
                Start time <span aria-hidden="true" className="text-red-500 dark:text-red-400">*</span>
              </Label>
              <input
                id="aw-start"
                type="time"
                step={300}
                value={startTime}
                onChange={(e) => {
                  setStartTime(e.target.value);
                  setFieldErrors((prev) => ({ ...prev, startTime: undefined }));
                }}
                disabled={submitting}
                aria-required="true"
                aria-invalid={fieldErrors.startTime ? 'true' : undefined}
                aria-describedby={fieldErrors.startTime ? 'aw-start-err' : undefined}
                className={[
                  'flex h-10 w-full rounded-md border bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30',
                  'disabled:opacity-50',
                  fieldErrors.startTime ? 'border-red-500' : 'border-slate-300 dark:border-slate-700',
                ].join(' ')}
              />
              {fieldErrors.startTime && (
                <p id="aw-start-err" role="alert" className="text-xs text-red-600 dark:text-red-400">
                  {fieldErrors.startTime}
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="aw-end">
                End time <span aria-hidden="true" className="text-red-500 dark:text-red-400">*</span>
              </Label>
              <input
                id="aw-end"
                type="time"
                step={300}
                value={endTime}
                onChange={(e) => {
                  setEndTime(e.target.value);
                  setFieldErrors((prev) => ({ ...prev, endTime: undefined }));
                }}
                disabled={submitting}
                aria-required="true"
                aria-invalid={fieldErrors.endTime ? 'true' : undefined}
                aria-describedby={fieldErrors.endTime ? 'aw-end-err' : 'aw-end-hint'}
                className={[
                  'flex h-10 w-full rounded-md border bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30',
                  'disabled:opacity-50',
                  fieldErrors.endTime ? 'border-red-500' : 'border-slate-300 dark:border-slate-700',
                ].join(' ')}
              />
              {fieldErrors.endTime ? (
                <p id="aw-end-err" role="alert" className="text-xs text-red-600 dark:text-red-400">
                  {fieldErrors.endTime}
                </p>
              ) : (isOvernight && !isEndOfDay) ? (
                <p id="aw-end-hint" className="text-xs text-amber-600 dark:text-amber-400">
                  Overnight: will create two windows (up to midnight + midnight to end).
                </p>
              ) : null}
            </div>
          </div>

          {/* Timezone */}
          <div className="space-y-1.5">
            <Label htmlFor="aw-tz">
              Timezone <span aria-hidden="true" className="text-red-500 dark:text-red-400">*</span>
            </Label>
            <input
              id="aw-tz"
              type="text"
              value={tz}
              onChange={(e) => {
                setTz(e.target.value);
                setFieldErrors((prev) => ({ ...prev, tz: undefined }));
              }}
              disabled={submitting}
              placeholder="e.g. America/New_York"
              maxLength={100}
              aria-required="true"
              aria-invalid={fieldErrors.tz ? 'true' : undefined}
              aria-describedby={fieldErrors.tz ? 'aw-tz-err' : 'aw-tz-hint'}
              className={[
                'flex h-10 w-full rounded-md border bg-white dark:bg-slate-900 px-3 py-2 text-sm font-mono text-slate-900 dark:text-slate-100',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30',
                'disabled:opacity-50',
                fieldErrors.tz ? 'border-red-500' : 'border-slate-300 dark:border-slate-700',
              ].join(' ')}
            />
            {fieldErrors.tz ? (
              <p id="aw-tz-err" role="alert" className="text-xs text-red-600 dark:text-red-400">
                {fieldErrors.tz}
              </p>
            ) : (
              <p id="aw-tz-hint" className="text-xs text-slate-500 dark:text-slate-400">
                IANA timezone (e.g. America/Chicago). Defaults to your browser timezone.
              </p>
            )}
          </div>

          {/* Server error */}
          {error && (
            <Alert variant="destructive" role="alert">
              <XCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" autoFocus disabled={submitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={submitting} isLoading={submitting}>
              Add window
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main card ─────────────────────────────────────────────────────────────────

export function AvailabilityWindowsCard({
  resourceId,
  canManageResources,
}: AvailabilityWindowsCardProps) {
  const [windows, setWindows] = React.useState<SerializedAvailabilityWindowView[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [addDialogOpen, setAddDialogOpen] = React.useState(false);
  const [removingId, setRemovingId] = React.useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = React.useState<{ id: string; label: string } | null>(null);
  const [removeError, setRemoveError] = React.useState<string | null>(null);

  // ── Load windows on mount ────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!canManageResources) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError(false);

    listAvailabilityWindowsAction({ resourceId })
      .then((result) => {
        if (cancelled) return;
        setLoading(false);
        if ('error' in result || !result.ok) {
          setLoadError(true);
          return;
        }
        setWindows(result.windows);
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
          setLoadError(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [resourceId, canManageResources]);

  // ── Remove handler ───────────────────────────────────────────────────────────
  async function handleRemove(windowId: string) {
    setRemovingId(windowId);
    setRemoveError(null);
    try {
      const result = await deleteAvailabilityWindowAction({ windowId });
      if ('error' in result) {
        setRemoveError('Could not remove window. Please try again.');
        return;
      }
      if (!result.ok) {
        setRemoveError(
          result.reason === 'not_found'
            ? 'Window not found (may have already been removed).'
            : 'Could not remove window.',
        );
        return;
      }
      setWindows(result.windows);
    } catch {
      setRemoveError('Could not remove window. Please try again.');
    } finally {
      setRemovingId(null);
    }
  }

  // Permission-denied: only users with schedule:manage_resources see this card.
  if (!canManageResources) {
    return null;
  }

  const grouped = windows ? groupWindowsByDay(windows) : [];

  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
      {/* ── Card header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-slate-400 dark:text-slate-500" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
            Operating hours
          </h2>
          {!loading && !loadError && windows !== null && windows.length > 0 && (
            <span className="inline-flex items-center rounded-sm border border-brand/30 bg-brand/8 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-brand-ink">
              {windows.length}
            </span>
          )}
        </div>
        {!loading && !loadError && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAddDialogOpen(true)}
            aria-label="Add operating hours window"
          >
            <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
            Add window
          </Button>
        )}
      </div>

      {/* [VERIFY-AV1-A] operator-data framing + mandatory disclaimer */}
      <p className="text-xs text-slate-400 dark:text-slate-500">
        Weekly windows during which this aircraft is available for scheduling.
        These are operator-defined operating hours only — NOT an FAA duty-time,
        rest-period, or Part-117/135/121 determination.
      </p>

      {/* ── Mandatory compliance disclaimer ──────────────────────────────── */}
      {/* [VERIFY-AV1-A]: Required by compliance. Do not remove or soften. */}
      <div className="flex items-start gap-1.5 rounded bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 px-2.5 py-2">
        <Info className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
        <p className="text-[0.6875rem] text-amber-800 dark:text-amber-200 leading-relaxed">
          Operating-hours availability is an operator scheduling rule — it is{' '}
          <strong>NOT</strong> an FAA flight/duty-time, rest, or §117 determination.
        </p>
      </div>

      {/* ── Loading ──────────────────────────────────────────────────────── */}
      {loading && (
        <div className="space-y-2 animate-pulse" aria-busy="true" aria-label="Loading operating hours">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-3/4" />
        </div>
      )}

      {/* ── Non-fatal load error ─────────────────────────────────────────── */}
      {!loading && loadError && (
        <Alert role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription className="text-sm">
            Could not load operating hours. Refresh to try again.
          </AlertDescription>
        </Alert>
      )}

      {/* ── Empty state ───────────────────────────────────────────────────── */}
      {!loading && !loadError && windows !== null && windows.length === 0 && (
        <p className="text-sm text-slate-400 dark:text-slate-500 italic">
          No operating hours set — available any time.
        </p>
      )}

      {/* ── Populated: day groups ─────────────────────────────────────────── */}
      {!loading && !loadError && windows !== null && windows.length > 0 && (
        <div className="space-y-3" role="list" aria-label="Operating hours by day">
          {grouped.map((group) => (
            <div key={group.dayOfWeek} role="listitem">
              <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1.5">
                {group.label}
              </p>
              <div className="space-y-1">
                {group.windows.map((w) => (
                  <div
                    key={w.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-3 py-1.5"
                  >
                    <span className="nums text-sm text-slate-700 dark:text-slate-300 font-medium">
                      {w.range}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className="text-[0.6875rem] text-slate-400 dark:text-slate-500 font-mono">{w.tz}</span>
                      <button
                        type="button"
                        onClick={() => setConfirmRemove({ id: w.id, label: `${group.label} ${w.range}` })}
                        disabled={removingId === w.id}
                        aria-label={`Remove window ${group.label} ${w.range}`}
                        className="rounded-sm text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500 disabled:opacity-50"
                      >
                        {removingId === w.id ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        ) : (
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Remove error ─────────────────────────────────────────────────── */}
      {removeError && (
        <Alert variant="destructive" role="alert">
          <XCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription className="text-sm">{removeError}</AlertDescription>
        </Alert>
      )}

      {/* ── Confirm remove dialog ─────────────────────────────────────────── */}
      <AlertDialog
        open={confirmRemove !== null}
        onOpenChange={(open) => { if (!open) setConfirmRemove(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this window?</AlertDialogTitle>
            <AlertDialogDescription>
              Remove{' '}
              <strong className="text-slate-800 dark:text-slate-100">{confirmRemove?.label}</strong>?
              {' '}This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus onClick={() => setConfirmRemove(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={async () => {
                if (confirmRemove) {
                  await handleRemove(confirmRemove.id);
                  setConfirmRemove(null);
                }
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Add window dialog ─────────────────────────────────────────────── */}
      <AddWindowDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        resourceId={resourceId}
        onSuccess={(updatedWindows) => setWindows(updatedWindows)}
      />
    </div>
  );
}
