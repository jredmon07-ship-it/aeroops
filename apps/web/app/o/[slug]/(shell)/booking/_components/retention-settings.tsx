/**
 * retention-settings.tsx — Booking-request retention/purge settings card (Slice PB-LR.A).
 *
 * Rendered ONLY when the session holds org:manage_settings (gated at the page level via
 * canManageSettings prop). The API enforces the cap on every action call — this prop is
 * cosmetic, NOT the real gate.
 *
 * States:
 *   loading        — skeleton card while fetching the current config.
 *   populated      — summary + Edit + Purge now affordances.
 *   disabled       — retentionDays === 0 ("keep forever" / warning tone).
 *   edit           — inline form (days input + includesConverted toggle).
 *   error          — specific copy per failure type.
 *   permission-denied — card not rendered (gated by parent).
 *
 * Destructive actions (Purge now + Save when reducing the window):
 *   "Purge now" → dry-run count dialog → confirm (dryRun:false).
 *   Confirm dialog shows the eligible count before deleting.
 *
 * BOUNDARY: imports ONLY from '@aeroops/api' (types) + local server actions.
 * Never '@aeroops/db'. Server actions enforce org:manage_settings.
 *
 * [VERIFY-PB1-COMP-1]: purge is hard-DELETE (not anonymize); compliance to confirm.
 */
'use client';

import * as React from 'react';
import { AlertCircle, Clock, Edit2, Trash2, X, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  getBookingRetentionAction,
  setBookingRetentionAction,
  purgeBookingRequestsAction,
} from '../actions';
import { formatRetentionSummary } from './retention-utils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface RetentionConfig {
  retentionDays: number;
  includesConverted: boolean;
}

type CardState =
  | { phase: 'loading' }
  | { phase: 'populated'; config: RetentionConfig }
  | { phase: 'edit'; config: RetentionConfig }
  | { phase: 'error'; message: string };

// ─── Purge dialog state ────────────────────────────────────────────────────────

type PurgeDialogPhase =
  | { step: 'closed' }
  | { step: 'confirming_dry_run' }
  | { step: 'dry_run_complete'; eligibleCount: number; retentionDisabled: boolean }
  | { step: 'applying' }
  | { step: 'applied'; deletedCount: number }
  | { step: 'error'; message: string };

// ─── RetentionSettingsCard ─────────────────────────────────────────────────────

interface RetentionSettingsCardProps {
  /**
   * Cosmetic gate — true when the session holds org:manage_settings.
   * The API enforces the cap; this prop controls whether this component renders.
   * The PARENT is responsible for not rendering this component when false.
   */
  canManageSettings: boolean;
  /** Org slug for revalidatePath (passed through to server actions). */
  slug: string;
}

export function RetentionSettingsCard({ canManageSettings, slug }: RetentionSettingsCardProps) {
  // Permission-denied: card simply not rendered (spec: "card simply not rendered for
  // roles without org:manage_settings"). Parent is the gate; this is a safety rail.
  if (!canManageSettings) return null;

  return <RetentionSettingsCardInner slug={slug} />;
}

// ─── Inner (always mounted with manage_settings, separated to avoid hook violations) ──

function RetentionSettingsCardInner({ slug }: { slug: string }) {
  const [cardState, setCardState] = React.useState<CardState>({ phase: 'loading' });

  // Edit-form local state
  const [editDays, setEditDays] = React.useState('');
  const [editIncludesConverted, setEditIncludesConverted] = React.useState(false);
  const [editError, setEditError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  // Purge dialog state
  const [purgeDialog, setPurgeDialog] = React.useState<PurgeDialogPhase>({ step: 'closed' });

  // ── Fetch on mount ─────────────────────────────────────────────────────────

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      setCardState({ phase: 'loading' });
      const result = await getBookingRetentionAction();
      if (cancelled) return;
      if ('error' in result) {
        const msg =
          result.error === 'forbidden' || result.error === 'unauthenticated'
            ? 'You do not have permission to view retention settings.'
            : "Couldn't load retention settings. Please refresh.";
        setCardState({ phase: 'error', message: msg });
        return;
      }
      setCardState({
        phase: 'populated',
        config: { retentionDays: result.retentionDays, includesConverted: result.includesConverted },
      });
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  // ── Enter edit mode ────────────────────────────────────────────────────────

  function handleEditOpen(config: RetentionConfig) {
    setEditDays(String(config.retentionDays));
    setEditIncludesConverted(config.includesConverted);
    setEditError(null);
    setCardState({ phase: 'edit', config });
  }

  function handleEditCancel(config: RetentionConfig) {
    setEditError(null);
    setCardState({ phase: 'populated', config });
  }

  // ── Save settings ──────────────────────────────────────────────────────────

  async function handleSave(_prevConfig: RetentionConfig) {
    setEditError(null);

    // Inline validation: 0–3650
    const parsed = parseInt(editDays, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3650) {
      setEditError('Enter a number from 0 to 3650.');
      return;
    }

    setSaving(true);
    try {
      const result = await setBookingRetentionAction(
        { retentionDays: parsed, includesConverted: editIncludesConverted },
        slug,
      );
      if ('error' in result) {
        if (result.error === 'validation') {
          setEditError((result as { error: 'validation'; message: string }).message);
        } else if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setEditError('You do not have permission to change retention settings.');
        } else {
          setEditError("Couldn't save retention settings. Please try again.");
        }
        setSaving(false);
        return;
      }
      // Success
      setEditError(null);
      setSaving(false);
      setCardState({
        phase: 'populated',
        config: { retentionDays: result.retentionDays, includesConverted: result.includesConverted },
      });
    } catch {
      setEditError("Couldn't save retention settings. Please try again.");
      setSaving(false);
    }
  }

  // ── Purge flow ─────────────────────────────────────────────────────────────

  async function handlePurgeOpen() {
    setPurgeDialog({ step: 'confirming_dry_run' });
    try {
      const result = await purgeBookingRequestsAction({ dryRun: true }, slug);
      if ('error' in result) {
        const msg =
          result.error === 'forbidden' || result.error === 'unauthenticated'
            ? 'You do not have permission to purge booking requests.'
            : 'Purge failed — could not determine eligible count.';
        setPurgeDialog({ step: 'error', message: msg });
        return;
      }
      setPurgeDialog({
        step: 'dry_run_complete',
        eligibleCount: result.eligibleCount,
        retentionDisabled: result.retentionDisabled,
      });
    } catch {
      setPurgeDialog({ step: 'error', message: 'Purge failed — could not determine eligible count.' });
    }
  }

  async function handlePurgeConfirm() {
    setPurgeDialog({ step: 'applying' });
    try {
      const result = await purgeBookingRequestsAction({ dryRun: false }, slug);
      if ('error' in result) {
        const msg =
          result.error === 'forbidden' || result.error === 'unauthenticated'
            ? 'You do not have permission to purge booking requests.'
            : 'Purge failed — no requests were deleted.';
        setPurgeDialog({ step: 'error', message: msg });
        return;
      }
      setPurgeDialog({ step: 'applied', deletedCount: result.deletedCount });
    } catch {
      setPurgeDialog({ step: 'error', message: 'Purge failed — no requests were deleted.' });
    }
  }

  function handlePurgeClose() {
    setPurgeDialog({ step: 'closed' });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────────

  const purgeOpen = purgeDialog.step !== 'closed';

  return (
    <div
      className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-5 py-4 space-y-3"
      aria-label="Booking request retention settings"
    >
      {/* ── Card header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <Clock className="h-4 w-4 text-slate-400 dark:text-slate-500 shrink-0" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Booking request retention</h2>
      </div>

      {/* ── Loading skeleton ─────────────────────────────────────────────────── */}
      {cardState.phase === 'loading' && (
        <div className="space-y-2 animate-pulse" aria-busy="true" aria-label="Loading retention settings">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <div className="flex gap-2 pt-1">
            <Skeleton className="h-7 w-14 rounded-md" />
            <Skeleton className="h-7 w-24 rounded-md" />
          </div>
        </div>
      )}

      {/* ── Error state ──────────────────────────────────────────────────────── */}
      {cardState.phase === 'error' && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>{cardState.message}</AlertDescription>
        </Alert>
      )}

      {/* ── Populated (summary) ──────────────────────────────────────────────── */}
      {cardState.phase === 'populated' && (
        <PopulatedView
          config={cardState.config}
          onEdit={() => handleEditOpen(cardState.config)}
          onPurge={handlePurgeOpen}
        />
      )}

      {/* ── Edit form ────────────────────────────────────────────────────────── */}
      {cardState.phase === 'edit' && (
        <EditView
          days={editDays}
          includesConverted={editIncludesConverted}
          error={editError}
          saving={saving}
          onDaysChange={setEditDays}
          onIncludesConvertedChange={setEditIncludesConverted}
          onSave={() => { void handleSave(cardState.config); }}
          onCancel={() => handleEditCancel(cardState.config)}
        />
      )}

      {/* ── Purge dialog ─────────────────────────────────────────────────────── */}
      <PurgeDialog
        open={purgeOpen}
        phase={purgeDialog}
        config={
          cardState.phase === 'populated' || cardState.phase === 'edit'
            ? cardState.config
            : null
        }
        onConfirm={() => { void handlePurgeConfirm(); }}
        onClose={handlePurgeClose}
      />
    </div>
  );
}

// ─── PopulatedView ────────────────────────────────────────────────────────────

function PopulatedView({
  config,
  onEdit,
  onPurge,
}: {
  config: RetentionConfig;
  onEdit: () => void;
  onPurge: () => void;
}) {
  const isDisabled = config.retentionDays === 0;

  return (
    <div className="space-y-2">
      {/* Disabled (days=0) warning */}
      {isDisabled && (
        <p className="text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 rounded-md px-3 py-2">
          Retention is OFF — booking requests are kept indefinitely. Set a retention window to enable automatic cleanup.
        </p>
      )}

      {/* Normal summary */}
      {!isDisabled && (
        <p className="text-sm text-slate-700 dark:text-slate-300">
          {formatRetentionSummary(config.retentionDays)}
        </p>
      )}

      {/* Includes-converted indicator (when enabled) */}
      {!isDisabled && (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {config.includesConverted
            ? 'Converted requests are included in the purge window.'
            : 'Converted requests are excluded from the purge window.'}
        </p>
      )}

      {/* Actions row */}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={onEdit}
        >
          <Edit2 className="h-3 w-3 mr-1" aria-hidden="true" />
          Edit
        </Button>
        {!isDisabled && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-danger hover:text-danger hover:bg-danger/10"
            onClick={onPurge}
          >
            <Trash2 className="h-3 w-3 mr-1" aria-hidden="true" />
            Purge now
          </Button>
        )}
      </div>
    </div>
  );
}

// ─── EditView ─────────────────────────────────────────────────────────────────

interface EditViewProps {
  days: string;
  includesConverted: boolean;
  error: string | null;
  saving: boolean;
  onDaysChange: (v: string) => void;
  onIncludesConvertedChange: (v: boolean) => void;
  onSave: () => void;
  onCancel: () => void;
}

function EditView({
  days,
  includesConverted,
  error,
  saving,
  onDaysChange,
  onIncludesConvertedChange,
  onSave,
  onCancel,
}: EditViewProps) {
  // Preview the summary live as the user types
  const parsedDays = parseInt(days, 10);
  const previewValid = Number.isInteger(parsedDays) && parsedDays >= 0 && parsedDays <= 3650;

  return (
    <div className="space-y-3">
      {/* Days input */}
      <div className="space-y-1">
        <Label htmlFor="retention-days" className="text-sm font-medium text-slate-700 dark:text-slate-300">
          Retention window (days)
          <span className="ml-1 text-slate-400 dark:text-slate-500 font-normal">(0 = keep forever)</span>
        </Label>
        <Input
          id="retention-days"
          type="number"
          min={0}
          max={3650}
          step={1}
          value={days}
          onChange={(e) => onDaysChange(e.target.value)}
          disabled={saving}
          className="w-32 nums"
          aria-describedby={error ? 'retention-days-error' : undefined}
          aria-invalid={!!error}
        />
        {/* Live preview */}
        {previewValid && !error && (
          <p className="text-xs text-slate-500 dark:text-slate-400" aria-live="polite">
            {parsedDays === 0
              ? 'Retention will be OFF — requests are kept indefinitely.'
              : formatRetentionSummary(parsedDays)}
          </p>
        )}
        {/* Inline validation error — preserved when invalid */}
        {error && (
          <p
            id="retention-days-error"
            role="alert"
            className="text-xs text-danger"
          >
            {error}
          </p>
        )}
      </div>

      {/* Include converted toggle */}
      <div className="flex items-center gap-2">
        <input
          id="retention-include-converted"
          type="checkbox"
          checked={includesConverted}
          onChange={(e) => onIncludesConvertedChange(e.target.checked)}
          disabled={saving}
          className="h-4 w-4 rounded border-slate-300 dark:border-slate-700 text-brand focus:ring-brand/40"
        />
        <Label
          htmlFor="retention-include-converted"
          className="text-sm text-slate-700 dark:text-slate-300 font-normal cursor-pointer"
        >
          Include converted requests in the purge window
        </Label>
      </div>

      {/* Save / Cancel */}
      <div className="flex gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          onClick={onSave}
          disabled={saving}
          aria-busy={saving}
          className="h-7 text-xs"
        >
          {saving ? (
            'Saving…'
          ) : (
            <>
              <Check className="h-3 w-3 mr-1" aria-hidden="true" />
              Save
            </>
          )}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onCancel}
          disabled={saving}
          className="h-7 text-xs"
        >
          <X className="h-3 w-3 mr-1" aria-hidden="true" />
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ─── PurgeDialog ──────────────────────────────────────────────────────────────

interface PurgeDialogProps {
  open: boolean;
  phase: PurgeDialogPhase;
  /** Current config for context copy (days). Null during loading/error states. */
  config: RetentionConfig | null;
  onConfirm: () => void;
  onClose: () => void;
}

function PurgeDialog({ open, phase, config, onConfirm, onClose }: PurgeDialogProps) {
  const isApplying = phase.step === 'applying';
  const isDryRunLoading = phase.step === 'confirming_dry_run';
  const busy = isApplying || isDryRunLoading;

  function dialogTitle() {
    if (phase.step === 'applied') return 'Purge complete';
    if (phase.step === 'error') return 'Purge failed';
    return 'Purge old booking requests';
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent aria-describedby="purge-dialog-desc">
        <DialogHeader>
          <DialogTitle>{dialogTitle()}</DialogTitle>
          <DialogDescription id="purge-dialog-desc" asChild>
            <div>
              {/* Confirming — fetching dry-run count */}
              {isDryRunLoading && (
                <span className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                  <span className="animate-spin h-4 w-4 border-2 border-slate-300 dark:border-slate-700 border-t-slate-600 rounded-full inline-block" aria-hidden="true" />
                  Checking eligible requests…
                </span>
              )}

              {/* Dry-run complete — show count before confirm */}
              {phase.step === 'dry_run_complete' && (
                <div className="space-y-2">
                  {phase.retentionDisabled ? (
                    <p className="text-sm text-slate-600 dark:text-slate-300">
                      Retention is set to 0 (keep forever) — no requests will be deleted.
                    </p>
                  ) : (
                    <>
                      <p className="text-sm text-slate-900 dark:text-slate-100">
                        This will permanently delete{' '}
                        <strong className="nums">{phase.eligibleCount}</strong>{' '}
                        {phase.eligibleCount === 1 ? 'request' : 'requests'} older than{' '}
                        <strong className="nums">{config?.retentionDays ?? '?'}</strong>{' '}
                        {(config?.retentionDays ?? 0) === 1 ? 'day' : 'days'}.
                        <span className="block mt-1 text-danger font-medium">This cannot be undone.</span>
                      </p>
                      {phase.eligibleCount === 0 && (
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          No requests are currently eligible for deletion.
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}

              {/* Applying */}
              {isApplying && (
                <span className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
                  <span className="animate-spin h-4 w-4 border-2 border-slate-300 dark:border-slate-700 border-t-slate-600 rounded-full inline-block" aria-hidden="true" />
                  Deleting requests…
                </span>
              )}

              {/* Applied — show result */}
              {phase.step === 'applied' && (
                <p className="text-sm text-slate-700 dark:text-slate-300">
                  <strong className="nums">{phase.deletedCount}</strong>{' '}
                  {phase.deletedCount === 1 ? 'request was' : 'requests were'} permanently deleted.
                </p>
              )}

              {/* Error */}
              {phase.step === 'error' && (
                <Alert variant="destructive" role="alert" className="mt-1">
                  <AlertCircle className="h-4 w-4" aria-hidden="true" />
                  <AlertDescription>{phase.message}</AlertDescription>
                </Alert>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        <DialogFooter className="gap-2">
          {/* Always show Close/Cancel */}
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={busy}
          >
            {phase.step === 'applied' || phase.step === 'error' ? 'Close' : 'Cancel'}
          </Button>

          {/* Confirm button — only before applying (not on success/error) */}
          {(phase.step === 'dry_run_complete') && (
            <Button
              type="button"
              variant="destructive"
              onClick={onConfirm}
              disabled={
                phase.retentionDisabled ||
                (phase.step === 'dry_run_complete' && phase.eligibleCount === 0)
              }
            >
              Delete {phase.eligibleCount} {phase.eligibleCount === 1 ? 'request' : 'requests'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
