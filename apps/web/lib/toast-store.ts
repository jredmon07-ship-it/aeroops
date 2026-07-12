/**
 * lib/toast-store.ts — dependency-free toast state + the `toast` API.
 *
 * THE TOAST-ON-MUTATION STANDARD (design-system core):
 *   Every primary mutation gives feedback:
 *     - ok result        → toast.success('Payment recorded')
 *     - error result     → toast.error(actionErrorMessage(result))  — OR keep
 *       the existing inline dialog/form error when one exists (inline beats
 *       toast for correctable input errors; toast is for fire-and-forget
 *       confirmation and errors with no inline surface).
 *   See lib/action-feedback.ts for the result→message mapping.
 *
 * PURE MODULE: no React, no DOM — unit-testable under vitest's node env.
 * The <Toaster /> client component (components/ui/toaster.tsx) subscribes to
 * the singleton store and owns rendering + auto-dismiss timing.
 */

export type ToastKind = 'success' | 'error' | 'info' | 'warning';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

type Listener = () => void;

/** Auto-dismiss durations — errors/warnings linger longer than confirmations. */
export const TOAST_DURATION_MS: Record<ToastKind, number> = {
  success: 4000,
  info: 4000,
  warning: 6000,
  error: 6000,
};

/** Oldest toasts are dropped beyond this cap (keeps the stack scannable). */
export const MAX_VISIBLE_TOASTS = 4;

export interface ToastStore {
  add(kind: ToastKind, message: string): number;
  dismiss(id: number): void;
  subscribe(listener: Listener): () => void;
  /** Stable snapshot reference between changes (useSyncExternalStore contract). */
  getSnapshot(): readonly ToastItem[];
}

export function createToastStore(): ToastStore {
  let nextId = 1;
  let toasts: readonly ToastItem[] = [];
  const listeners = new Set<Listener>();

  function emit() {
    for (const l of listeners) l();
  }

  return {
    add(kind, message) {
      const id = nextId++;
      const appended = [...toasts, { id, kind, message }];
      toasts =
        appended.length > MAX_VISIBLE_TOASTS
          ? appended.slice(appended.length - MAX_VISIBLE_TOASTS)
          : appended;
      emit();
      return id;
    },
    dismiss(id) {
      const remaining = toasts.filter((t) => t.id !== id);
      if (remaining.length === toasts.length) return; // no change, no emit
      toasts = remaining;
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot() {
      return toasts;
    },
  };
}

/** The app-wide singleton the <Toaster /> renders. */
export const toastStore = createToastStore();

/** Fire-and-forget toast API — callable from any client component. */
export const toast = {
  success: (message: string) => toastStore.add('success', message),
  error: (message: string) => toastStore.add('error', message),
  info: (message: string) => toastStore.add('info', message),
  warning: (message: string) => toastStore.add('warning', message),
};
