/**
 * modules-card.tsx — org setting: which whole app modules are on, plus the
 * operating-mode preset (school / club), migration 0047.
 *
 * Rendered on /o/[slug]/settings (page-level org:manage_settings gate). The
 * server actions re-enforce the caps (app:access for the read, org:manage_settings
 * for the write) — this component never trusts the page gate alone. Self-fetches
 * on mount (mirrors qbo-settings-card.tsx) rather than taking server-fetched
 * initial props, since it owns both the mode picker and the per-module toggles.
 *
 * "HIDE, DON'T DESTROY": turning a module off only hides it from nav/search and
 * blocks its routes — no module data is ever deleted or mutated by a toggle.
 *
 * States:
 *   loading                          — skeleton
 *   error                            — inline Alert
 *   ready + available:false          — disabled "available in an upcoming update" note
 *   ready + available:true           — mode tiles (with inline switch confirm) + module rows
 *
 * BOUNDARY: imports ONLY from '@aeroops/core' (types/metadata) + local server
 * actions. Never '@aeroops/db'.
 */
'use client';

import * as React from 'react';
import { AlertCircle, LayoutGrid, CheckCircle2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/lib/toast-store';
import {
  ORG_MODULES,
  OPERATING_MODES,
  ORG_MODULE_META,
  OPERATING_MODE_META,
} from '@aeroops/core';
import type { OrgModuleKey, OperatingMode, OrgFeatureFlags } from '@aeroops/core';
import { getOrgFeaturesAction, setOrgFeaturesAction } from '../actions';

type CardState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; operatingMode: OperatingMode; features: OrgFeatureFlags; available: boolean };

interface ModulesCardProps {
  slug: string;
}

export function ModulesCard({ slug }: ModulesCardProps) {
  const [state, setState] = React.useState<CardState>({ phase: 'loading' });
  const [pendingMode, setPendingMode] = React.useState<OperatingMode | null>(null);
  const [switchingMode, setSwitchingMode] = React.useState(false);
  const [togglingModule, setTogglingModule] = React.useState<OrgModuleKey | null>(null);
  const [actionError, setActionError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setState({ phase: 'loading' });
    const result = await getOrgFeaturesAction();
    if ('error' in result) {
      const msg =
        result.error === 'forbidden' || result.error === 'unauthenticated'
          ? 'You do not have permission to view module settings.'
          : "Couldn't load module settings. Please refresh.";
      setState({ phase: 'error', message: msg });
      return;
    }
    setState({
      phase: 'ready',
      operatingMode: result.operatingMode,
      features: result.features,
      available: result.available,
    });
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function handleConfirmModeSwitch() {
    if (!pendingMode) return;
    setSwitchingMode(true);
    setActionError(null);
    try {
      const result = await setOrgFeaturesAction(slug, { operatingMode: pendingMode, applyPreset: true });
      if ('error' in result) {
        setActionError("Couldn't switch operating mode. Please try again.");
        return;
      }
      if (!result.ok) {
        setActionError('Operating mode isn’t available yet.');
        return;
      }
      setState({ phase: 'ready', operatingMode: result.operatingMode, features: result.features, available: true });
      setPendingMode(null);
      toast.success(`Switched to ${OPERATING_MODE_META[result.operatingMode].label} mode.`);
    } finally {
      setSwitchingMode(false);
    }
  }

  async function handleToggleModule(key: OrgModuleKey, next: boolean) {
    setTogglingModule(key);
    setActionError(null);
    try {
      const result = await setOrgFeaturesAction(slug, { features: { [key]: next } });
      if ('error' in result) {
        setActionError("Couldn't update that module. Please try again.");
        return;
      }
      if (!result.ok) {
        setActionError('Modules aren’t available yet.');
        return;
      }
      setState({ phase: 'ready', operatingMode: result.operatingMode, features: result.features, available: true });
      toast.success(
        next
          ? `${ORG_MODULE_META[key].label} is now on for everyone in your organization.`
          : `${ORG_MODULE_META[key].label} is now hidden for everyone in your organization.`,
      );
    } finally {
      setTogglingModule(null);
    }
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <LayoutGrid className="h-4 w-4 text-slate-400 dark:text-slate-500" aria-hidden="true" />
          Modules
        </CardTitle>
      </CardHeader>
      <Separator />
      <CardContent className="pt-6 space-y-6">
        {state.phase === 'loading' && (
          <div className="space-y-2 animate-pulse" aria-busy="true" aria-label="Loading module settings">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        )}

        {state.phase === 'error' && (
          <Alert variant="destructive" role="alert">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}

        {state.phase === 'ready' && !state.available && (
          <Alert role="status">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>
              Turning modules off becomes available in an upcoming update. Every module is on for
              now, and nothing here changes until then.
            </AlertDescription>
          </Alert>
        )}

        {state.phase === 'ready' && (
          <>
            {actionError && (
              <Alert variant="destructive" role="alert">
                <AlertCircle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>{actionError}</AlertDescription>
              </Alert>
            )}

            {/* ── Operating mode ─────────────────────────────────────────── */}
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Operating mode
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                A starting point for the module toggles below. Switching modes applies its preset,
                and every module stays individually editable afterward.
              </p>
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
                      disabled={!state.available || switchingMode}
                      onClick={() => {
                        if (isCurrent) return;
                        setActionError(null);
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
                    module preset below. You can adjust any module afterward.
                  </p>
                  <div className="flex gap-2 shrink-0">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={switchingMode}
                      onClick={() => setPendingMode(null)}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      className="h-7 text-xs"
                      disabled={switchingMode}
                      aria-busy={switchingMode}
                      onClick={() => void handleConfirmModeSwitch()}
                    >
                      {switchingMode ? 'Switching…' : 'Switch mode'}
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* ── Per-module toggles ─────────────────────────────────────── */}
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Modules
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Turning a module off hides it for everyone in this organization. Nothing is deleted;
                turn it back on anytime.
              </p>
              <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-md border border-slate-200 dark:border-slate-800">
                {ORG_MODULES.map((key) => {
                  const meta = ORG_MODULE_META[key];
                  const on = state.features[key];
                  const busy = togglingModule === key;
                  return (
                    <li key={key} className="flex items-center justify-between gap-4 px-3 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{meta.label}</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">{meta.description}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {on ? (
                          <span className="inline-flex items-center rounded-sm border border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-950/40 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-green-800 dark:text-green-200">
                            On
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-sm border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-slate-500 dark:text-slate-400">
                            Off
                          </span>
                        )}
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          disabled={!state.available || busy}
                          aria-busy={busy}
                          aria-pressed={on}
                          aria-label={`${on ? 'Turn off' : 'Turn on'} ${meta.label}`}
                          onClick={() => void handleToggleModule(key, !on)}
                        >
                          {busy ? 'Saving…' : on ? 'Turn off' : 'Turn on'}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
