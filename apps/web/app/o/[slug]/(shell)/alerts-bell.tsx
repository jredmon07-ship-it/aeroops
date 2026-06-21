/**
 * alerts-bell.tsx — Header alerts bell (Slice N1.2).
 *
 * Built on @radix-ui/react-dialog (focus-trap / Esc / role=dialog are free).
 * No new dependency.
 *
 * MOUNTING: Once in (shell)/layout.tsx, between CommandPalette and user email.
 * Receives the org slug (for href building) and the session orgId + userId
 * (for the per-user localStorage seen-set key).
 *
 * STATES:
 *   closed          — bell icon button with optional badge.
 *   open-loading    — dropdown panel with skeleton rows.
 *   open-empty      — "You're all caught up".
 *   open-populated  — rows: kind icon, title, detail, relative time, dismiss ×.
 *   open-error      — "Couldn't load alerts." (quiet; header still renders).
 *
 * SEEN-SET (localStorage):
 *   Key: aeroops:alerts-seen:{orgId}:{userId}
 *   Dismiss adds id. "Mark all as seen" footer adds all shown ids.
 *   Stale ids (no longer in the live result) are pruned on read.
 *   ALL localStorage access wrapped in try/catch — SSR / private-mode degrades
 *   to live count (never throws, never blank header).
 *   Opening the dropdown does NOT auto-mark-seen.
 *
 * A11Y:
 *   - Trigger: aria-label with unread count, aria-haspopup="dialog".
 *   - role="dialog" + aria-modal (Radix).
 *   - aria-live="polite" region announces count on load.
 *   - Dismiss buttons: aria-label="Dismiss alert".
 *   - Esc closes + focus returns to trigger (Radix).
 *
 * BOUNDARY: imports ONLY from @aeroops/api (via the action) — NEVER @aeroops/db.
 */
'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Bell, Calendar, AlertTriangle, X } from 'lucide-react';
import { cn } from '@/components/ui/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { getMyAlertsAction } from './alerts-actions';
import type { SerializedAlert } from './alerts-actions';
import { formatRelativeTime } from '@/lib/activity-utils';
import {
  seenSetKey,
  readSeenIds,
  serializeSeenIds,
  pruneSeenIds,
  computeUnreadCount,
  badgeLabel,
  buildAlertHref,
} from './alerts-bell-helpers';

// ─── Props ────────────────────────────────────────────────────────────────────

interface AlertsBellProps {
  /** The org URL slug — used to build full hrefs from server slug-less paths. */
  slug: string;
  /** The session's orgId — used as part of the localStorage seen-set key. */
  orgId: string;
  /** The session's userId — used as part of the localStorage seen-set key. */
  userId: string;
}

// ─── Internal state type ──────────────────────────────────────────────────────

type BellState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'populated'; alerts: SerializedAlert[] }
  | { kind: 'empty' }
  | { kind: 'error' };

// ─── localStorage helpers (wrapped in try/catch) ──────────────────────────────

function lsRead(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsWrite(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or quota exceeded — degrade silently.
  }
}

// ─── AlertsBell ───────────────────────────────────────────────────────────────

export function AlertsBell({ slug, orgId, userId }: AlertsBellProps) {
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState<BellState>({ kind: 'idle' });
  // Seen-set is kept in state so changes re-render the badge without a page reload.
  const [seen, setSeen] = React.useState<Set<string>>(new Set());

  // Track whether we've loaded at all (for on-mount fetch).
  const hasFetchedRef = React.useRef(false);

  const storageKey = seenSetKey(orgId, userId);

  // ── Load seen-set from localStorage on mount ───────────────────────────────

  React.useEffect(() => {
    const raw = lsRead(storageKey);
    const initial = readSeenIds(raw);
    setSeen(initial);
  }, [storageKey]);

  // ── Fetch alerts ───────────────────────────────────────────────────────────

  const fetchAlerts = React.useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const result = await getMyAlertsAction();
      if ('error' in result) {
        if (result.error === 'unauthenticated') {
          // Session gone — empty (not an error to show).
          setState({ kind: 'empty' });
        } else {
          setState({ kind: 'error' });
        }
        return;
      }
      // Prune stale ids now that we have the fresh list.
      const currentIds = new Set(result.alerts.map((a) => a.id));
      setSeen((prev) => {
        const pruned = pruneSeenIds(prev, currentIds);
        // Persist pruned seen-set.
        lsWrite(storageKey, serializeSeenIds(pruned));
        return pruned;
      });
      if (result.alerts.length === 0) {
        setState({ kind: 'empty' });
      } else {
        setState({ kind: 'populated', alerts: result.alerts });
      }
    } catch {
      setState({ kind: 'error' });
    }
  }, [storageKey]);

  // ── Fetch on mount ─────────────────────────────────────────────────────────

  React.useEffect(() => {
    if (!hasFetchedRef.current) {
      hasFetchedRef.current = true;
      void fetchAlerts();
    }
  }, [fetchAlerts]);

  // ── Fetch on open ──────────────────────────────────────────────────────────

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (nextOpen) {
        void fetchAlerts();
      }
    },
    [fetchAlerts],
  );

  // ── Dismiss an alert (add to seen-set) ────────────────────────────────────

  const dismiss = React.useCallback(
    (id: string) => {
      setSeen((prev) => {
        const next = new Set(prev);
        next.add(id);
        lsWrite(storageKey, serializeSeenIds(next));
        return next;
      });
    },
    [storageKey],
  );

  // ── Mark all as seen ──────────────────────────────────────────────────────

  const markAllSeen = React.useCallback(() => {
    if (state.kind !== 'populated') return;
    const allIds = state.alerts.map((a) => a.id);
    setSeen((prev) => {
      const next = new Set(prev);
      for (const id of allIds) next.add(id);
      lsWrite(storageKey, serializeSeenIds(next));
      return next;
    });
  }, [state, storageKey]);

  // ── Derived: unread count + badge ─────────────────────────────────────────

  const alertIds = React.useMemo(() => {
    if (state.kind !== 'populated') return [];
    return state.alerts.map((a) => a.id);
  }, [state]);

  const unread = computeUnreadCount(alertIds, seen);
  const hasUnread = unread > 0;

  // ── Live announcement ─────────────────────────────────────────────────────

  const liveAnnouncement = React.useMemo(() => {
    if (state.kind === 'populated') {
      return unread === 0
        ? 'All alerts seen'
        : `${unread} unread alert${unread === 1 ? '' : 's'}`;
    }
    if (state.kind === 'empty') return 'No alerts';
    return '';
  }, [state.kind, unread]);

  // ── Trigger aria-label ────────────────────────────────────────────────────

  const triggerLabel = hasUnread
    ? `Alerts, ${unread} unread`
    : 'Alerts, none unread';

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <>
      {/* ── Aria live region (announces count on load) ─────────────────────── */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {liveAnnouncement}
      </div>

      {/* ── Dialog ───────────────────────────────────────────────────────── */}
      <DialogPrimitive.Root open={open} onOpenChange={handleOpenChange}>
        {/* ── Bell trigger button ─────────────────────────────────────────── */}
        <DialogPrimitive.Trigger asChild>
          <button
            type="button"
            aria-label={triggerLabel}
            aria-haspopup="dialog"
            className={cn(
              'relative flex items-center justify-center',
              'h-8 w-8 rounded-md',
              'text-slate-400 hover:text-slate-600',
              'hover:bg-slate-100',
              'transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1',
            )}
          >
            <Bell className="h-4 w-4" aria-hidden="true" />

            {/* Unread badge — hidden when 0 */}
            {hasUnread && (
              <span
                aria-hidden="true"
                className={cn(
                  'absolute -right-1 -top-1',
                  'flex h-4 min-w-[1rem] items-center justify-center px-[0.25rem]',
                  'rounded-full bg-brand text-[0.625rem] font-bold leading-none text-white',
                )}
              >
                {badgeLabel(unread)}
              </span>
            )}
          </button>
        </DialogPrimitive.Trigger>

        <DialogPrimitive.Portal>
          {/* Subtle overlay — less opaque than command palette (panel feel) */}
          <DialogPrimitive.Overlay
            className={cn(
              'fixed inset-0 z-50 bg-black/20',
              'data-[state=open]:animate-in data-[state=open]:fade-in-0',
              'data-[state=closed]:animate-out data-[state=closed]:fade-out-0',
            )}
          />

          {/* Alerts panel — top-right anchored */}
          <DialogPrimitive.Content
            className={cn(
              // Position: top-right, below the header (h-14 = 56px + 4px gap)
              'fixed right-4 top-[60px] z-50',
              'w-80 sm:w-96',
              // Architectural corners + shadow
              'rounded-md border border-slate-200 bg-white shadow-lg',
              // Animation
              'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-2',
              'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2',
              'duration-150',
              // Layout
              'flex flex-col overflow-hidden',
            )}
          >
            {/* Screen reader title (visually hidden) */}
            <DialogPrimitive.Title className="sr-only">
              Alerts
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Your upcoming reservations and aircraft status alerts.
            </DialogPrimitive.Description>

            {/* ── Panel header ──────────────────────────────────────────── */}
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-900">
                Alerts
              </h2>
              <DialogPrimitive.Close asChild>
                <button
                  type="button"
                  aria-label="Close alerts"
                  className={cn(
                    'flex h-6 w-6 items-center justify-center rounded-sm',
                    'text-slate-400 hover:text-slate-600',
                    'hover:bg-slate-100',
                    'transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1',
                  )}
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </DialogPrimitive.Close>
            </div>

            {/* ── Content area ──────────────────────────────────────────── */}
            <div className="max-h-[min(24rem,70vh)] overflow-y-auto">
              {/* Loading — skeleton rows */}
              {state.kind === 'loading' && (
                <ul aria-label="Loading alerts" className="divide-y divide-slate-50 py-1">
                  {[0, 1, 2].map((i) => (
                    <li key={i} className="flex items-start gap-3 px-4 py-3">
                      <Skeleton className="mt-0.5 h-4 w-4 shrink-0 rounded-sm" />
                      <div className="flex flex-1 flex-col gap-1.5">
                        <Skeleton className="h-3.5 w-3/4 rounded-sm" />
                        <Skeleton className="h-3 w-1/2 rounded-sm" />
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {/* Empty — all caught up */}
              {(state.kind === 'empty' || state.kind === 'idle') && (
                <div className="flex flex-col items-center justify-center py-10 text-sm text-slate-400">
                  <Bell className="mb-2 h-6 w-6 opacity-30" aria-hidden="true" />
                  You&rsquo;re all caught up
                </div>
              )}

              {/* Error */}
              {state.kind === 'error' && (
                <div className="flex items-center justify-center py-10 text-sm text-slate-500">
                  Couldn&rsquo;t load alerts.
                </div>
              )}

              {/* Populated — alert rows */}
              {state.kind === 'populated' && (
                <ul aria-label="Your alerts" className="divide-y divide-slate-50">
                  {state.alerts.map((alert) => {
                    const href = buildAlertHref(slug, alert.path);
                    const isGrounded = alert.kind === 'aircraft_grounded';
                    const isUnseen = !seen.has(alert.id);

                    return (
                      <AlertRow
                        key={alert.id}
                        alert={alert}
                        href={href}
                        isUnseen={isUnseen}
                        isGrounded={isGrounded}
                        onDismiss={() => dismiss(alert.id)}
                      />
                    );
                  })}
                </ul>
              )}
            </div>

            {/* ── Footer — "Mark all as seen" ───────────────────────────── */}
            {state.kind === 'populated' && hasUnread && (
              <div className="border-t border-slate-100 px-4 py-2.5">
                <button
                  type="button"
                  onClick={markAllSeen}
                  className={cn(
                    'text-xs text-slate-400 hover:text-brand',
                    'transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 rounded-sm',
                  )}
                >
                  Mark all as seen
                </button>
              </div>
            )}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}

// ─── AlertRow (sub-component) ─────────────────────────────────────────────────

interface AlertRowProps {
  alert: SerializedAlert;
  href: string | null;
  isUnseen: boolean;
  isGrounded: boolean;
  onDismiss: () => void;
}

function AlertRow({ alert, href, isUnseen, isGrounded, onDismiss }: AlertRowProps) {
  const Icon = isGrounded ? AlertTriangle : Calendar;

  const rowContent = (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span
        className={cn(
          'text-sm leading-tight',
          isUnseen ? 'font-semibold text-slate-900' : 'font-medium text-slate-700',
        )}
      >
        {alert.title}
      </span>
      <span className="text-xs leading-snug text-slate-500 line-clamp-2">
        {alert.detail}
      </span>
      <span className="nums mt-0.5 text-[0.6875rem] text-slate-400">
        {formatRelativeTime(alert.at)}
      </span>
    </div>
  );

  return (
    <li
      className={cn(
        'group flex items-start gap-3 px-4 py-3',
        'transition-colors',
        href ? 'hover:bg-slate-50' : '',
        isUnseen && 'bg-brand/[0.03]',
      )}
    >
      {/* Kind icon */}
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm',
          isGrounded
            ? 'text-amber-500'
            : 'text-brand',
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>

      {/* Content — linkable when path is non-null */}
      {href ? (
        <a
          href={href}
          className={cn(
            'min-w-0 flex-1',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 rounded-sm',
          )}
        >
          {rowContent}
        </a>
      ) : (
        <div className="min-w-0 flex-1">{rowContent}</div>
      )}

      {/* Dismiss button — includes alert title for per-alert context when
          multiple alerts are present (avoids repeated identical labels). */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDismiss();
        }}
        aria-label={`Dismiss alert: ${alert.title}`}
        className={cn(
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm',
          'text-slate-300 hover:text-slate-500',
          'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          'transition-opacity',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1',
        )}
      >
        <X className="h-3 w-3" aria-hidden="true" />
      </button>
    </li>
  );
}
