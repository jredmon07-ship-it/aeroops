/**
 * toast-store.test.ts — unit tests for the pure toast store (design-system
 * core). No React, no DOM — node env.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  createToastStore,
  toast,
  toastStore,
  TOAST_DURATION_MS,
  MAX_VISIBLE_TOASTS,
} from '../toast-store';

describe('createToastStore', () => {
  it('starts empty', () => {
    const store = createToastStore();
    expect(store.getSnapshot()).toEqual([]);
  });

  it('add() appends a toast with kind + message and returns its id', () => {
    const store = createToastStore();
    const id = store.add('success', 'Payment recorded.');
    const snapshot = store.getSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toEqual({ id, kind: 'success', message: 'Payment recorded.' });
  });

  it('assigns unique, increasing ids', () => {
    const store = createToastStore();
    const a = store.add('info', 'a');
    const b = store.add('info', 'b');
    expect(b).toBeGreaterThan(a);
  });

  it('dismiss() removes only the matching toast', () => {
    const store = createToastStore();
    const a = store.add('success', 'a');
    const b = store.add('error', 'b');
    store.dismiss(a);
    const snapshot = store.getSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.id).toBe(b);
  });

  it('dismiss() of an unknown id is a no-op and does not notify', () => {
    const store = createToastStore();
    store.add('success', 'a');
    const listener = vi.fn();
    store.subscribe(listener);
    store.dismiss(999);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toHaveLength(1);
  });

  it('caps the stack at MAX_VISIBLE_TOASTS, dropping the oldest', () => {
    const store = createToastStore();
    for (let i = 0; i < MAX_VISIBLE_TOASTS + 2; i++) {
      store.add('info', `t${i}`);
    }
    const snapshot = store.getSnapshot();
    expect(snapshot).toHaveLength(MAX_VISIBLE_TOASTS);
    expect(snapshot[0]?.message).toBe('t2'); // t0, t1 dropped
  });

  it('notifies subscribers on add and dismiss; unsubscribe stops notifications', () => {
    const store = createToastStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    const id = store.add('warning', 'w');
    expect(listener).toHaveBeenCalledTimes(1);

    store.dismiss(id);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    store.add('info', 'i');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('getSnapshot() returns a stable reference between changes (useSyncExternalStore contract)', () => {
    const store = createToastStore();
    store.add('success', 'a');
    const first = store.getSnapshot();
    const second = store.getSnapshot();
    expect(first).toBe(second);
    store.add('success', 'b');
    expect(store.getSnapshot()).not.toBe(first);
  });
});

describe('toast API (singleton)', () => {
  it('toast.success/error/info/warning add to the singleton store with the right kind', () => {
    const before = toastStore.getSnapshot().length;
    const ids = [
      toast.success('s'),
      toast.error('e'),
      toast.info('i'),
      toast.warning('w'),
    ];
    const snapshot = toastStore.getSnapshot();
    // The cap may trim; the newest 4 must be ours, in order.
    const newest = snapshot.slice(-Math.min(4, snapshot.length));
    expect(newest.map((t) => t.kind)).toEqual(['success', 'error', 'info', 'warning']);
    expect(snapshot.length).toBeLessThanOrEqual(Math.max(before + 4, MAX_VISIBLE_TOASTS));
    // Cleanup so other tests see an empty singleton.
    for (const id of ids) toastStore.dismiss(id);
  });
});

describe('TOAST_DURATION_MS', () => {
  it('errors and warnings linger at least as long as confirmations', () => {
    expect(TOAST_DURATION_MS.error).toBeGreaterThanOrEqual(TOAST_DURATION_MS.success);
    expect(TOAST_DURATION_MS.warning).toBeGreaterThanOrEqual(TOAST_DURATION_MS.info);
  });

  it('every kind has a positive duration', () => {
    for (const ms of Object.values(TOAST_DURATION_MS)) {
      expect(ms).toBeGreaterThan(0);
    }
  });
});
