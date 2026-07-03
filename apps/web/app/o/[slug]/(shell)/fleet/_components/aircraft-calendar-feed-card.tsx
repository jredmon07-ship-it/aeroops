/**
 * aircraft-calendar-feed-card.tsx — "Calendar feed" card for the Fleet
 * detail page (Slice P1.4).
 *
 * Lets a staff member (fleet:access — already required to view this page)
 * subscribe THIS aircraft's schedule into Apple Calendar / Google Calendar /
 * Outlook via a private .ics URL. The feed is owned by the CALLER (self-
 * scoped, same as the portal card) — each staff member who wants this
 * aircraft's schedule creates their own feed/token.
 *
 * Reuses the SAME server actions as the portal's calendar-feed-card
 * (createCalendarFeedAction / listMyCalendarFeedsAction /
 * revokeCalendarFeedAction) — a feed is a feed regardless of which page
 * created it; 'my feeds' management stays centralized in the portal.
 *
 * States: loading / empty (+ "Get iCal feed" button) / populated (URL +
 * copy + revoke) / error. Mirrors the portal card's UX, scoped to scope=
 * 'aircraft' + this resourceId only.
 */
'use client';

import * as React from 'react';
import { AlertCircle, CalendarDays, Copy, Check, XCircle, Loader2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  listMyCalendarFeedsAction,
  createCalendarFeedAction,
  revokeCalendarFeedAction,
} from '../../portal/actions';
import type { SerializedCalendarFeedView } from '../../portal/actions';

type CardState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; feed: SerializedCalendarFeedView | null };

function feedUrl(token: string): string {
  if (typeof window === 'undefined') return `/api/calendar/${token}`;
  return `${window.location.origin}/api/calendar/${token}`;
}

export function AircraftCalendarFeedCard({ resourceId }: { resourceId: string }) {
  const [state, setState] = React.useState<CardState>({ phase: 'loading' });
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const load = React.useCallback(async () => {
    setState({ phase: 'loading' });
    const result = await listMyCalendarFeedsAction();
    if ('error' in result) {
      setState({
        phase: 'error',
        message: "Couldn't load the calendar feed for this aircraft.",
      });
      return;
    }
    const active =
      result.feeds.find((f) => f.scope === 'aircraft' && f.resourceId === resourceId && f.active) ?? null;
    setState({ phase: 'ready', feed: active });
  }, [resourceId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate() {
    setBusy(true);
    setActionError(null);
    try {
      const result = await createCalendarFeedAction({ scope: 'aircraft', resourceId });
      if (!('ok' in result) || !result.ok) {
        setActionError("Couldn't create a calendar feed for this aircraft. Please try again.");
        return;
      }
      setState({ phase: 'ready', feed: result.feed });
    } catch {
      setActionError("Couldn't create a calendar feed for this aircraft. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(feedId: string) {
    setBusy(true);
    setActionError(null);
    try {
      const result = await revokeCalendarFeedAction(feedId);
      if (!('ok' in result) || !result.ok) {
        setActionError("Couldn't revoke this calendar feed. Please try again.");
        return;
      }
      setState({ phase: 'ready', feed: null });
    } catch {
      setActionError("Couldn't revoke this calendar feed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setActionError('Could not copy — select and copy the link manually.');
    }
  }

  return (
    <div className="rounded-md border border-slate-200 bg-white p-4 space-y-3">
      <div className="flex items-center gap-2">
        <CalendarDays className="h-4 w-4 text-slate-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-slate-700">Calendar feed</h2>
      </div>

      <p className="text-xs text-slate-400">
        Subscribe this aircraft&apos;s schedule into your calendar app — updates automatically.
      </p>

      {state.phase === 'loading' && (
        <div className="space-y-2 animate-pulse" aria-busy="true" aria-label="Loading calendar feed">
          <Skeleton className="h-9 w-full" />
        </div>
      )}

      {state.phase === 'error' && (
        <Alert role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription className="text-sm">{state.message}</AlertDescription>
        </Alert>
      )}

      {state.phase === 'ready' && state.feed === null && (
        <Button size="sm" variant="outline" onClick={() => { void handleCreate(); }} disabled={busy}>
          {busy ? (
            <><Loader2 className="h-4 w-4 animate-spin mr-1" aria-hidden="true" />Creating…</>
          ) : (
            'Get iCal feed for this aircraft'
          )}
        </Button>
      )}

      {state.phase === 'ready' && state.feed !== null && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={feedUrl(state.feed.feedToken)}
              aria-label="Aircraft calendar subscribe URL"
              onFocus={(e) => e.currentTarget.select()}
              className="flex h-9 w-full min-w-0 rounded-md border border-slate-300 bg-slate-50 px-3 text-xs font-mono text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => { void handleCopy(feedUrl(state.feed!.feedToken)); }}
              aria-label="Copy aircraft calendar subscribe URL"
            >
              {copied ? (
                <><Check className="h-4 w-4 mr-1" aria-hidden="true" />Copied</>
              ) : (
                <><Copy className="h-4 w-4 mr-1" aria-hidden="true" />Copy</>
              )}
            </Button>
          </div>

          <div className="flex items-start gap-1.5 rounded bg-amber-50 border border-amber-200 px-2.5 py-2">
            <ShieldAlert className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />
            <p className="text-[11px] text-amber-800 leading-relaxed">
              This link is private — anyone who has it can see this aircraft&apos;s schedule.
            </p>
          </div>

          <Button
            size="sm"
            variant="outline"
            onClick={() => { void handleRevoke(state.feed!.id); }}
            disabled={busy}
            className="text-red-600 hover:text-red-700 hover:border-red-300"
          >
            <XCircle className="h-4 w-4 mr-1" aria-hidden="true" />
            Revoke
          </Button>
        </div>
      )}

      {actionError && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription className="text-sm">{actionError}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
