/**
 * nav.test.ts — Pure unit tests for filterNavForSession (lib/nav.ts).
 *
 * COVERAGE:
 *
 *   1. Null/undefined session → returns [] (no nav items for unauthenticated)
 *   2. owner → gets Dashboard + Org settings (both capabilities)
 *   3. manager → gets Dashboard + Org settings (both capabilities)
 *   4. All 6 restricted roles → get Dashboard only (no Org settings in nav)
 *   5. Slug substitution: [slug] in hrefs is replaced with the actual slug
 *   6. The filtered output preserves label and requiredCapability fields
 *   7. Custom items list (not the default NAV_ITEMS) works correctly
 *   8. Items that session lacks capability for are completely absent (not just hidden)
 *   9. Empty items array → returns []
 *  10. AUTHZ NOTE verification: nav uses hasCapability (UX predicate) not requireCapability (gate)
 *
 * These are PURE unit tests — no DOM, no Next.js, no DB.
 *
 * AUTHZ NOTE (from lib/nav.ts):
 *   filterNavForSession is a UX/nav convenience ONLY.
 *   The real gate is requireCapability() in each protected route handler.
 *   Removing a nav link is cosmetic; direct URL access is blocked server-side.
 */

import { describe, it, expect } from 'vitest';
import { MEMBERSHIP_ROLES } from '@aeroops/core';
import type { MembershipRole } from '@aeroops/core';
import type { AppSession } from '@aeroops/api';
import { filterNavForSession, NAV_ITEMS } from '../nav';
import type { NavItem } from '../nav';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(role: MembershipRole, overrides?: Partial<AppSession>): AppSession {
  return {
    userId: 'user-uuid-test',
    orgId: 'org-uuid-test',
    slug: 'test-org',
    role,
    user: { email: 'test@example.com' },
    ...overrides,
  };
}

// The two roles that should see Org settings in nav
const PERMITTED_ROLES: MembershipRole[] = ['owner', 'manager'];

// The six roles that should NOT see Org settings in nav (lack org:manage_settings)
const RESTRICTED_ROLES: MembershipRole[] = [
  'dispatcher',
  'cfi',
  'mechanic',
  'renter',
  'student',
  'accountant',
];

// Expected nav labels per role, derived from the RBAC matrix (packages/core
// capabilities.ts) against the Slice-2c NAV_ITEMS:
//   Dashboard      app:access              → all roles
//   Reservations   schedule:access         → owner, manager, dispatcher, cfi
//   Board          schedule:access         → owner, manager, dispatcher, cfi
//   Resources      schedule:manage_resources → owner, manager, dispatcher
//   Org settings   org:manage_settings     → owner, manager
// Order matches NAV_ITEMS order.
const EXPECTED_LABELS: Record<MembershipRole, string[]> = {
  owner: ['Dashboard', 'Reservations', 'Board', 'Resources', 'Org settings'],
  manager: ['Dashboard', 'Reservations', 'Board', 'Resources', 'Org settings'],
  dispatcher: ['Dashboard', 'Reservations', 'Board', 'Resources'],
  cfi: ['Dashboard', 'Reservations', 'Board'],
  mechanic: ['Dashboard'],
  renter: ['Dashboard'],
  student: ['Dashboard'],
  accountant: ['Dashboard'],
};

// ═════════════════════════════════════════════════════════════════════════════
// 1. Null/undefined session
// ═════════════════════════════════════════════════════════════════════════════

describe('1. null/undefined session → empty nav', () => {
  it('null session returns [] (no nav items for unauthenticated)', () => {
    const result = filterNavForSession(null, NAV_ITEMS, 'acme');
    expect(result).toEqual([]);
  });

  it('undefined session returns [] (no nav items for unauthenticated)', () => {
    const result = filterNavForSession(undefined, NAV_ITEMS, 'acme');
    expect(result).toEqual([]);
  });

  it('null session returns [] even if slug is provided', () => {
    const result = filterNavForSession(null, NAV_ITEMS, 'some-org');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. owner → Dashboard + Org settings
// ═════════════════════════════════════════════════════════════════════════════

describe('2. owner gets Dashboard and Org settings', () => {
  const session = makeSession('owner');
  const result = filterNavForSession(session, NAV_ITEMS, 'acme');

  it('returns exactly 5 items (full Slice-2c nav)', () => {
    expect(result.length).toBe(5);
  });

  it('includes Dashboard', () => {
    const labels = result.map((i) => i.label);
    expect(labels).toContain('Dashboard');
  });

  it('includes Org settings', () => {
    const labels = result.map((i) => i.label);
    expect(labels).toContain('Org settings');
  });

  it('Dashboard comes before Org settings (order preserved)', () => {
    const labels = result.map((i) => i.label);
    const dashIdx = labels.indexOf('Dashboard');
    const settingsIdx = labels.indexOf('Org settings');
    expect(dashIdx).toBeLessThan(settingsIdx);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. manager → Dashboard + Org settings
// ═════════════════════════════════════════════════════════════════════════════

describe('3. manager gets Dashboard and Org settings', () => {
  const session = makeSession('manager');
  const result = filterNavForSession(session, NAV_ITEMS, 'acme');

  it('returns exactly 5 items (full Slice-2c nav)', () => {
    expect(result.length).toBe(5);
  });

  it('includes Dashboard', () => {
    const labels = result.map((i) => i.label);
    expect(labels).toContain('Dashboard');
  });

  it('includes Org settings', () => {
    const labels = result.map((i) => i.label);
    expect(labels).toContain('Org settings');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Restricted roles → Dashboard only, no Org settings
// ═════════════════════════════════════════════════════════════════════════════

describe('4. Roles without org:manage_settings never get Org settings in nav', () => {
  for (const role of RESTRICTED_ROLES) {
    describe(`role: ${role}`, () => {
      const session = makeSession(role);
      const result = filterNavForSession(session, NAV_ITEMS, 'acme');

      it(`${role} gets exactly its RBAC-derived nav items`, () => {
        expect(result.map((i) => i.label)).toEqual(EXPECTED_LABELS[role]);
      });

      it(`${role} always gets Dashboard first`, () => {
        expect(result[0]?.label).toBe('Dashboard');
      });

      it(`${role} does NOT get Org settings in nav`, () => {
        const labels = result.map((i) => i.label);
        expect(labels).not.toContain('Org settings');
      });

      it(`${role} Org settings item is completely absent from result array`, () => {
        const settingsItem = result.find((i) => i.href.endsWith('/settings'));
        expect(settingsItem).toBeUndefined();
      });
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Slug substitution — [slug] in hrefs is replaced with the actual slug
// ═════════════════════════════════════════════════════════════════════════════

describe('5. Slug substitution — [slug] replaced with actual org slug', () => {
  it('Dashboard href uses the provided slug (not [slug] literal)', () => {
    const session = makeSession('student');
    const result = filterNavForSession(session, NAV_ITEMS, 'my-org');
    const dashboard = result.find((i) => i.label === 'Dashboard');
    expect(dashboard?.href).toBe('/o/my-org');
    expect(dashboard?.href).not.toContain('[slug]');
  });

  it('Org settings href uses the provided slug (owner role)', () => {
    const session = makeSession('owner');
    const result = filterNavForSession(session, NAV_ITEMS, 'sky-club');
    const settings = result.find((i) => i.label === 'Org settings');
    expect(settings?.href).toBe('/o/sky-club/settings');
    expect(settings?.href).not.toContain('[slug]');
  });

  it('slug with hyphens is handled correctly', () => {
    const session = makeSession('manager');
    const result = filterNavForSession(session, NAV_ITEMS, 'alpha-flight-school');
    const dashboard = result.find((i) => i.label === 'Dashboard');
    const settings = result.find((i) => i.label === 'Org settings');
    expect(dashboard?.href).toBe('/o/alpha-flight-school');
    expect(settings?.href).toBe('/o/alpha-flight-school/settings');
  });

  it('different slug values produce different hrefs', () => {
    const session = makeSession('owner');
    const resultA = filterNavForSession(session, NAV_ITEMS, 'org-a');
    const resultB = filterNavForSession(session, NAV_ITEMS, 'org-b');
    const settingsA = resultA.find((i) => i.label === 'Org settings');
    const settingsB = resultB.find((i) => i.label === 'Org settings');
    expect(settingsA?.href).toBe('/o/org-a/settings');
    expect(settingsB?.href).toBe('/o/org-b/settings');
    expect(settingsA?.href).not.toBe(settingsB?.href);
  });

  it('[slug] literal is never present in any returned href', () => {
    const session = makeSession('owner');
    const result = filterNavForSession(session, NAV_ITEMS, 'my-fbo');
    for (const item of result) {
      expect(item.href).not.toContain('[slug]');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Filtered output preserves label and requiredCapability fields
// ═════════════════════════════════════════════════════════════════════════════

describe('6. Filtered output preserves label and requiredCapability fields', () => {
  it('Dashboard item has correct requiredCapability = app:access', () => {
    const session = makeSession('student');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme');
    const dashboard = result.find((i) => i.label === 'Dashboard');
    expect(dashboard?.requiredCapability).toBe('app:access');
  });

  it('Org settings item has correct requiredCapability = org:manage_settings', () => {
    const session = makeSession('owner');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme');
    const settings = result.find((i) => i.label === 'Org settings');
    expect(settings?.requiredCapability).toBe('org:manage_settings');
  });

  it('items are new objects (slug-replaced copy, not original NAV_ITEMS reference)', () => {
    const session = makeSession('owner');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme');
    // The returned items should be new objects (spread) with mutated href
    for (const item of result) {
      const original = NAV_ITEMS.find((n) => n.label === item.label);
      expect(original).toBeDefined();
      // Original still has [slug] in href; returned item has it replaced
      if (original?.href.includes('[slug]')) {
        expect(item.href).not.toBe(original.href);
        expect(item.href).not.toContain('[slug]');
      }
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Custom items list works correctly
// ═════════════════════════════════════════════════════════════════════════════

describe('7. Custom items list (not default NAV_ITEMS)', () => {
  const customItems: readonly NavItem[] = [
    { label: 'Home', href: '/o/[slug]', requiredCapability: 'app:access' },
    { label: 'Admin', href: '/o/[slug]/admin', requiredCapability: 'org:manage_settings' },
    { label: 'Other', href: '/o/[slug]/other', requiredCapability: 'app:access' },
  ] as const;

  it('student sees Home and Other but not Admin', () => {
    const session = makeSession('student');
    const result = filterNavForSession(session, customItems, 'acme');
    const labels = result.map((i) => i.label);
    expect(labels).toContain('Home');
    expect(labels).toContain('Other');
    expect(labels).not.toContain('Admin');
  });

  it('owner sees all 3 custom items', () => {
    const session = makeSession('owner');
    const result = filterNavForSession(session, customItems, 'acme');
    expect(result.length).toBe(3);
  });

  it('slug is substituted in all custom hrefs', () => {
    const session = makeSession('owner');
    const result = filterNavForSession(session, customItems, 'test-org');
    for (const item of result) {
      expect(item.href).not.toContain('[slug]');
      expect(item.href).toContain('test-org');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Items completely absent when capability missing
// ═════════════════════════════════════════════════════════════════════════════

describe('8. Items that session lacks are completely absent (not just hidden)', () => {
  it('no undefined items in restricted role result', () => {
    const session = makeSession('dispatcher');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme');
    for (const item of result) {
      expect(item).toBeDefined();
      expect(item.label).toBeDefined();
      expect(item.href).toBeDefined();
    }
  });

  it('result array has no "holes" for restricted capabilities', () => {
    const session = makeSession('renter');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme');
    // Should be a clean [Dashboard] array, no gap/null for Org settings
    expect(result.length).toBe(1);
    expect(result[0]).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9. Empty items array → returns []
// ═════════════════════════════════════════════════════════════════════════════

describe('9. Empty items array → always returns []', () => {
  it('owner with empty items returns []', () => {
    const session = makeSession('owner');
    const result = filterNavForSession(session, [], 'acme');
    expect(result).toEqual([]);
  });

  it('null session with empty items returns []', () => {
    const result = filterNavForSession(null, [], 'acme');
    expect(result).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10. Consistency: filterNavForSession result matches hasCapability predictions
// ═════════════════════════════════════════════════════════════════════════════

describe('10. All 8 roles: filterNavForSession is consistent with RBAC matrix', () => {
  for (const role of MEMBERSHIP_ROLES) {
    it(`role ${role}: nav items match expected RBAC access`, () => {
      const session = makeSession(role);
      const result = filterNavForSession(session, NAV_ITEMS, 'acme');
      const labels = result.map((i) => i.label);

      // Exact, order-preserving match against the RBAC-derived expectation.
      expect(labels).toEqual(EXPECTED_LABELS[role]);

      // All 8 roles have app:access → always get Dashboard.
      expect(labels).toContain('Dashboard');

      // Org settings visibility tracks org:manage_settings (owner + manager only).
      if (PERMITTED_ROLES.includes(role)) {
        expect(labels).toContain('Org settings');
      } else {
        expect(labels).not.toContain('Org settings');
      }
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 11. NAV_ITEMS registry validation
// ═════════════════════════════════════════════════════════════════════════════

describe('11. NAV_ITEMS registry', () => {
  it('NAV_ITEMS has exactly 5 items (Slice 2c — Dashboard, Reservations, Board, Resources, Org settings)', () => {
    expect(NAV_ITEMS.length).toBe(5);
  });

  it('first item is Dashboard with app:access', () => {
    expect(NAV_ITEMS[0]?.label).toBe('Dashboard');
    expect(NAV_ITEMS[0]?.requiredCapability).toBe('app:access');
    expect(NAV_ITEMS[0]?.href).toContain('[slug]');
  });

  it('Reservations item is gated by schedule:access', () => {
    const reservations = NAV_ITEMS.find((i) => i.label === 'Reservations');
    expect(reservations?.requiredCapability).toBe('schedule:access');
    expect(reservations?.href).toBe('/o/[slug]/schedule');
  });

  it('Board item is gated by schedule:access and placed after Reservations', () => {
    const board = NAV_ITEMS.find((i) => i.label === 'Board');
    expect(board?.requiredCapability).toBe('schedule:access');
    expect(board?.href).toBe('/o/[slug]/schedule/board');
    const reservationsIdx = NAV_ITEMS.findIndex((i) => i.label === 'Reservations');
    const boardIdx = NAV_ITEMS.findIndex((i) => i.label === 'Board');
    expect(boardIdx).toBeGreaterThan(reservationsIdx);
  });

  it('Resources item is gated by schedule:manage_resources', () => {
    const resources = NAV_ITEMS.find((i) => i.label === 'Resources');
    expect(resources?.requiredCapability).toBe('schedule:manage_resources');
    expect(resources?.href).toBe('/o/[slug]/schedule/resources');
  });

  it('last item is Org settings with org:manage_settings', () => {
    const last = NAV_ITEMS[NAV_ITEMS.length - 1];
    expect(last?.label).toBe('Org settings');
    expect(last?.requiredCapability).toBe('org:manage_settings');
    expect(last?.href).toContain('[slug]');
    expect(last?.href).toContain('settings');
  });

  it('all NAV_ITEMS have [slug] placeholder in href', () => {
    for (const item of NAV_ITEMS) {
      expect(item.href).toContain('[slug]');
    }
  });
});
