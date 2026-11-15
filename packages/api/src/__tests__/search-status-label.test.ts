/**
 * search-status-label.test.ts — the ⌘K palette's second line for work orders,
 * squawks and courses. The results printed the stored enum keys ("in_progress",
 * "high · open"); statusLabel turns them into words.
 *
 * PURE: imports the helper only; no database.
 */
import { describe, it, expect } from 'vitest';
import { WORK_ORDER_STATUSES, SQUAWK_SEVERITIES, SQUAWK_STATUSES } from '@aeroops/core';
import { statusLabel } from '../search/search-org.js';

describe('statusLabel', () => {
  it('turns enum keys into words', () => {
    expect(statusLabel('in_progress')).toBe('In progress');
    expect(statusLabel('open')).toBe('Open');
    expect(statusLabel('high')).toBe('High');
    expect(statusLabel('active')).toBe('Active');
  });

  it('never leaves an underscore or a lower-case first letter for a real status', () => {
    for (const s of [...WORK_ORDER_STATUSES, ...SQUAWK_SEVERITIES, ...SQUAWK_STATUSES]) {
      const label = statusLabel(s);
      expect(label, s).not.toContain('_');
      expect(label.charAt(0), s).toBe(label.charAt(0).toUpperCase());
    }
  });

  it('keeps an empty value empty', () => {
    expect(statusLabel('')).toBe('');
  });
});
