/**
 * notification-prefs-card.tsx — self-service email notification toggles
 * (Slice P1.3).
 *
 * States:
 *   loading   — skeleton rows while fetching current prefs.
 *   populated — one row per NOTIFICATION_EVENT_TYPES entry, a checkbox each.
 *   error     — Alert with retry-by-reload copy.
 *
 * Each toggle saves independently (optimistic UI + revert-on-failure) —
 * there is no separate "Save" step, matching a simple settings-toggle UX.
 *
 * BOUNDARY: imports ONLY from '@aeroops/api' (types) + local server actions.
 */
'use client';

import * as React from 'react';
import { AlertCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Label } from '@/components/ui/label';
import type { NotificationPrefView, NotificationEventType } from '@aeroops/api';
import { getMyNotificationPrefsAction, setMyNotificationPrefAction } from '../actions';
import { eventLabelInfo } from '../_utils/event-labels';

type CardState =
  | { phase: 'loading' }
  | { phase: 'populated'; prefs: NotificationPrefView[] }
  | { phase: 'error'; message: string };

export function NotificationPrefsCard() {
  const [state, setState] = React.useState<CardState>({ phase: 'loading' });
  // Per-eventType in-flight/error tracking for the independent-save UX.
  const [saving, setSaving] = React.useState<Set<NotificationEventType>>(new Set());
  const [rowErrors, setRowErrors] = React.useState<Map<NotificationEventType, string>>(new Map());

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      setState({ phase: 'loading' });
      const result = await getMyNotificationPrefsAction();
      if (cancelled) return;
      if ('error' in result) {
        const msg =
          result.error === 'forbidden' || result.error === 'unauthenticated'
            ? 'You do not have permission to view notification settings.'
            : "Couldn't load notification settings. Please refresh.";
        setState({ phase: 'error', message: msg });
        return;
      }
      setState({ phase: 'populated', prefs: result.prefs });
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleToggle(eventType: NotificationEventType, nextEnabled: boolean) {
    if (state.phase !== 'populated') return;
    const prevPrefs = state.prefs;

    // Optimistic update.
    setState({
      phase: 'populated',
      prefs: prevPrefs.map((p) => (p.eventType === eventType ? { ...p, emailEnabled: nextEnabled } : p)),
    });
    setSaving((prev) => new Set(prev).add(eventType));
    setRowErrors((prev) => {
      const next = new Map(prev);
      next.delete(eventType);
      return next;
    });

    try {
      const result = await setMyNotificationPrefAction(eventType, nextEnabled);
      if ('error' in result) {
        // Revert on failure.
        setState({ phase: 'populated', prefs: prevPrefs });
        setRowErrors((prev) =>
          new Map(prev).set(
            eventType,
            result.error === 'forbidden' || result.error === 'unauthenticated'
              ? 'You do not have permission to change this setting.'
              : "Couldn't save — please try again.",
          ),
        );
      }
    } catch {
      setState({ phase: 'populated', prefs: prevPrefs });
      setRowErrors((prev) => new Map(prev).set(eventType, "Couldn't save — please try again."));
    } finally {
      setSaving((prev) => {
        const next = new Set(prev);
        next.delete(eventType);
        return next;
      });
    }
  }

  return (
    <div
      className="rounded-lg border border-slate-200 bg-white px-5 py-4 space-y-3"
      aria-label="Email notification settings"
    >
      <div>
        <h2 className="text-sm font-semibold text-slate-800">Email notifications</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Choose which events send you an email. Off by default is not an option here — every
          event starts ON; turn any of them off below.
        </p>
      </div>

      {state.phase === 'loading' && (
        <div className="space-y-2 animate-pulse" aria-busy="true" aria-label="Loading notification settings">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      )}

      {state.phase === 'error' && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      {state.phase === 'populated' && (
        <ul className="divide-y divide-slate-100" role="list">
          {state.prefs.map((pref) => {
            const info = eventLabelInfo(pref.eventType);
            const rowSaving = saving.has(pref.eventType);
            const rowError = rowErrors.get(pref.eventType);
            const inputId = `notif-pref-${pref.eventType}`;
            return (
              <li key={pref.eventType} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <Label htmlFor={inputId} className="text-sm text-slate-800 font-medium cursor-pointer">
                    {info.label}
                  </Label>
                  {info.description && (
                    <p className="text-xs text-slate-500 mt-0.5">{info.description}</p>
                  )}
                  {rowError && (
                    <p role="alert" className="text-xs text-danger mt-0.5">
                      {rowError}
                    </p>
                  )}
                </div>
                <input
                  id={inputId}
                  type="checkbox"
                  checked={pref.emailEnabled}
                  disabled={rowSaving}
                  aria-busy={rowSaving}
                  onChange={(e) => { void handleToggle(pref.eventType, e.target.checked); }}
                  className="h-4 w-4 shrink-0 mt-0.5 rounded border-slate-300 text-brand focus:ring-brand/40"
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
