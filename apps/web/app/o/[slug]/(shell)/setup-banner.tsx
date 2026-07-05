/**
 * setup-banner.tsx — Dismissible "finish setting up" banner for the dashboard.
 *
 * Rendered by the dashboard page ONLY when the org's setup essentials are
 * incomplete (aircraft or people missing) AND the viewer holds
 * org:manage_settings. Once essentials are done the server stops rendering it,
 * so this component never needs to reason about "done" — it only owns dismissal.
 *
 * Dismissal is persisted in localStorage (per-org key) so it stays dismissed
 * across navigations within the session. It reappears in a new browser/profile
 * or if storage is cleared — acceptable for a soft nudge (never blocks anything).
 *
 * Subtle by design: a single hairline card matching the design system, not an
 * attention-grabbing alert.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, X } from 'lucide-react';

export function SetupBanner({ slug }: { slug: string }) {
  const storageKey = `aeroops:setup-banner-dismissed:${slug}`;
  const [dismissed, setDismissed] = React.useState(true); // start hidden to avoid flash

  React.useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(storageKey) === '1');
    } catch {
      setDismissed(false); // storage unavailable → show the nudge
    }
  }, [storageKey]);

  if (dismissed) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(storageKey, '1');
    } catch {
      // ignore — dismissal just won't persist
    }
    setDismissed(true);
  }

  return (
    <div
      className="flex items-center gap-3 rounded-md border border-brand/20 bg-brand/5 px-4 py-3"
      role="note"
    >
      <div className="min-w-0 flex-1">
        <Link
          href={`/o/${slug}/setup`}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-ink underline-offset-2 hover:underline"
        >
          Finish setting up your operation
          <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
        <p className="mt-0.5 text-xs text-slate-500">
          Add your aircraft and team to start scheduling.
        </p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 rounded-sm p-1 text-slate-400 transition-colors hover:bg-brand/10 hover:text-slate-600 focus:outline-none focus:ring-2 focus:ring-brand"
        aria-label="Dismiss setup reminder"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
