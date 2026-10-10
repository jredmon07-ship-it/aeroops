/**
 * action-feedback.test.ts — unit tests for the standard action-result →
 * user-facing message mapping (toast-on-mutation standard).
 */
import { describe, it, expect } from 'vitest';
import { actionErrorMessage, toastActionError } from '../action-feedback';
import { toastStore } from '../toast-store';

describe('actionErrorMessage', () => {
  it('maps forbidden to a permission message', () => {
    expect(actionErrorMessage({ error: 'forbidden' })).toBe(
      "You don't have permission to do that.",
    );
  });

  it('maps unauthenticated to a session-expired message', () => {
    expect(actionErrorMessage({ error: 'unauthenticated' })).toBe(
      'Your session has expired. Please sign in again.',
    );
  });

  it('surfaces the validation message verbatim', () => {
    expect(
      actionErrorMessage({ error: 'validation', message: 'End must be after start.' }),
    ).toBe('End must be after start.');
  });

  it('falls back when a validation result has no message', () => {
    expect(actionErrorMessage({ error: 'validation' })).toBe(
      'Something went wrong. Please try again.',
    );
    expect(actionErrorMessage({ error: 'validation', message: '' }, 'Custom.')).toBe(
      'Custom.',
    );
  });

  it('maps server (and unknown) errors to the fallback', () => {
    expect(actionErrorMessage({ error: 'server' })).toBe(
      'Something went wrong. Please try again.',
    );
    expect(actionErrorMessage({ error: 'whatever' })).toBe(
      'Something went wrong. Please try again.',
    );
  });

  it('honors a custom fallback', () => {
    expect(actionErrorMessage({ error: 'server' }, "Couldn't save the squawk.")).toBe(
      "Couldn't save the squawk.",
    );
  });
});

describe('toastActionError', () => {
  it('fires an error toast with the mapped message', () => {
    toastActionError({ error: 'forbidden' });
    const snapshot = toastStore.getSnapshot();
    const last = snapshot[snapshot.length - 1];
    expect(last?.kind).toBe('error');
    expect(last?.message).toBe("You don't have permission to do that.");
    if (last) toastStore.dismiss(last.id);
  });
});
