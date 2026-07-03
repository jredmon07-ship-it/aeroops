/**
 * calendar-feed-card.tsx — "Calendar feed" section for the self-service
 * portal (Slice P1.4).
 *
 * Lets the caller subscribe their OWN reservations (booker or dispatched
 * pilot) into Apple Calendar / Google Calendar / Outlook via a private
 * .ics URL. Only ONE 'my_reservations' feed is surfaced here — if the
 * caller also has an 'aircraft' feed (created from Fleet detail), it is not
 * shown in this card (kept thin — this card is about "my schedule").
 *
 * States:
 *   loading    — skeleton.
 *   empty      — no feed yet + "Get my calendar link" button.
 *   populated  — the subscribe URL (copyable) + the privacy warning +
 *                Revoke (confirm) / Regenerate buttons.
 *   error      — non-fatal inline alert + retry.
 *
 * SECURITY: the feed_token is a bearer secret (anyone with the URL can read
 * this member's schedule) — the warning copy below is load-bearing, not
 * decorative. This component NEVER logs the token; it only renders it into
 * a read-only input for the member to copy.
 *
 * BOUNDARY: imports ONLY from '@aeroops/api' (types) + local server actions.
 */
'use client';

import * as React from 'react';
import { AlertCircle, Calendar, Copy, Check, RefreshCw, XCircle, Loader2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
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
  listMyCalendarFeedsAction,
  createCalendarFeedAction,
  revokeCalendarFeedAction,
  regenerateCalendarFeedAction,
} from '../actions';
import type { SerializedCalendarFeedView } from '../actions';

type CardState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; feed: SerializedCalendarFeedView | null };

function feedUrl(token: string): string {
  if (typeof window === 'undefined') return `/api/calendar/${token}`;
  return `${window.location.origin}/api/calendar/${token}`;
}

export function CalendarFeedCard() {
  const [state, setState] = React.useState<CardState>({ phase: 'loading' });
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [confirmRevoke, setConfirmRevoke] = React.useState(false);

  const load = React.useCallback(async () => {
    setState({ phase: 'loading' });
    const result = await listMyCalendarFeedsAction();
    if ('error' in result) {
      const msg =
        result.error === 'forbidden' || result.error === 'unauthenticated'
          ? 'You do not have permission to view calendar feeds.'
          : "Couldn't load your calendar feed. Please refresh.";
      setState({ phase: 'error', message: msg });
      return;
    }
    const active = result.feeds.find((f) => f.scope === 'my_reservations' && f.active) ?? null;
    setState({ phase: 'ready', feed: active });
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate() {
    setBusy(true);
    setActionError(null);
    try {
      const result = await createCalendarFeedAction({ scope: 'my_reservations' });
      if (!('ok' in result) || !result.ok) {
        setActionError("Couldn't create your calendar feed. Please try again.");
        return;
      }
      setState({ phase: 'ready', feed: result.feed });
    } catch {
      setActionError("Couldn't create your calendar feed. Please try again.");
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
        setActionError("Couldn't revoke your calendar feed. Please try again.");
        return;
      }
      setState({ phase: 'ready', feed: null });
    } catch {
      setActionError("Couldn't revoke your calendar feed. Please try again.");
    } finally {
      setBusy(false);
      setConfirmRevoke(false);
    }
  }

  async function handleRegenerate(feedId: string) {
    setBusy(true);
    setActionError(null);
    try {
      const result = await regenerateCalendarFeedAction(feedId);
      if (!('ok' in result) || !result.ok) {
        setActionError("Couldn't refresh your calendar link. Please try again.");
        return;
      }
      setCopied(false);
      setState({ phase: 'ready', feed: result.feed });
    } catch {
      setActionError("Couldn't refresh your calendar link. Please try again.");
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
    <section
      className="rounded-md border border-slate-200 bg-white shadow-xs overflow-hidden"
      aria-label="Calendar feed"
    >
      <div className="border-b border-slate-100 px-5 py-3 flex items-center gap-2">
        <Calendar className="h-4 w-4 text-slate-400" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-slate-700">Calendar feed</h2>
      </div>

      <div className="px-5 py-4 space-y-3">
        <p className="text-xs text-slate-500">
          Subscribe your reservations into Apple Calendar, Google Calendar, or Outlook.
          The feed updates automatically as your schedule changes.
        </p>

        {state.phase === 'loading' && (
          <div className="space-y-2 animate-pulse" aria-busy="true" aria-label="Loading calendar feed">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        )}

        {state.phase === 'error' && (
          <Alert role="alert">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription className="flex items-center justify-between gap-4">
              <span>{state.message}</span>
              <button
                type="button"
                onClick={() => { void load(); }}
                className="text-sm underline underline-offset-2 hover:no-underline shrink-0"
              >
                Retry
              </button>
            </AlertDescription>
          </Alert>
        )}

        {state.phase === 'ready' && state.feed === null && (
          <Button size="sm" onClick={() => { void handleCreate(); }} disabled={busy}>
            {busy ? (
              <><Loader2 className="h-4 w-4 animate-spin mr-1" aria-hidden="true" />Creating…</>
            ) : (
              'Get my calendar link'
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
                aria-label="Your calendar subscribe URL"
                onFocus={(e) => e.currentTarget.select()}
                className="flex h-9 w-full min-w-0 rounded-md border border-slate-300 bg-slate-50 px-3 text-xs font-mono text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/30"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => { void handleCopy(feedUrl(state.feed!.feedToken)); }}
                aria-label="Copy calendar subscribe URL"
              >
                {copied ? (
                  <><Check className="h-4 w-4 mr-1" aria-hidden="true" />Copied</>
                ) : (
                  <><Copy className="h-4 w-4 mr-1" aria-hidden="true" />Copy</>
                )}
              </Button>
            </div>

            {/* Load-bearing privacy warning — not decorative. */}
            <div className="flex items-start gap-1.5 rounded bg-amber-50 border border-amber-200 px-2.5 py-2">
              <ShieldAlert className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" aria-hidden="true" />
              <p className="text-[11px] text-amber-800 leading-relaxed">
                This link is private — anyone who has it can see your schedule. Don&apos;t share it publicly.
                Revoke or refresh it below if it&apos;s ever exposed.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => { void handleRegenerate(state.feed!.id); }}
                disabled={busy}
              >
                <RefreshCw className="h-4 w-4 mr-1" aria-hidden="true" />
                Refresh link
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setConfirmRevoke(true)}
                disabled={busy}
                className="text-red-600 hover:text-red-700 hover:border-red-300"
              >
                <XCircle className="h-4 w-4 mr-1" aria-hidden="true" />
                Revoke
              </Button>
            </div>
          </div>
        )}

        {actionError && (
          <Alert variant="destructive" role="alert">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription className="text-sm">{actionError}</AlertDescription>
          </Alert>
        )}
      </div>

      <AlertDialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke your calendar link?</AlertDialogTitle>
            <AlertDialogDescription>
              Any calendar app subscribed to this link will stop updating. This cannot be undone —
              you can get a new link afterward.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus onClick={() => setConfirmRevoke(false)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => { if (state.phase === 'ready' && state.feed) void handleRevoke(state.feed.id); }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
