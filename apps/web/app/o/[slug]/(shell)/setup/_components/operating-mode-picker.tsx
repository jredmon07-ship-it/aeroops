/**
 * operating-mode-picker.tsx — the "Operating mode" card on the setup checklist
 * (migration 0047). Lets a new org pick 'school' or 'club' up front; applying a
 * mode writes that preset into the per-module toggles (fully editable afterward
 * on Org settings → Modules).
 *
 * Self-fetches on mount (mirrors settings/_components/modules-card.tsx's mode
 * section) — the setup page itself stays a server component with its existing
 * checklist structure untouched.
 *
 * States: loading / error / available:false (quiet note) / ready (two tiles +
 * inline switch confirm).
 *
 * BOUNDARY: imports ONLY from '@aeroops/core' (types/metadata) + the settings
 * server actions (getOrgFeaturesAction/setOrgFeaturesAction — org:manage_settings
 * enforced server-side). Never '@aeroops/db'.
 */
'use client';

import * as React from 'react';
import { AlertCircle, CheckCircle2, Compass } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/lib/toast-store';
import { OPERATING_MODES, OPERATING_MODE_META } from '@aeroops/core';
import type { OperatingMode } from '@aeroops/core';
import { getOrgFeaturesAction, setOrgFeaturesAction } from '../../settings/actions';

type PickerState =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'ready'; operatingMode: OperatingMode; available: boolean };

interface OperatingModePickerProps {
  slug: string;
}

export function OperatingModePicker({ slug }: OperatingModePickerProps) {
  const [state, setState] = React.useState<PickerState>({ phase: 'loading' });
  const [pendingMode, setPendingMode] = React.useState<OperatingMode | null>(null);
  const [switching, setSwitching] = React.useState(false);

  const load = React.useCallback(async () => {
    setState({ phase: 'loading' });
    const result = await getOrgFeaturesAction();
    if ('error' in result) {
      setState({ phase: 'error' });
      return;
    }
    setState({ phase: 'ready', operatingMode: result.operatingMode, available: result.available });
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function handleConfirm() {
    if (!pendingMode) return;
    setSwitching(true);
    try {
      const result = await setOrgFeaturesAction(slug, { operatingMode: pendingMode, applyPreset: true });
      if ('error' in result || !result.ok) {
        toast.error("Couldn't switch operating mode. Please try again.");
        return;
      }
      setState({ phase: 'ready', operatingMode: result.operatingMode, available: true });
      setPendingMode(null);
      toast.success(`Switched to ${OPERATING_MODE_META[result.operatingMode].label} mode.`);
    } finally {
      setSwitching(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Compass className="h-4 w-4 text-slate-400 dark:text-slate-500" aria-hidden="true" />
          Operating mode
        </CardTitle>
      </CardHeader>
      <Separator />
      <CardContent className="pt-6 space-y-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Pick the starting point that fits your operation. Each mode turns on a sensible set of
          modules, and you can fine-tune every one of them anytime from Org settings.
        </p>

        {state.phase === 'loading' && (
          <div className="space-y-2 animate-pulse" aria-busy="true" aria-label="Loading operating mode">
            <Skeleton className="h-16 w-full" />
          </div>
        )}

        {state.phase === 'error' && (
          <Alert variant="destructive" role="alert">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>Couldn&apos;t load operating mode. Please refresh.</AlertDescription>
          </Alert>
        )}

        {state.phase === 'ready' && !state.available && (
          <Alert role="status">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>
              Choosing an operating mode becomes available in an upcoming update. Every module is
              on for now.
            </AlertDescription>
          </Alert>
        )}

        {state.phase === 'ready' && (
          <>
            <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Operating mode">
              {OPERATING_MODES.map((mode) => {
                const meta = OPERATING_MODE_META[mode];
                const isCurrent = state.operatingMode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={isCurrent}
                    disabled={!state.available || switching}
                    onClick={() => {
                      if (isCurrent) return;
                      setPendingMode(mode);
                    }}
                    className={[
                      'rounded-md border px-4 py-3 text-left transition-colors disabled:opacity-50 disabled:pointer-events-none',
                      isCurrent
                        ? 'border-brand bg-brand/5 dark:bg-brand/10 ring-1 ring-brand'
                        : 'border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-600',
                    ].join(' ')}
                  >
                    <div className="flex items-center gap-2">
                      {isCurrent && <CheckCircle2 className="h-4 w-4 text-brand shrink-0" aria-hidden="true" />}
                      <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {meta.label}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{meta.description}</p>
                  </button>
                );
              })}
            </div>

            {pendingMode && (
              <div
                className="flex flex-col gap-2 rounded-md border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                role="alertdialog"
                aria-label="Confirm operating mode switch"
              >
                <p className="text-sm text-amber-800 dark:text-amber-200">
                  Switch to <strong>{OPERATING_MODE_META[pendingMode].label}</strong>? This applies its
                  module preset. Adjust any module afterward from Org settings.
                </p>
                <div className="flex gap-2 shrink-0">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={switching}
                    onClick={() => setPendingMode(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={switching}
                    aria-busy={switching}
                    onClick={() => void handleConfirm()}
                  >
                    {switching ? 'Switching…' : 'Switch mode'}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
