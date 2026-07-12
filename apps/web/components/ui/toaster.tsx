/**
 * Toaster — renders the app-wide toast stack (bottom-right, fixed).
 *
 * Mounted ONCE in the authenticated shell layout. Client components fire
 * toasts via the `toast` API in lib/toast-store.ts (pure module); this
 * component subscribes to the singleton store and owns auto-dismiss timing.
 *
 * A11y: polite live region; error toasts are role="alert" (assertive).
 * Each toast has a labelled dismiss button; auto-dismisses per kind.
 */
'use client';

import * as React from 'react';
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-react';
import {
  toastStore,
  TOAST_DURATION_MS,
  type ToastItem,
  type ToastKind,
} from '@/lib/toast-store';
import { cn } from './utils';

const EMPTY: readonly ToastItem[] = [];

const KIND_ICON: Record<ToastKind, React.ElementType> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
  warning: AlertTriangle,
};

const KIND_ICON_CLASS: Record<ToastKind, string> = {
  success: 'text-success',
  error: 'text-danger',
  info: 'text-info',
  warning: 'text-warning',
};

function ToastCard({ item }: { item: ToastItem }) {
  const { id, kind, message } = item;

  // Auto-dismiss per kind.
  React.useEffect(() => {
    const timer = setTimeout(() => toastStore.dismiss(id), TOAST_DURATION_MS[kind]);
    return () => clearTimeout(timer);
  }, [id, kind]);

  const Icon = KIND_ICON[kind];

  return (
    <div
      role={kind === 'error' ? 'alert' : 'status'}
      className={cn(
        'pointer-events-auto flex items-start gap-2.5 rounded-md border border-slate-200',
        'bg-white px-3.5 py-2.5 shadow-md dark:border-slate-800 dark:bg-slate-900',
      )}
    >
      <Icon
        className={cn('mt-0.5 h-4 w-4 shrink-0', KIND_ICON_CLASS[kind])}
        aria-hidden="true"
      />
      <p className="flex-1 text-sm text-slate-700 dark:text-slate-200">{message}</p>
      <button
        type="button"
        onClick={() => toastStore.dismiss(id)}
        aria-label="Dismiss notification"
        className="shrink-0 rounded-sm p-0.5 text-slate-400 transition-colors hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

export function Toaster() {
  const toasts = React.useSyncExternalStore(
    toastStore.subscribe,
    toastStore.getSnapshot,
    () => EMPTY,
  );

  return (
    <div
      aria-live="polite"
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} item={t} />
      ))}
    </div>
  );
}
