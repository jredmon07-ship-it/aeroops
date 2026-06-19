/**
 * gate-settings-dialog.tsx — "Gate settings" dialog for the dispatch board.
 *
 * Gated: dispatch:manage_requirements (control absent when cap missing;
 * server action re-gates independently).
 *
 * Controls:
 *   Eligibility mode — Block (default) / Warn
 *   Balance check toggle — Feature flag preview; copy states it is NOT yet active.
 *
 * [VERIFY-3c-A] Copy uses operator-data framing; never currency/endorsement language.
 * [VERIFY-3c-MONEY] Balance toggle copy explicitly states it has no effect in Phase 1.
 *   The stub always returns {ok:true}; balance_block is reserved + unreachable.
 *
 * BOUNDARY: imports ONLY from @aeroops/api. Never @aeroops/db.
 */
'use client';

import * as React from 'react';
import { Settings2, XCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import {
  getDispatchConfigAction,
  updateDispatchConfigAction,
} from '../../../dispatch-gate-actions';
import type { DispatchConfigView } from '@aeroops/api';

// ─── Props ────────────────────────────────────────────────────────────────────

interface GateSettingsDialogProps {
  /** Whether the current user has dispatch:manage_requirements. */
  canManageRequirements: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function GateSettingsDialog({ canManageRequirements }: GateSettingsDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [config, setConfig] = React.useState<DispatchConfigView | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = React.useState(false);

  // Local form state (mirrors config when loaded)
  const [eligibilityMode, setEligibilityMode] = React.useState<'block' | 'warn'>('block');
  const [balanceCheckEnabled, setBalanceCheckEnabled] = React.useState(false);

  // ── Load config when dialog opens ──────────────────────────────────────────
  React.useEffect(() => {
    if (!open) return;
    setSaveError(null);
    setSaveSuccess(false);

    let cancelled = false;
    setLoading(true);

    getDispatchConfigAction()
      .then((result) => {
        if (cancelled) return;
        setLoading(false);
        if ('error' in result) {
          setSaveError('Could not load settings. Please try again.');
          return;
        }
        setConfig(result.config);
        setEligibilityMode(result.config.eligibilityMode);
        setBalanceCheckEnabled(result.config.balanceCheckEnabled);
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
          setSaveError('Could not load settings. Please try again.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  // ── Save handler ───────────────────────────────────────────────────────────
  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaveError(null);
    setSaveSuccess(false);
    setSaving(true);
    try {
      const result = await updateDispatchConfigAction({
        eligibilityMode,
        balanceCheckEnabled,
      });
      if ('error' in result) {
        if (result.error === 'validation') {
          setSaveError(result.message);
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setSaveError('You do not have permission to update gate settings.');
          return;
        }
        setSaveError('Something went wrong. Please try again.');
        return;
      }
      if (!result.ok) {
        setSaveError('Something went wrong. Please try again.');
        return;
      }
      setConfig(result.config);
      setSaveSuccess(true);
      // Auto-close after a brief success pause
      setTimeout(() => {
        setOpen(false);
        setSaveSuccess(false);
      }, 600);
    } catch {
      setSaveError('Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  // If no capability, render nothing (server action will re-gate anyway)
  if (!canManageRequirements) {
    return null;
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label="Open gate settings"
      >
        <Settings2 className="h-4 w-4 mr-1.5" aria-hidden="true" />
        Gate settings
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dispatch gate settings</DialogTitle>
          </DialogHeader>

          {loading && (
            <div
              className="flex items-center justify-center py-8"
              aria-busy="true"
              aria-label="Loading gate settings"
            >
              <Loader2 className="h-6 w-6 animate-spin text-slate-400" aria-hidden="true" />
            </div>
          )}

          {!loading && (
            <form onSubmit={handleSave} className="space-y-5" noValidate>
              {/* ── Eligibility mode ─────────────────────────────────────── */}
              {/* [VERIFY-3c-A] operator-data framing; no currency implication */}
              <fieldset className="space-y-2">
                <legend className="text-sm font-semibold text-slate-700">
                  Eligibility mode
                </legend>
                <p className="text-xs text-slate-500">
                  When a pilot is missing required tags: block the check-out
                  (Block) or allow it with a warning (Warn). Default: Block.
                </p>
                <div className="space-y-2 mt-1">
                  {/* Block option */}
                  <label className="flex items-start gap-2.5 cursor-pointer rounded-md border border-slate-200 p-3 hover:bg-slate-50 has-[:checked]:border-sky-500 has-[:checked]:bg-sky-50">
                    <input
                      type="radio"
                      name="eligibility-mode"
                      value="block"
                      checked={eligibilityMode === 'block'}
                      onChange={() => setEligibilityMode('block')}
                      disabled={saving}
                      className="mt-0.5 accent-sky-600"
                      aria-label="Block — dispatch is blocked when pilot is missing required tags"
                    />
                    <div>
                      <p className="text-sm font-medium text-slate-900">Block</p>
                      <p className="text-xs text-slate-500">
                        Check-out is prevented when the pilot is missing a required tag.
                      </p>
                    </div>
                  </label>

                  {/* Warn option */}
                  <label className="flex items-start gap-2.5 cursor-pointer rounded-md border border-slate-200 p-3 hover:bg-slate-50 has-[:checked]:border-sky-500 has-[:checked]:bg-sky-50">
                    <input
                      type="radio"
                      name="eligibility-mode"
                      value="warn"
                      checked={eligibilityMode === 'warn'}
                      onChange={() => setEligibilityMode('warn')}
                      disabled={saving}
                      className="mt-0.5 accent-sky-600"
                      aria-label="Warn — dispatch proceeds with advisory notice when pilot is missing required tags"
                    />
                    <div>
                      <p className="text-sm font-medium text-slate-900">Warn</p>
                      <p className="text-xs text-slate-500">
                        Check-out proceeds with an advisory notice; nothing is blocked.
                      </p>
                    </div>
                  </label>
                </div>
              </fieldset>

              {/* ── Balance check toggle ──────────────────────────────────── */}
              {/* [VERIFY-3c-MONEY] FEATURE FLAG ONLY. No money concept.        */}
              {/* Stub always returns {ok:true}; balance_block is reserved.     */}
              <div className="rounded-md border border-slate-200 p-3 space-y-2">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-slate-700">
                      Pre-flight balance check
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Coming in Billing. Not yet active — turning this on has no
                      effect until account balances ship.
                    </p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer" aria-label="Enable pre-flight balance check (not yet active)">
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={balanceCheckEnabled}
                      onChange={(e) => setBalanceCheckEnabled(e.target.checked)}
                      disabled={saving}
                    />
                    <div className="w-9 h-5 rounded-full bg-slate-200 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-sky-500 peer-checked:bg-sky-500 after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4" />
                  </label>
                </div>
                <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                  Preview only — this toggle has no operational effect in Phase 1.
                </p>
              </div>

              {/* ── Save error ────────────────────────────────────────────── */}
              {saveError && (
                <Alert variant="destructive" role="alert" aria-live="assertive">
                  <XCircle className="h-4 w-4" aria-hidden="true" />
                  <AlertDescription>{saveError}</AlertDescription>
                </Alert>
              )}

              {/* ── Success notice ────────────────────────────────────────── */}
              {saveSuccess && (
                <p role="status" className="text-sm text-green-700 text-center">
                  Settings saved.
                </p>
              )}

              <DialogFooter>
                <DialogClose asChild>
                  <Button
                    type="button"
                    variant="outline"
                    autoFocus
                    disabled={saving}
                  >
                    Cancel
                  </Button>
                </DialogClose>
                <Button
                  type="submit"
                  disabled={saving || loading || config === null}
                >
                  {saving ? (
                    <><Loader2 className="h-4 w-4 animate-spin mr-1" aria-hidden="true" />Saving…</>
                  ) : (
                    'Save settings'
                  )}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
