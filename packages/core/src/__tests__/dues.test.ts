import { describe, it, expect } from 'vitest';
import {
  isDuesScheduleDue,
  duesChargesPerYear,
  recurringChargeNoun,
  DUES_CADENCES,
  duesMonthName,
  duesCadenceSuffix,
  duesCadenceLabel,
} from '../dues.js';

describe('isDuesScheduleDue', () => {
  it('monthly is always due, regardless of anchor', () => {
    for (let m = 1; m <= 12; m++) {
      expect(isDuesScheduleDue('monthly', null, m)).toBe(true);
      expect(isDuesScheduleDue('monthly', 7, m)).toBe(true);
    }
  });

  it('annual is due only in its anchor month', () => {
    const anchor = 7;
    for (let m = 1; m <= 12; m++) {
      expect(isDuesScheduleDue('annual', anchor, m)).toBe(m === anchor);
    }
  });

  it('quarterly is due every 3rd month from the anchor', () => {
    // anchor Jan → Jan, Apr, Jul, Oct
    const due = [1, 4, 7, 10];
    for (let m = 1; m <= 12; m++) {
      expect(isDuesScheduleDue('quarterly', 1, m)).toBe(due.includes(m));
    }
    // anchor Mar → Mar, Jun, Sep, Dec
    expect(isDuesScheduleDue('quarterly', 3, 3)).toBe(true);
    expect(isDuesScheduleDue('quarterly', 3, 6)).toBe(true);
    expect(isDuesScheduleDue('quarterly', 3, 12)).toBe(true);
    expect(isDuesScheduleDue('quarterly', 3, 4)).toBe(false);
  });

  it('semiannual is due twice a year, 6 months apart', () => {
    // anchor Mar → Mar + Sep
    const due = [3, 9];
    for (let m = 1; m <= 12; m++) {
      expect(isDuesScheduleDue('semiannual', 3, m)).toBe(due.includes(m));
    }
  });

  it('a non-monthly schedule with a missing anchor never bills (fail-safe)', () => {
    for (let m = 1; m <= 12; m++) {
      expect(isDuesScheduleDue('annual', null, m)).toBe(false);
      expect(isDuesScheduleDue('quarterly', undefined, m)).toBe(false);
    }
  });

  it('each cadence fires the right number of times across a full year', () => {
    for (const cadence of DUES_CADENCES) {
      const anchor = 5;
      let hits = 0;
      for (let m = 1; m <= 12; m++) {
        if (isDuesScheduleDue(cadence, anchor, m)) hits++;
      }
      expect(hits).toBe(duesChargesPerYear(cadence));
    }
  });
});

describe('recurringChargeNoun', () => {
  it('a school shows Tuition, a club shows Dues', () => {
    expect(recurringChargeNoun('school')).toBe('Tuition');
    expect(recurringChargeNoun('club')).toBe('Dues');
  });
});

describe('cadence formatters', () => {
  it('duesMonthName maps 1-12 to English names, falls back otherwise', () => {
    expect(duesMonthName(1)).toBe('January');
    expect(duesMonthName(7)).toBe('July');
    expect(duesMonthName(12)).toBe('December');
    expect(duesMonthName(0)).toBe('0');
    expect(duesMonthName(13)).toBe('13');
  });

  it('duesCadenceSuffix: monthly drops the month, non-monthly appends it', () => {
    expect(duesCadenceSuffix('monthly', null)).toBe('/ month');
    expect(duesCadenceSuffix('annual', 7)).toBe('/ year (July)');
    expect(duesCadenceSuffix('quarterly', 3)).toBe('/ quarter (March)');
    // a non-monthly cadence with no anchor degrades to the bare unit.
    expect(duesCadenceSuffix('annual', null)).toBe('/ year');
  });

  it('duesCadenceLabel: monthly is bare, non-monthly carries the month', () => {
    expect(duesCadenceLabel('monthly', null)).toBe('Monthly');
    expect(duesCadenceLabel('annual', 7)).toBe('Annual (July)');
    expect(duesCadenceLabel('semiannual', 3)).toBe('Twice a year (March)');
  });
});
