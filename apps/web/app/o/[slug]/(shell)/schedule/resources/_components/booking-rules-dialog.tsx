/**
 * booking-rules-dialog.tsx — Per-resource booking policy editor.
 *
 * Spec §3.1 (slice-2a-booking-policies.md):
 *   Opened from a resource row via "Booking rules" button.
 *   Gated to schedule:manage_resources (the API enforces; this component
 *   is only rendered when the parent already confirmed the capability).
 *
 * On open: lazy-loads getBookingPolicyAction + listBlackoutsAction in parallel.
 *
 * Policy fields (4 rules — no required-tags, DEFERRED per scope amendment):
 *   - max duration (minutes, optional, >=1)
 *   - max advance (days, optional, >=0)
 *   - min lead time (minutes, optional, >=0)
 *   - blackout windows (datetime ranges + optional reason, add / remove)
 *
 * Primary action: Save booking rules  (upsertBookingPolicyAction)
 * Secondary action: Clear rules       (clearBookingPolicyAction, AlertDialog confirm)
 * Blackout add:     createBlackoutAction
 * Blackout remove:  deleteBlackoutAction  (AlertDialog confirm "Keep blackout" default)
 *
 * States: loading / empty / populated / load-error / save-error / saving /
 *          success / permission-denied (shown inline, not redirect, because this
 *          dialog is opened from an already-authenticated page).
 *
 * A11y: focus management mirrors add-resource-dialog.tsx; inline errors with
 *         aria-describedby; role="alert" on errors; aria-live on status banners.
 */
'use client';

import * as React from 'react';
import { Settings2, Loader2, Plus, Trash2, AlertCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  getBookingPolicyAction,
  listBlackoutsAction,
  upsertBookingPolicyAction,
  clearBookingPolicyAction,
  createBlackoutAction,
  deleteBlackoutAction,
} from '../../actions';
import type {
  BookingPolicyView,
  BlackoutView,
} from '@aeroops/api';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format a Date as a local datetime-local string (YYYY-MM-DDTHH:mm). */
function toDatetimeLocal(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

/** Format a Date as "Mon DD, YYYY HH:mm" for display. */
function formatDatetime(d: Date): string {
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/** Strip server-side prefix like "[booking_policy]" or "[resource_blackout]". */
function stripPrefix(msg: string): string {
  return msg.replace(/^\[[\w_:]+\]\s*/, '');
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface BookingRulesDialogProps {
  resourceId: string;
  displayName: string;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'error';
type SaveState = 'idle' | 'saving' | 'success' | 'error';

interface PolicyFields {
  maxDurationMinutes: string;
  maxAdvanceDays: string;
  minAdvanceMinutes: string;
}

interface FieldErrors {
  maxDurationMinutes?: string;
  maxAdvanceDays?: string;
  minAdvanceMinutes?: string;
}

interface NewBlackout {
  startAt: string;
  endAt: string;
  reason: string;
}

const EMPTY_POLICY: PolicyFields = {
  maxDurationMinutes: '',
  maxAdvanceDays: '',
  minAdvanceMinutes: '',
};

const EMPTY_NEW_BLACKOUT: NewBlackout = {
  startAt: '',
  endAt: '',
  reason: '',
};

// ─── Main component ───────────────────────────────────────────────────────────

export function BookingRulesDialog({ resourceId, displayName }: BookingRulesDialogProps) {
  const [open, setOpen] = React.useState(false);

  // ── Load state ────────────────────────────────────────────────────────────
  const [loadState, setLoadState] = React.useState<LoadState>('idle');
  const [existingPolicy, setExistingPolicy] = React.useState<BookingPolicyView | null>(null);
  const [blackouts, setBlackouts] = React.useState<BlackoutView[]>([]);

  // ── Policy field state ────────────────────────────────────────────────────
  const [policy, setPolicy] = React.useState<PolicyFields>(EMPTY_POLICY);
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});

  // ── Save state ────────────────────────────────────────────────────────────
  const [saveState, setSaveState] = React.useState<SaveState>('idle');
  const [saveError, setSaveError] = React.useState<string | null>(null);

  // ── New blackout form ─────────────────────────────────────────────────────
  const [newBlackout, setNewBlackout] = React.useState<NewBlackout>(EMPTY_NEW_BLACKOUT);
  const [newBlackoutError, setNewBlackoutError] = React.useState<string | null>(null);
  const [addingBlackout, setAddingBlackout] = React.useState(false);
  // aria-live status for blackout add/remove success (Finding 3)
  const [blackoutStatus, setBlackoutStatus] = React.useState<string>('');

  // ── Ref for aria focus on error ───────────────────────────────────────────
  const saveErrorRef = React.useRef<HTMLDivElement>(null);

  // ── Permission denied ─────────────────────────────────────────────────────
  const [permissionDenied, setPermissionDenied] = React.useState(false);

  // ─── Load data on open ──────────────────────────────────────────────────
  const loadData = React.useCallback(async () => {
    setLoadState('loading');
    setPermissionDenied(false);
    try {
      const [policyResult, blackoutsResult] = await Promise.all([
        getBookingPolicyAction({ resourceId }),
        listBlackoutsAction({ resourceId }),
      ]);

      if ('error' in policyResult) {
        if (policyResult.error === 'forbidden' || policyResult.error === 'unauthenticated') {
          setPermissionDenied(true);
          setLoadState('ready');
          return;
        }
        setLoadState('error');
        return;
      }

      if ('error' in blackoutsResult) {
        if (blackoutsResult.error === 'forbidden' || blackoutsResult.error === 'unauthenticated') {
          setPermissionDenied(true);
          setLoadState('ready');
          return;
        }
        setLoadState('error');
        return;
      }

      // Hydrate policy fields
      const p = policyResult.policy;
      setExistingPolicy(p);
      setPolicy({
        maxDurationMinutes: p?.maxDurationMinutes != null ? String(p.maxDurationMinutes) : '',
        maxAdvanceDays: p?.maxAdvanceDays != null ? String(p.maxAdvanceDays) : '',
        minAdvanceMinutes: p?.minAdvanceMinutes != null ? String(p.minAdvanceMinutes) : '',
      });

      setBlackouts(blackoutsResult.blackouts);
      setLoadState('ready');
    } catch {
      setLoadState('error');
    }
  }, [resourceId]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      // Reset transient state
      setFieldErrors({});
      setSaveState('idle');
      setSaveError(null);
      setNewBlackout(EMPTY_NEW_BLACKOUT);
      setNewBlackoutError(null);
      setBlackoutStatus('');
      setPermissionDenied(false);
      void loadData();
    }
  };

  // ─── Policy validation ───────────────────────────────────────────────────
  function validatePolicy(): boolean {
    const errors: FieldErrors = {};

    if (policy.maxDurationMinutes !== '') {
      const v = Number(policy.maxDurationMinutes);
      if (!Number.isInteger(v) || v < 1) {
        errors.maxDurationMinutes = 'Maximum duration must be a whole number of minutes, at least 1.';
      }
    }
    if (policy.maxAdvanceDays !== '') {
      const v = Number(policy.maxAdvanceDays);
      if (!Number.isInteger(v) || v < 0) {
        errors.maxAdvanceDays = 'Maximum advance must be a whole number of days, 0 or more.';
      }
    }
    if (policy.minAdvanceMinutes !== '') {
      const v = Number(policy.minAdvanceMinutes);
      if (!Number.isInteger(v) || v < 0) {
        errors.minAdvanceMinutes = 'Minimum lead time must be a whole number of minutes, 0 or more.';
      }
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  // ─── Save booking rules ──────────────────────────────────────────────────
  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaveError(null);

    if (!validatePolicy()) return;

    setSaveState('saving');

    try {
      const input: {
        resourceId: string;
        maxDurationMinutes?: number | null;
        maxAdvanceDays?: number | null;
        minAdvanceMinutes?: number | null;
      } = { resourceId };

      input.maxDurationMinutes =
        policy.maxDurationMinutes !== '' ? Number(policy.maxDurationMinutes) : null;
      input.maxAdvanceDays =
        policy.maxAdvanceDays !== '' ? Number(policy.maxAdvanceDays) : null;
      input.minAdvanceMinutes =
        policy.minAdvanceMinutes !== '' ? Number(policy.minAdvanceMinutes) : null;

      const result = await upsertBookingPolicyAction(input);

      if ('error' in result) {
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setPermissionDenied(true);
          setSaveState('idle');
          return;
        }
        if (result.error === 'validation') {
          setSaveError(stripPrefix(result.message));
          setSaveState('error');
          setTimeout(() => saveErrorRef.current?.focus(), 0);
          return;
        }
        setSaveError('Something went wrong. Please try again.');
        setSaveState('error');
        setTimeout(() => saveErrorRef.current?.focus(), 0);
        return;
      }

      if (!result.ok) {
        // reason: 'not_found'
        setSaveError('Resource not found. It may have been removed.');
        setSaveState('error');
        setTimeout(() => saveErrorRef.current?.focus(), 0);
        return;
      }

      setExistingPolicy(result.policy);
      setSaveState('success');
    } catch {
      setSaveError('Something went wrong. Please try again.');
      setSaveState('error');
      setTimeout(() => saveErrorRef.current?.focus(), 0);
    }
  }

  // ─── Clear rules ─────────────────────────────────────────────────────────
  async function handleClear() {
    setSaveError(null);
    setSaveState('saving');

    try {
      const result = await clearBookingPolicyAction({ resourceId });

      if ('error' in result) {
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setPermissionDenied(true);
          setSaveState('idle');
          return;
        }
        setSaveError('Something went wrong. Please try again.');
        setSaveState('error');
        setTimeout(() => saveErrorRef.current?.focus(), 0);
        return;
      }

      if (!result.ok) {
        // not_found — policy already gone; treat as success
      }

      // Reset to empty policy
      setExistingPolicy(null);
      setPolicy(EMPTY_POLICY);
      setFieldErrors({});
      setSaveState('success');
    } catch {
      setSaveError('Something went wrong. Please try again.');
      setSaveState('error');
      setTimeout(() => saveErrorRef.current?.focus(), 0);
    }
  }

  // ─── Add blackout ─────────────────────────────────────────────────────────
  async function handleAddBlackout(e: React.FormEvent) {
    e.preventDefault();
    setNewBlackoutError(null);
    // Clear any stale save-area error so a later success does not leave a
    // misleading banner (Finding 4).
    setSaveError(null);
    if (saveState === 'error') setSaveState('idle');
    setBlackoutStatus('');

    if (!newBlackout.startAt || !newBlackout.endAt) {
      setNewBlackoutError('Start and end date/time are required.');
      return;
    }

    const startDate = new Date(newBlackout.startAt);
    const endDate = new Date(newBlackout.endAt);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      setNewBlackoutError('Invalid date/time. Please check the values.');
      return;
    }

    if (endDate <= startDate) {
      setNewBlackoutError('End must be after start.');
      return;
    }

    setAddingBlackout(true);
    try {
      const result = await createBlackoutAction({
        resourceId,
        startAt: startDate,
        endAt: endDate,
        reason: newBlackout.reason.trim() || undefined,
      });

      if ('error' in result) {
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setPermissionDenied(true);
          return;
        }
        if (result.error === 'validation') {
          setNewBlackoutError(stripPrefix(result.message));
          return;
        }
        setNewBlackoutError('Something went wrong. Please try again.');
        return;
      }

      if (!result.ok) {
        setNewBlackoutError('Resource not found. It may have been removed.');
        return;
      }

      setBlackouts((prev) => [...prev, result.blackout]);
      setNewBlackout(EMPTY_NEW_BLACKOUT);
      // Announce success to screen readers (Finding 3).
      setBlackoutStatus('Blackout added.');
    } catch {
      setNewBlackoutError('Something went wrong. Please try again.');
    } finally {
      setAddingBlackout(false);
    }
  }

  // ─── Delete blackout ──────────────────────────────────────────────────────
  async function handleDeleteBlackout(blackoutId: string) {
    // Clear any stale save-area error so a later success does not leave a
    // misleading banner (Finding 4).
    setSaveError(null);
    if (saveState === 'error') setSaveState('idle');
    setBlackoutStatus('');

    try {
      const result = await deleteBlackoutAction({ blackoutId });

      if ('error' in result) {
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setPermissionDenied(true);
          return;
        }
        // Surface error in save area for visibility
        setSaveError('Could not remove blackout. Please try again.');
        setSaveState('error');
        return;
      }

      if (!result.ok) {
        // not_found — already gone; remove locally
      }

      setBlackouts((prev) => prev.filter((b) => b.id !== blackoutId));
      // Announce success to screen readers (Finding 3).
      setBlackoutStatus('Blackout removed.');
    } catch {
      setSaveError('Could not remove blackout. Please try again.');
      setSaveState('error');
    }
  }

  // ─── Derived state ────────────────────────────────────────────────────────
  const hasAnyPolicy =
    existingPolicy !== null ||
    policy.maxDurationMinutes !== '' ||
    policy.maxAdvanceDays !== '' ||
    policy.minAdvanceMinutes !== '';

  const saving = saveState === 'saving';

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Booking rules for ${displayName}`}
        >
          <Settings2 className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
          Booking rules
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Booking rules — {displayName}</DialogTitle>
          <DialogDescription>
            Set optional restrictions on how this resource can be booked. Leave
            all fields blank for open booking (no restrictions).
          </DialogDescription>
        </DialogHeader>

        {/* Permission denied */}
        {permissionDenied && (
          <Alert variant="destructive" role="alert">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>
              You do not have permission to manage booking rules.
            </AlertDescription>
          </Alert>
        )}

        {/* Loading state */}
        {!permissionDenied && loadState === 'loading' && (
          <div className="space-y-4 py-2" aria-label="Loading booking rules" aria-busy="true">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-5 w-32 mt-4" />
            <Skeleton className="h-14 w-full" />
          </div>
        )}

        {/* Load error */}
        {!permissionDenied && loadState === 'error' && (
          <Alert variant="destructive" role="alert">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>
              Could not load booking rules. Try closing and reopening this dialog.
            </AlertDescription>
          </Alert>
        )}

        {/* Ready state — main form */}
        {!permissionDenied && loadState === 'ready' && (
          <form id="booking-rules-form" onSubmit={handleSave} noValidate>
            <div className="space-y-6">

              {/* Empty state notice */}
              {!hasAnyPolicy && blackouts.length === 0 && saveState !== 'success' && (
                <p
                  className="text-sm text-slate-500 bg-slate-50 border border-slate-200 rounded-md px-3 py-3"
                  role="status"
                  aria-live="polite"
                >
                  No booking rules — open for any available time.
                </p>
              )}

              {/* Success banner */}
              {saveState === 'success' && (
                <Alert
                  className="border-green-200 bg-green-50 text-green-800"
                  role="status"
                  aria-live="polite"
                >
                  <AlertDescription>Booking rules saved.</AlertDescription>
                </Alert>
              )}

              {/* Save error */}
              {saveState === 'error' && saveError && (
                <Alert
                  ref={saveErrorRef}
                  variant="destructive"
                  role="alert"
                  tabIndex={-1}
                >
                  <AlertCircle className="h-4 w-4" aria-hidden="true" />
                  <AlertDescription>{saveError}</AlertDescription>
                </Alert>
              )}

              {/* ── Policy fields ────────────────────────────────────────── */}
              <fieldset className="space-y-4">
                <legend className="text-sm font-semibold text-slate-700">
                  Booking restrictions
                </legend>

                {/* Max duration */}
                <div className="space-y-1">
                  <Label htmlFor="maxDurationMinutes">
                    Maximum booking length (minutes, optional)
                  </Label>
                  <Input
                    id="maxDurationMinutes"
                    type="number"
                    min={1}
                    step={1}
                    value={policy.maxDurationMinutes}
                    onChange={(e) => {
                      setPolicy((prev) => ({ ...prev, maxDurationMinutes: e.target.value }));
                      setFieldErrors((prev) => ({ ...prev, maxDurationMinutes: undefined }));
                      if (saveState === 'success') setSaveState('idle');
                    }}
                    placeholder="e.g. 120"
                    aria-describedby={
                      fieldErrors.maxDurationMinutes ? 'maxDuration-error' : undefined
                    }
                    className={fieldErrors.maxDurationMinutes ? 'border-red-500' : ''}
                  />
                  <p className="text-xs text-slate-400">
                    Leave blank for no maximum. Must be at least 1 minute.
                  </p>
                  {fieldErrors.maxDurationMinutes && (
                    <p id="maxDuration-error" role="alert" className="text-sm text-red-600">
                      {fieldErrors.maxDurationMinutes}
                    </p>
                  )}
                </div>

                {/* Max advance */}
                <div className="space-y-1">
                  <Label htmlFor="maxAdvanceDays">
                    Maximum advance booking (days, optional)
                  </Label>
                  <Input
                    id="maxAdvanceDays"
                    type="number"
                    min={0}
                    step={1}
                    value={policy.maxAdvanceDays}
                    onChange={(e) => {
                      setPolicy((prev) => ({ ...prev, maxAdvanceDays: e.target.value }));
                      setFieldErrors((prev) => ({ ...prev, maxAdvanceDays: undefined }));
                      if (saveState === 'success') setSaveState('idle');
                    }}
                    placeholder="e.g. 30"
                    aria-describedby={
                      fieldErrors.maxAdvanceDays ? 'maxAdvance-error' : undefined
                    }
                    className={fieldErrors.maxAdvanceDays ? 'border-red-500' : ''}
                  />
                  <p className="text-xs text-slate-400">
                    Leave blank for no advance limit. 0 = same-day only.
                  </p>
                  {fieldErrors.maxAdvanceDays && (
                    <p id="maxAdvance-error" role="alert" className="text-sm text-red-600">
                      {fieldErrors.maxAdvanceDays}
                    </p>
                  )}
                </div>

                {/* Min lead time */}
                <div className="space-y-1">
                  <Label htmlFor="minAdvanceMinutes">
                    Minimum lead time (minutes, optional)
                  </Label>
                  <Input
                    id="minAdvanceMinutes"
                    type="number"
                    min={0}
                    step={1}
                    value={policy.minAdvanceMinutes}
                    onChange={(e) => {
                      setPolicy((prev) => ({ ...prev, minAdvanceMinutes: e.target.value }));
                      setFieldErrors((prev) => ({ ...prev, minAdvanceMinutes: undefined }));
                      if (saveState === 'success') setSaveState('idle');
                    }}
                    placeholder="e.g. 60"
                    aria-describedby={
                      fieldErrors.minAdvanceMinutes ? 'minLead-error' : undefined
                    }
                    className={fieldErrors.minAdvanceMinutes ? 'border-red-500' : ''}
                  />
                  <p className="text-xs text-slate-400">
                    Leave blank for no lead time requirement. 0 = last-minute bookings allowed.
                  </p>
                  {fieldErrors.minAdvanceMinutes && (
                    <p id="minLead-error" role="alert" className="text-sm text-red-600">
                      {fieldErrors.minAdvanceMinutes}
                    </p>
                  )}
                </div>
              </fieldset>

              {/* ── Blackout windows ──────────────────────────────────────── */}
              <section aria-labelledby="blackouts-heading" className="space-y-3">
                <h3
                  id="blackouts-heading"
                  className="text-sm font-semibold text-slate-700"
                >
                  Blackout windows
                  <span className="ml-1 text-xs font-normal text-slate-400">
                    (times when this resource cannot be booked)
                  </span>
                </h3>

                {/* Screen-reader announcement for blackout add/remove success (Finding 3). */}
                <div
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                  className="sr-only"
                >
                  {blackoutStatus}
                </div>

                {/* Existing blackouts */}
                {blackouts.length === 0 ? (
                  <p className="text-xs text-slate-400">No blackouts configured.</p>
                ) : (
                  <ul className="space-y-2" aria-label="Existing blackout windows">
                    {blackouts.map((b) => (
                      <BlackoutRow
                        key={b.id}
                        blackout={b}
                        onDelete={() => handleDeleteBlackout(b.id)}
                      />
                    ))}
                  </ul>
                )}

                {/* Add blackout form */}
                <AddBlackoutForm
                  value={newBlackout}
                  onChange={setNewBlackout}
                  onSubmit={handleAddBlackout}
                  error={newBlackoutError}
                  submitting={addingBlackout}
                />
              </section>
            </div>
          </form>
        )}

        {/* Footer actions */}
        {!permissionDenied && loadState === 'ready' && (
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between sm:items-center pt-2">
            {/* Clear rules — destructive, left-aligned */}
            <ClearRulesButton
              hasPolicy={hasAnyPolicy || blackouts.length > 0}
              saving={saving}
              onClear={handleClear}
            />

            {/* Save / Cancel */}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                disabled={saving}
              >
                Close
              </Button>
              <Button
                type="submit"
                form="booking-rules-form"
                disabled={saving}
              >
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    Saving…
                  </>
                ) : (
                  'Save booking rules'
                )}
              </Button>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── BlackoutRow ──────────────────────────────────────────────────────────────

interface BlackoutRowProps {
  blackout: BlackoutView;
  onDelete: () => void;
}

function BlackoutRow({ blackout, onDelete }: BlackoutRowProps) {
  const [pending, setPending] = React.useState(false);

  const handleConfirmedDelete = async () => {
    setPending(true);
    try {
      await onDelete();
    } finally {
      setPending(false);
    }
  };

  return (
    <li className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
      <div className="flex-1 min-w-0">
        <span className="text-slate-700 font-mono text-xs">
          {formatDatetime(blackout.startAt)} – {formatDatetime(blackout.endAt)}
        </span>
        {blackout.reason && (
          <p className="text-xs text-slate-500 mt-0.5 truncate" title={blackout.reason}>
            {blackout.reason}
          </p>
        )}
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 shrink-0 text-slate-400 hover:text-red-600"
            aria-label={`Remove blackout ${formatDatetime(blackout.startAt)} – ${formatDatetime(blackout.endAt)}`}
            disabled={pending}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this blackout?</AlertDialogTitle>
            <AlertDialogDescription>
              This will allow bookings during{' '}
              {formatDatetime(blackout.startAt)} – {formatDatetime(blackout.endAt)}.
              {blackout.reason && ` Reason: ${blackout.reason}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus>Keep blackout</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleConfirmedDelete();
              }}
              disabled={pending}
            >
              {pending ? 'Removing…' : 'Remove blackout'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

// ─── AddBlackoutForm ──────────────────────────────────────────────────────────

interface AddBlackoutFormProps {
  value: NewBlackout;
  onChange: React.Dispatch<React.SetStateAction<NewBlackout>>;
  onSubmit: (e: React.FormEvent) => void;
  error: string | null;
  submitting: boolean;
}

function AddBlackoutForm({ value, onChange, onSubmit, error, submitting }: AddBlackoutFormProps) {
  return (
    <div className="rounded-md border border-dashed border-slate-300 p-3 space-y-3 bg-white">
      <p className="text-xs font-medium text-slate-600">Add blackout window</p>
      <form onSubmit={onSubmit} noValidate className="space-y-3">
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* Start */}
          <div className="space-y-1">
            <Label htmlFor="blackout-start" className="text-xs">
              Start <span aria-hidden="true">*</span>
            </Label>
            <Input
              id="blackout-start"
              type="datetime-local"
              value={value.startAt}
              onChange={(e) => {
                onChange((prev) => ({ ...prev, startAt: e.target.value }));
              }}
              required
              aria-required="true"
              className="text-sm h-9"
            />
          </div>

          {/* End */}
          <div className="space-y-1">
            <Label htmlFor="blackout-end" className="text-xs">
              End <span aria-hidden="true">*</span>
            </Label>
            <Input
              id="blackout-end"
              type="datetime-local"
              value={value.endAt}
              onChange={(e) => {
                onChange((prev) => ({ ...prev, endAt: e.target.value }));
              }}
              required
              aria-required="true"
              className="text-sm h-9"
            />
          </div>
        </div>

        {/* Reason */}
        <div className="space-y-1">
          <Label htmlFor="blackout-reason" className="text-xs">
            Reason (optional)
          </Label>
          <Input
            id="blackout-reason"
            type="text"
            value={value.reason}
            onChange={(e) => {
              onChange((prev) => ({ ...prev, reason: e.target.value }));
            }}
            placeholder="e.g. Maintenance"
            maxLength={500}
            className="text-sm h-9"
          />
        </div>

        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={submitting}
          className="w-full sm:w-auto"
        >
          {submitting ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Adding…
            </>
          ) : (
            <>
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
              Add blackout
            </>
          )}
        </Button>
      </form>
    </div>
  );
}

// ─── ClearRulesButton ─────────────────────────────────────────────────────────

interface ClearRulesButtonProps {
  hasPolicy: boolean;
  saving: boolean;
  onClear: () => void;
}

function ClearRulesButton({ hasPolicy, saving, onClear }: ClearRulesButtonProps) {
  if (!hasPolicy) return null;

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700"
          disabled={saving}
        >
          Clear rules
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear all booking rules?</AlertDialogTitle>
          <AlertDialogDescription>
            This will remove all booking restrictions for this resource. The
            resource will revert to open booking — any available time can be
            booked. Blackout windows are not affected by clearing the policy
            rules.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus>Keep rules</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              onClear();
            }}
          >
            Clear rules
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
