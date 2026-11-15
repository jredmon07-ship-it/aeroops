/**
 * module-flags.test.ts — Pure unit tests for isModuleOn (module-flags.ts), the
 * check the Portal's "My training", the member Training card and the Reports
 * "Training throughput" section use to follow the Training module.
 *
 * The bug: with Training off (club mode) the nav hid Training, but those three
 * sections still rendered, empty.
 *
 * COVERAGE:
 *   1. Club preset → Training off; school preset / all enabled → on
 *   2. A failed flags read (null/undefined) fails soft to on, like the nav
 *   3. Same answer as the nav: for a role that holds every capability (owner),
 *      isModuleOn(flags, item.module) === "the nav shows the item", for every
 *      module nav item and every flag set
 *
 * PURE: no DOM, no Next.js, no DB.
 */

import { describe, it, expect } from 'vitest';
import { ALL_MODULES_ENABLED, OPERATING_MODE_PRESETS, ORG_MODULES } from '@aeroops/core';
import type { OrgFeatureFlags } from '@aeroops/core';
import type { AppSession } from '@aeroops/api';
import { filterNavForSession, NAV_ITEMS } from '@/lib/nav';
import { isModuleOn } from '../module-flags';

const allOff = Object.fromEntries(ORG_MODULES.map((m) => [m, false])) as OrgFeatureFlags;

describe('1. presets', () => {
  it('club mode turns Training off and leaves the portal and reports on', () => {
    const club = OPERATING_MODE_PRESETS.club;
    expect(isModuleOn(club, 'training')).toBe(false);
    expect(isModuleOn(club, 'portal')).toBe(true);
    expect(isModuleOn(club, 'reports')).toBe(true);
  });

  it('school mode and all-enabled keep every module on', () => {
    for (const m of ORG_MODULES) {
      expect(isModuleOn(OPERATING_MODE_PRESETS.school, m), m).toBe(true);
      expect(isModuleOn(ALL_MODULES_ENABLED, m), m).toBe(true);
    }
  });

  it('each flag decides only its own module', () => {
    expect(isModuleOn({ ...ALL_MODULES_ENABLED, training: false }, 'training')).toBe(false);
    expect(isModuleOn({ ...ALL_MODULES_ENABLED, training: false }, 'reports')).toBe(true);
    expect(isModuleOn({ ...allOff, training: true }, 'training')).toBe(true);
  });
});

describe('2. a failed flags read fails soft to on', () => {
  it('null and undefined → on, for every module', () => {
    for (const m of ORG_MODULES) {
      expect(isModuleOn(null, m), m).toBe(true);
      expect(isModuleOn(undefined, m), m).toBe(true);
    }
  });
});

describe('3. same module check as the nav', () => {
  const owner: AppSession = {
    userId: 'user-uuid-test',
    orgId: 'org-uuid-test',
    slug: 'test-org',
    role: 'owner',
    user: { email: 'owner@example.com' },
  };
  const moduleItems = NAV_ITEMS.flatMap((i) => (i.module ? [{ ...i, module: i.module }] : []));

  it('the nav has a Training item to agree with', () => {
    expect(moduleItems.some((i) => i.module === 'training')).toBe(true);
  });

  it('agrees with filterNavForSession for every module item and flag set', () => {
    const flagSets: OrgFeatureFlags[] = [
      ALL_MODULES_ENABLED,
      OPERATING_MODE_PRESETS.club,
      allOff,
      { ...ALL_MODULES_ENABLED, training: false },
    ];
    for (const flags of flagSets) {
      const shown = new Set(filterNavForSession(owner, NAV_ITEMS, '[slug]', flags).map((i) => i.href));
      for (const item of moduleItems) {
        expect(isModuleOn(flags, item.module), item.label).toBe(shown.has(item.href));
      }
    }
  });
});
