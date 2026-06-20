/**
 * gate-settings-dialog.tsx — "Gate settings" dialog for the dispatch board.
 *
 * Gated: dispatch:manage_requirements (control absent when cap missing;
 * server action re-gates independently).
 *
 * Controls:
 *   Eligibility mode — Block (default) / Warn
 *   Balance check toggle — Feature flag preview; copy states it is NOT yet active.
 *   Civil-twilight constraint (Slice 4a):
 *     Enabled toggle + Warn/Block mode selector + exempt-tag text field.
 *
 * [VERIFY-3c-A] Copy uses operator-data framing; never currency/endorsement language.
 * [VERIFY-3c-MONEY] Balance toggle copy explicitly states it has no effect in Phase 1.
 *   The stub always returns {ok:true}; balance_block is reserved + unreachable.
 * [VERIFY-4a-A] Twilight controls MUST carry the mandatory compliance disclaimer
 *   per spec §4a.3: NOT an FAA night-currency/§61.57 determination.
 * [VERIFY-4a-D] twilightExemptTag is FREE-TEXT only; no computed currency.
 *   Exempt-tag enforcement is DEFERRED in 4a (wiring not yet applied at gate).
 *
 * BOUNDARY: imports ONLY from @aeroops/api. Never @aeroops/db.
 */
'use client';

import * as React from 'react';
import { Settings2, XCircle, Loader2, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

  // Slice 4a — Civil-twilight constraint fields
  // [VERIFY-4a-A]: operator scheduling rule from astronomy, NOT FAA night-currency.
  const [twilightConstraintEnabled, setTwilightConstraintEnabled] = React.useState(false);
  const [twilightMode, setTwilightMode] = React.useState<'block' | 'warn'>('warn');
  const [twilightExemptTag, setTwilightExemptTag] = React.useState('');
  const [twilightExemptTagError, setTwilightExemptTagError] = React.useState<string | null>(null);

  // Slice AV1.3 — Availability constraint fields
  // [VERIFY-AV1-A]: operator operating-hours rule, NOT an FAA duty-time determination.
  const [availabilityConstraintEnabled, setAvailabilityConstraintEnabled] = React.useState(false);
  const [availabilityMode, setAvailabilityMode] = React.useState<'block' | 'warn'>('warn');

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
        const cfg = result.config;
        setConfig(cfg);
        setEligibilityMode(cfg.eligibilityMode);
        setBalanceCheckEnabled(cfg.balanceCheckEnabled);
        // Slice 4a twilight fields
        setTwilightConstraintEnabled(cfg.twilightConstraintEnabled);
        setTwilightMode(cfg.twilightMode);
        setTwilightExemptTag(cfg.twilightExemptTag ?? '');
        setTwilightExemptTagError(null);
        // Slice AV1.3 availability fields
        setAvailabilityConstraintEnabled(cfg.availabilityConstraintEnabled);
        setAvailabilityMode(cfg.availabilityMode);
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
    setTwilightExemptTagError(null);

    // Client-side validate exempt tag: if provided, must be non-whitespace.
    const trimmedExemptTag = twilightExemptTag.trim();
    if (twilightExemptTag.length > 0 && trimmedExemptTag.length === 0) {
      setTwilightExemptTagError('Exempt tag cannot be blank whitespace.');
      return;
    }

    setSaving(true);
    try {
      const result = await updateDispatchConfigAction({
        eligibilityMode,
        balanceCheckEnabled,
        twilightConstraintEnabled,
        twilightMode,
        twilightExemptTag: trimmedExemptTag.length > 0 ? trimmedExemptTag : null,
        availabilityConstraintEnabled,
        availabilityMode,
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
        <DialogContent className="max-h-[90vh] overflow-y-auto">
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
                  <label className="flex items-start gap-2.5 cursor-pointer rounded-md border border-slate-200 p-3 hover:bg-slate-50 has-[:checked]:border-brand has-[:checked]:bg-brand/5">
                    <input
                      type="radio"
                      name="eligibility-mode"
                      value="block"
                      checked={eligibilityMode === 'block'}
                      onChange={() => setEligibilityMode('block')}
                      disabled={saving}
                      className="mt-0.5 accent-brand"
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
                  <label className="flex items-start gap-2.5 cursor-pointer rounded-md border border-slate-200 p-3 hover:bg-slate-50 has-[:checked]:border-brand has-[:checked]:bg-brand/5">
                    <input
                      type="radio"
                      name="eligibility-mode"
                      value="warn"
                      checked={eligibilityMode === 'warn'}
                      onChange={() => setEligibilityMode('warn')}
                      disabled={saving}
                      className="mt-0.5 accent-brand"
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

              {/* ── Civil-twilight constraint (Slice 4a) ──────────────────── */}
              {/*
               * [VERIFY-4a-A] MANDATORY COMPLIANCE DISCLAIMER (spec §4a.3):
               *   This is an operator scheduling rule based on astronomical
               *   civil-twilight times. It is NOT an FAA night-currency or §61.57
               *   determination. 'Night-qualified' is a label you assign; the system
               *   attaches no regulatory meaning.
               * [VERIFY-4a-D] twilightExemptTag is FREE-TEXT only; no computed
               *   currency/endorsement. Exempt-tag wiring DEFERRED in 4a.
               */}
              <div className="rounded-md border border-slate-200 p-3 space-y-3">
                {/* Enabled toggle */}
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-slate-700">
                      Civil-twilight constraint
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      When enabled, bookings crossing civil dawn/dusk are warned or blocked
                      per the mode below. Default: off.
                    </p>
                  </div>
                  <label
                    className="relative inline-flex items-center cursor-pointer"
                    aria-label={`Civil-twilight constraint ${twilightConstraintEnabled ? 'enabled' : 'disabled'}`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={twilightConstraintEnabled}
                      onChange={(e) => setTwilightConstraintEnabled(e.target.checked)}
                      disabled={saving}
                    />
                    <div className="w-9 h-5 rounded-full bg-slate-200 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-brand peer-checked:bg-brand after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4" />
                  </label>
                </div>

                {/* Mode selector — only when enabled */}
                {twilightConstraintEnabled && (
                  <fieldset className="space-y-1.5">
                    <legend className="text-xs font-semibold text-slate-600">
                      Mode
                    </legend>
                    <div className="flex gap-3">
                      <label className="flex items-center gap-1.5 cursor-pointer text-sm">
                        <input
                          type="radio"
                          name="twilight-mode"
                          value="warn"
                          checked={twilightMode === 'warn'}
                          onChange={() => setTwilightMode('warn')}
                          disabled={saving}
                          className="accent-brand"
                          aria-label="Warn — advisory notice, booking proceeds"
                        />
                        <span className="text-slate-800">Warn</span>
                        <span className="text-xs text-slate-500">(advisory, booking proceeds)</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer text-sm">
                        <input
                          type="radio"
                          name="twilight-mode"
                          value="block"
                          checked={twilightMode === 'block'}
                          onChange={() => setTwilightMode('block')}
                          disabled={saving}
                          className="accent-brand"
                          aria-label="Block — booking is refused when it crosses civil dawn/dusk"
                        />
                        <span className="text-slate-800">Block</span>
                        <span className="text-xs text-slate-500">(booking refused)</span>
                      </label>
                    </div>
                  </fieldset>
                )}

                {/* Exempt tag — only when enabled */}
                {twilightConstraintEnabled && (
                  <div className="space-y-1">
                    <Label
                      htmlFor="twilightExemptTag"
                      className="text-xs font-semibold text-slate-600"
                    >
                      Night-qualified exempt tag (optional)
                    </Label>
                    <Input
                      id="twilightExemptTag"
                      type="text"
                      value={twilightExemptTag}
                      onChange={(e) => {
                        setTwilightExemptTag(e.target.value);
                        setTwilightExemptTagError(null);
                      }}
                      disabled={saving}
                      placeholder="e.g. Night qualified"
                      maxLength={100}
                      aria-describedby={twilightExemptTagError ? 'twilightExemptTagError' : 'twilightExemptTagHint'}
                      className={twilightExemptTagError ? 'border-red-500' : ''}
                    />
                    {twilightExemptTagError ? (
                      <p id="twilightExemptTagError" role="alert" className="text-xs text-red-600">
                        {twilightExemptTagError}
                      </p>
                    ) : (
                      <p id="twilightExemptTagHint" className="text-xs text-slate-500">
                        Pilots carrying this tag bypass the twilight constraint.
                        Exempt-tag enforcement is recorded but not yet applied — coming with pilot assignment.
                      </p>
                    )}
                  </div>
                )}

                {/* MANDATORY compliance disclaimer — spec §4a.3 (MUST be present) */}
                {/* [VERIFY-4a-A]: required copy; do not remove or soften.          */}
                <div className="flex items-start gap-1.5 rounded bg-amber-50 border border-amber-200 px-2.5 py-2">
                  <Info className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />
                  <p className="text-[11px] text-amber-800 leading-relaxed">
                    This is an operator scheduling rule based on astronomical civil-twilight times.
                    It is <strong>NOT</strong> an FAA night-currency or §61.57 determination.
                    &ldquo;Night-qualified&rdquo; is a label you assign; the system attaches no
                    regulatory meaning.
                  </p>
                </div>
              </div>

              {/* ── Operating-hours availability constraint (Slice AV1.3) ──── */}
              {/*
               * [VERIFY-AV1-A] MANDATORY COMPLIANCE DISCLAIMER (spec AV1.3):
               *   Operating-hours availability is an operator scheduling rule.
               *   It is NOT an FAA flight/duty-time, rest, or §117 determination.
               * [VERIFY-AV1-A]: operator operating-hours data, NOT computed from
               *   any FAA/Part-117/135/121 rule.
               */}
              <div className="rounded-md border border-slate-200 p-3 space-y-3">
                {/* Enabled toggle */}
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-slate-700">
                      Operating-hours availability
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      When enabled, bookings outside defined aircraft operating hours
                      are warned or blocked per the mode below. Default: off.
                    </p>
                  </div>
                  <label
                    className="relative inline-flex items-center cursor-pointer"
                    aria-label={`Operating-hours availability constraint ${availabilityConstraintEnabled ? 'enabled' : 'disabled'}`}
                  >
                    <input
                      type="checkbox"
                      className="sr-only peer"
                      checked={availabilityConstraintEnabled}
                      onChange={(e) => setAvailabilityConstraintEnabled(e.target.checked)}
                      disabled={saving}
                    />
                    <div className="w-9 h-5 rounded-full bg-slate-200 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-brand peer-checked:bg-brand after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4" />
                  </label>
                </div>

                {/* Mode selector — only when enabled */}
                {availabilityConstraintEnabled && (
                  <fieldset className="space-y-1.5">
                    <legend className="text-xs font-semibold text-slate-600">
                      Mode
                    </legend>
                    <div className="flex gap-3">
                      <label className="flex items-center gap-1.5 cursor-pointer text-sm">
                        <input
                          type="radio"
                          name="availability-mode"
                          value="warn"
                          checked={availabilityMode === 'warn'}
                          onChange={() => setAvailabilityMode('warn')}
                          disabled={saving}
                          className="accent-brand"
                          aria-label="Warn — advisory notice, booking proceeds"
                        />
                        <span className="text-slate-800">Warn</span>
                        <span className="text-xs text-slate-500">(advisory, booking proceeds)</span>
                      </label>
                      <label className="flex items-center gap-1.5 cursor-pointer text-sm">
                        <input
                          type="radio"
                          name="availability-mode"
                          value="block"
                          checked={availabilityMode === 'block'}
                          onChange={() => setAvailabilityMode('block')}
                          disabled={saving}
                          className="accent-brand"
                          aria-label="Block — booking is refused when it falls outside operating hours"
                        />
                        <span className="text-slate-800">Block</span>
                        <span className="text-xs text-slate-500">(booking refused)</span>
                      </label>
                    </div>
                  </fieldset>
                )}

                {/* MANDATORY compliance disclaimer (MUST be present) */}
                {/* [VERIFY-AV1-A]: required copy; do not remove or soften. */}
                <div className="flex items-start gap-1.5 rounded bg-amber-50 border border-amber-200 px-2.5 py-2">
                  <Info className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />
                  <p className="text-[11px] text-amber-800 leading-relaxed">
                    Operating-hours availability is an operator scheduling rule — it is{' '}
                    <strong>NOT</strong> an FAA flight/duty-time, rest, or §117 determination.
                  </p>
                </div>
              </div>

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
                    <div className="w-9 h-5 rounded-full bg-slate-200 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-brand peer-checked:bg-brand after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4" />
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
