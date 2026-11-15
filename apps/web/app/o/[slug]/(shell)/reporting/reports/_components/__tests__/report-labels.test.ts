/**
 * report-labels.test.ts — Reports' status labels (report-labels.ts).
 *
 * The bug: the Squawks and Maintenance reminders tables printed the raw enum
 * keys ("open", "due soon", "ok"). These pin the labels to the ones the
 * Squawks list and the Maintenance due pages show.
 *
 * PURE: no DOM, no Next.js, no DB.
 */
import { describe, it, expect } from 'vitest';
import { SQUAWK_STATUSES } from '@aeroops/core';
import {
  DUE_STATUS_LABELS,
  SQUAWK_STATUS_LABELS,
  dueStatusLabel,
  squawkStatusLabel,
} from '../report-labels';

describe('squawkStatusLabel', () => {
  it('labels every squawk status', () => {
    expect(Object.keys(SQUAWK_STATUS_LABELS).sort()).toEqual([...SQUAWK_STATUSES].sort());
    expect(squawkStatusLabel('open')).toBe('Open');
    expect(squawkStatusLabel('deferred')).toBe('Deferred');
    expect(squawkStatusLabel('resolved')).toBe('Resolved');
  });

  it('renders an unknown value as itself', () => {
    expect(squawkStatusLabel('archived')).toBe('archived');
  });
});

describe('dueStatusLabel', () => {
  it('labels every reminder status the way the Maintenance pages do', () => {
    expect(Object.keys(DUE_STATUS_LABELS).sort()).toEqual(['due_soon', 'ok', 'overdue', 'unknown']);
    expect(dueStatusLabel('overdue')).toBe('Overdue');
    expect(dueStatusLabel('due_soon')).toBe('Due soon');
    expect(dueStatusLabel('ok')).toBe('OK');
    expect(dueStatusLabel('unknown')).toBe('No meter yet');
  });

  it('never shows an underscore for a known status', () => {
    for (const s of Object.keys(DUE_STATUS_LABELS)) {
      expect(dueStatusLabel(s)).not.toContain('_');
    }
  });

  it('renders an unknown value as itself, and ignores prototype keys', () => {
    expect(dueStatusLabel('paused')).toBe('paused');
    expect(dueStatusLabel('toString')).toBe('toString');
  });
});
