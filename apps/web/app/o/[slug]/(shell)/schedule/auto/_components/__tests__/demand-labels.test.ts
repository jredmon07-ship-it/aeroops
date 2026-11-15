/**
 * demand-labels.test.ts — the auto-scheduler's on-screen demand names.
 *
 * The bug: the "could not be placed" lists printed internal row ids
 * ("demand-7") while the builder above calls the same rows "Session 1..N".
 *
 * PURE: no DOM, no Next.js, no DB.
 */
import { describe, it, expect } from 'vitest';
import { demandLabel, demandLabels } from '../demand-labels';

describe('demandLabels', () => {
  it('names each demand by its position, as the builder does', () => {
    const labels = demandLabels([{ id: 'demand-4' }, { id: 'demand-7' }, { id: 'demand-9' }]);
    expect(labels).toEqual({ 'demand-4': 'Session 1', 'demand-7': 'Session 2', 'demand-9': 'Session 3' });
  });

  it('is empty for no demands', () => {
    expect(demandLabels([])).toEqual({});
  });
});

describe('demandLabel', () => {
  const labels = demandLabels([{ id: 'demand-12' }]);

  it('returns the session name, never the internal id', () => {
    expect(demandLabel(labels, 'demand-12')).toBe('Session 1');
  });

  it('falls back to a neutral name for an unknown id', () => {
    expect(demandLabel(labels, 'demand-99')).toBe('A session');
    expect(demandLabel(labels, 'toString')).toBe('A session');
  });
});
