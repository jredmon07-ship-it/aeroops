/**
 * nav.test.ts — Pure unit tests for filterNavForSession + isPortalOnly (lib/nav.ts).
 *
 * COVERAGE (Slice P1.2 additions in bold; Slice A1.2 additions in brackets;
 *           Slice PB1.2 additions in {braces}):
 *
 *   1. Null/undefined session → returns [] (no nav items for unauthenticated)
 *   2. owner → gets Portal + Dashboard + Org settings (all capabilities)
 *   3. manager → gets Portal + Dashboard + Org settings (all capabilities)
 *   4. Per-role nav: exact RBAC-derived item lists for all 8 roles
 *   5. Slug substitution: [slug] in hrefs is replaced with the actual slug
 *   6. The filtered output preserves label and requiredCapability fields
 *   7. Custom items list (not the default NAV_ITEMS) works correctly
 *   8. Items that session lacks capability for are completely absent (not just hidden)
 *   9. Empty items array → returns []
 *  10. Consistency: filterNavForSession result matches hasCapability predictions
 *  11. NAV_ITEMS registry validation [16 items; Booking requests after Maintenance, Activity after Reports, before Org settings, Help last]
 *  **12. isPortalOnly — truth table for all 8 roles + null/undefined (Slice P1.2)**
 *  **13. Portal visible to student/renter/owner/manager; Dashboard hidden from student/renter**
 *  [14. Activity visible to owner/manager/dispatcher/cfi/accountant; hidden from student/renter/mechanic]
 *  {15. Booking requests visible to owner/manager/dispatcher; hidden from cfi/mechanic/renter/student/accountant}
 *  16. Help — visible to ALL 8 roles (app:access); always the last nav item (Slice P1.8)
 *
 * These are PURE unit tests — no DOM, no Next.js, no DB.
 *
 * AUTHZ NOTE (from lib/nav.ts):
 *   filterNavForSession is a UX/nav convenience ONLY.
 *   The real gate is requireCapability() in each protected route handler.
 *   Removing a nav link is cosmetic; direct URL access is blocked server-side.
 *
 * Slice P1.2 changes applied:
 *   - "Portal" NAV_ITEM added at TOP (portal:access → owner/manager/student/renter).
 *   - "Dashboard" requiredCapability RAISED from app:access to reporting:access.
 *     student/renter no longer see Dashboard in nav; mechanic also loses Dashboard.
 *   - Total NAV_ITEMS: 12 (was 11).
 *   - isPortalOnly(session) exported: true for student/renter only.
 *
 * Slice A1.2 changes applied:
 *   - "Activity" NAV_ITEM added after "Reports" (reporting:access).
 *   - Total NAV_ITEMS: 13 (was 12).
 *
 * Slice PB1.2 changes applied:
 *   - "Booking requests" NAV_ITEM added after "Maintenance" (booking:triage).
 *     owner/manager/dispatcher see it; cfi/mechanic/renter/student/accountant do NOT.
 *   - Total NAV_ITEMS: 14 (was 13).
 *
 * Slice P1.8 changes applied:
 *   - "Help" NAV_ITEM added LAST, after "Org settings" (app:access — every role).
 *   - Total NAV_ITEMS: 16 (was 15).
 */

import { describe, it, expect } from 'vitest';
import { MEMBERSHIP_ROLES, ALL_MODULES_ENABLED } from '@aeroops/core';
import type { MembershipRole, OrgFeatureFlags } from '@aeroops/core';
import type { AppSession } from '@aeroops/api';
import { filterNavForSession, isPortalOnly, landingPathFor, NAV_ITEMS } from '../nav';
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
// capabilities.ts) against the Slice-A1.2 NAV_ITEMS.
//
// Slice P1.2 changes from the prior nav matrix:
//   - Portal (portal:access)        → owner, manager, student, renter.
//   - Dashboard (reporting:access)  → owner, manager, dispatcher, cfi, accountant.
//     RAISED from app:access. student/renter/mechanic NO LONGER see Dashboard.
//
// Slice A1.2 changes from Slice P1.2:
//   - Activity (reporting:access)   → owner, manager, dispatcher, cfi, accountant.
//     Placed after Reports, before Org settings.
//
// Full matrix (items in NAV_ITEMS order):
//   Portal           portal:access               → owner, manager, student, renter
//   Dashboard        reporting:access            → owner, manager, dispatcher, cfi, accountant
//   Reservations     schedule:access             → owner, manager, dispatcher, cfi
//   Board            schedule:access             → owner, manager, dispatcher, cfi
//   Auto-schedule    schedule:create_reservation → owner, manager, dispatcher, cfi
//   Resources        schedule:manage_resources   → owner, manager, dispatcher
//   People           people:access               → owner, manager, dispatcher, cfi
//   Training         training:access             → owner, manager, dispatcher, cfi
//   Fleet            fleet:access                → owner, manager, dispatcher, cfi, mechanic
//   Maintenance      maintenance:access          → owner, manager, dispatcher, cfi, mechanic
//   Booking requests booking:triage              → owner, manager, dispatcher
//   Billing          billing:access              → owner, manager, accountant
//   Reports          reporting:access            → owner, manager, dispatcher, cfi, accountant
//   Activity         reporting:access            → owner, manager, dispatcher, cfi, accountant
//   Org settings     org:manage_settings         → owner, manager
//   Help             app:access                  → ALL 8 roles (Slice P1.8)
const EXPECTED_LABELS: Record<MembershipRole, string[]> = {
  owner:      ['Portal', 'Dashboard', 'Reservations', 'Board', 'Auto-schedule', 'Resources', 'People', 'Training', 'Fleet', 'Maintenance', 'Booking requests', 'Billing', 'Reports', 'Activity', 'Messages', 'Org settings', 'Help'],
  manager:    ['Portal', 'Dashboard', 'Reservations', 'Board', 'Auto-schedule', 'Resources', 'People', 'Training', 'Fleet', 'Maintenance', 'Booking requests', 'Billing', 'Reports', 'Activity', 'Messages', 'Org settings', 'Help'],
  dispatcher: ['Dashboard', 'Reservations', 'Board', 'Auto-schedule', 'Resources', 'People', 'Training', 'Fleet', 'Maintenance', 'Booking requests', 'Reports', 'Activity', 'Help'],
  cfi:        ['Dashboard', 'Reservations', 'Board', 'Auto-schedule', 'People', 'Training', 'Fleet', 'Maintenance', 'Reports', 'Activity', 'Help'],
  mechanic:   ['Fleet', 'Maintenance', 'Help'],
  renter:     ['Portal', 'Help'],
  student:    ['Portal', 'Help'],
  accountant: ['Dashboard', 'Billing', 'Reports', 'Activity', 'Help'],
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
// 2. owner → Portal + Dashboard + Org settings (all capabilities)
// ═════════════════════════════════════════════════════════════════════════════

describe('2. owner gets Portal + Dashboard and Org settings', () => {
  const session = makeSession('owner');
  const result = filterNavForSession(session, NAV_ITEMS, 'acme');

  it('returns exactly 17 items (full nav incl. Portal + Dashboard + Booking requests + Billing + Activity + Messages + Help + all staff items)', () => {
    expect(result.length).toBe(17);
  });

  it('includes Portal (first item for owner)', () => {
    const labels = result.map((i) => i.label);
    expect(labels).toContain('Portal');
    expect(labels[0]).toBe('Portal');
  });

  it('includes Dashboard', () => {
    const labels = result.map((i) => i.label);
    expect(labels).toContain('Dashboard');
  });

  it('includes Org settings', () => {
    const labels = result.map((i) => i.label);
    expect(labels).toContain('Org settings');
  });

  it('includes Training', () => {
    const labels = result.map((i) => i.label);
    expect(labels).toContain('Training');
  });

  it('Portal comes before Dashboard comes before Org settings (order preserved)', () => {
    const labels = result.map((i) => i.label);
    const portalIdx = labels.indexOf('Portal');
    const dashIdx = labels.indexOf('Dashboard');
    const settingsIdx = labels.indexOf('Org settings');
    expect(portalIdx).toBeLessThan(dashIdx);
    expect(dashIdx).toBeLessThan(settingsIdx);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. manager → Portal + Dashboard + Org settings
// ═════════════════════════════════════════════════════════════════════════════

describe('3. manager gets Portal + Dashboard and Org settings', () => {
  const session = makeSession('manager');
  const result = filterNavForSession(session, NAV_ITEMS, 'acme');

  it('returns exactly 17 items (full nav)', () => {
    expect(result.length).toBe(17);
  });

  it('includes Portal', () => {
    expect(result.map((i) => i.label)).toContain('Portal');
  });

  it('includes Dashboard', () => {
    expect(result.map((i) => i.label)).toContain('Dashboard');
  });

  it('includes Org settings', () => {
    expect(result.map((i) => i.label)).toContain('Org settings');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Restricted roles → correct per-role nav, no Org settings
// ═════════════════════════════════════════════════════════════════════════════

describe('4. Roles without org:manage_settings never get Org settings in nav', () => {
  for (const role of RESTRICTED_ROLES) {
    describe(`role: ${role}`, () => {
      const session = makeSession(role);
      const result = filterNavForSession(session, NAV_ITEMS, 'acme');

      it(`${role} gets exactly its RBAC-derived nav items`, () => {
        expect(result.map((i) => i.label)).toEqual(EXPECTED_LABELS[role]);
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
  it('Portal href uses the provided slug (not [slug] literal)', () => {
    const session = makeSession('student');
    const result = filterNavForSession(session, NAV_ITEMS, 'my-org');
    const portal = result.find((i) => i.label === 'Portal');
    expect(portal?.href).toBe('/o/my-org/portal');
    expect(portal?.href).not.toContain('[slug]');
  });

  it('Dashboard href uses the provided slug (owner role)', () => {
    const session = makeSession('owner');
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
    const portal = result.find((i) => i.label === 'Portal');
    const dashboard = result.find((i) => i.label === 'Dashboard');
    const settings = result.find((i) => i.label === 'Org settings');
    expect(portal?.href).toBe('/o/alpha-flight-school/portal');
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
  it('Portal item has correct requiredCapability = portal:access', () => {
    const session = makeSession('student');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme');
    const portal = result.find((i) => i.label === 'Portal');
    expect(portal?.requiredCapability).toBe('portal:access');
  });

  it('Dashboard item has correct requiredCapability = reporting:access (RAISED from app:access in P1.2)', () => {
    const session = makeSession('owner');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme');
    const dashboard = result.find((i) => i.label === 'Dashboard');
    expect(dashboard?.requiredCapability).toBe('reporting:access');
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
    for (const item of result) {
      const original = NAV_ITEMS.find((n) => n.label === item.label);
      expect(original).toBeDefined();
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

  it('student result has exactly 2 items (Portal + Help)', () => {
    const session = makeSession('student');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme');
    expect(result.length).toBe(2);
    expect(result.map((i) => i.label)).toEqual(['Portal', 'Help']);
  });

  it('renter result has exactly 2 items (Portal + Help)', () => {
    const session = makeSession('renter');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme');
    expect(result.length).toBe(2);
    expect(result.map((i) => i.label)).toEqual(['Portal', 'Help']);
  });

  it('mechanic result has exactly 3 items (Fleet + Maintenance + Help)', () => {
    const session = makeSession('mechanic');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme');
    expect(result.length).toBe(3);
    expect(result.map((i) => i.label)).toEqual(['Fleet', 'Maintenance', 'Help']);
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
  it('NAV_ITEMS has exactly 17 items (Portal + Dashboard + Booking requests + Billing + Activity + Messages + Help + 10 staff items)', () => {
    expect(NAV_ITEMS.length).toBe(17);
  });

  it('first item is Portal with portal:access (Slice P1.2 addition)', () => {
    expect(NAV_ITEMS[0]?.label).toBe('Portal');
    expect(NAV_ITEMS[0]?.requiredCapability).toBe('portal:access');
    expect(NAV_ITEMS[0]?.href).toBe('/o/[slug]/portal');
  });

  it('second item is Dashboard with reporting:access (RAISED from app:access in Slice P1.2)', () => {
    expect(NAV_ITEMS[1]?.label).toBe('Dashboard');
    expect(NAV_ITEMS[1]?.requiredCapability).toBe('reporting:access');
    expect(NAV_ITEMS[1]?.href).toBe('/o/[slug]');
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

  it('Auto-schedule item is gated by schedule:create_reservation and placed after Board, before Resources', () => {
    const autoSchedule = NAV_ITEMS.find((i) => i.label === 'Auto-schedule');
    expect(autoSchedule?.requiredCapability).toBe('schedule:create_reservation');
    expect(autoSchedule?.href).toBe('/o/[slug]/schedule/auto');
    const boardIdx = NAV_ITEMS.findIndex((i) => i.label === 'Board');
    const autoIdx = NAV_ITEMS.findIndex((i) => i.label === 'Auto-schedule');
    const resourcesIdx = NAV_ITEMS.findIndex((i) => i.label === 'Resources');
    expect(autoIdx).toBeGreaterThan(boardIdx);
    expect(autoIdx).toBeLessThan(resourcesIdx);
  });

  it('Resources item is gated by schedule:manage_resources', () => {
    const resources = NAV_ITEMS.find((i) => i.label === 'Resources');
    expect(resources?.requiredCapability).toBe('schedule:manage_resources');
    expect(resources?.href).toBe('/o/[slug]/schedule/resources');
  });

  it('People item is gated by people:access and placed after Resources and before Training', () => {
    const people = NAV_ITEMS.find((i) => i.label === 'People');
    expect(people?.requiredCapability).toBe('people:access');
    expect(people?.href).toBe('/o/[slug]/people');
    const resourcesIdx = NAV_ITEMS.findIndex((i) => i.label === 'Resources');
    const peopleIdx = NAV_ITEMS.findIndex((i) => i.label === 'People');
    const trainingIdx = NAV_ITEMS.findIndex((i) => i.label === 'Training');
    expect(peopleIdx).toBeGreaterThan(resourcesIdx);
    expect(peopleIdx).toBeLessThan(trainingIdx);
  });

  it('Training item is gated by training:access and placed after People and before Fleet', () => {
    const training = NAV_ITEMS.find((i) => i.label === 'Training');
    expect(training?.requiredCapability).toBe('training:access');
    expect(training?.href).toBe('/o/[slug]/training');
    const peopleIdx = NAV_ITEMS.findIndex((i) => i.label === 'People');
    const trainingIdx = NAV_ITEMS.findIndex((i) => i.label === 'Training');
    const fleetIdx = NAV_ITEMS.findIndex((i) => i.label === 'Fleet');
    expect(trainingIdx).toBeGreaterThan(peopleIdx);
    expect(trainingIdx).toBeLessThan(fleetIdx);
  });

  it('Maintenance item is gated by maintenance:access and links to work-orders (M1.3)', () => {
    const maintenance = NAV_ITEMS.find((i) => i.label === 'Maintenance');
    expect(maintenance?.requiredCapability).toBe('maintenance:access');
    expect(maintenance?.href).toBe('/o/[slug]/maintenance/work-orders');
    const maintenanceIdx = NAV_ITEMS.findIndex((i) => i.label === 'Maintenance');
    expect(maintenanceIdx).toBeGreaterThan(-1);
  });

  it('Reports item is gated by reporting:access and placed after Booking requests, before Activity (R1.2)', () => {
    const reports = NAV_ITEMS.find((i) => i.label === 'Reports');
    expect(reports?.requiredCapability).toBe('reporting:access');
    expect(reports?.href).toBe('/o/[slug]/reporting/reports');
    const bookingIdx = NAV_ITEMS.findIndex((i) => i.label === 'Booking requests');
    const reportsIdx = NAV_ITEMS.findIndex((i) => i.label === 'Reports');
    const activityIdx = NAV_ITEMS.findIndex((i) => i.label === 'Activity');
    expect(reportsIdx).toBeGreaterThan(bookingIdx);
    expect(reportsIdx).toBeLessThan(activityIdx);
  });

  it('Billing item is gated by billing:access and placed after Booking requests, before Reports (QB1)', () => {
    const billing = NAV_ITEMS.find((i) => i.label === 'Billing');
    expect(billing?.requiredCapability).toBe('billing:access');
    expect(billing?.href).toBe('/o/[slug]/billing');
    const bookingIdx = NAV_ITEMS.findIndex((i) => i.label === 'Booking requests');
    const billingIdx = NAV_ITEMS.findIndex((i) => i.label === 'Billing');
    const reportsIdx = NAV_ITEMS.findIndex((i) => i.label === 'Reports');
    expect(billingIdx).toBeGreaterThan(bookingIdx);
    expect(billingIdx).toBeLessThan(reportsIdx);
  });

  it('Billing is visible to accountant (billing:access) but not dispatcher, cfi, mechanic, renter, student', () => {
    const checkRole = (role: MembershipRole) => {
      const s = makeSession(role);
      return filterNavForSession(s, NAV_ITEMS, 'acme').some((i) => i.label === 'Billing');
    };
    expect(checkRole('accountant')).toBe(true);
    expect(checkRole('dispatcher')).toBe(false);
    expect(checkRole('cfi')).toBe(false);
    expect(checkRole('mechanic')).toBe(false);
    expect(checkRole('renter')).toBe(false);
    expect(checkRole('student')).toBe(false);
  });

  it('Activity item is gated by reporting:access and placed after Reports, before Org settings (A1.2)', () => {
    const activity = NAV_ITEMS.find((i) => i.label === 'Activity');
    expect(activity?.requiredCapability).toBe('reporting:access');
    expect(activity?.href).toBe('/o/[slug]/activity');
    const reportsIdx = NAV_ITEMS.findIndex((i) => i.label === 'Reports');
    const activityIdx = NAV_ITEMS.findIndex((i) => i.label === 'Activity');
    const settingsIdx = NAV_ITEMS.findIndex((i) => i.label === 'Org settings');
    expect(activityIdx).toBeGreaterThan(reportsIdx);
    expect(activityIdx).toBeLessThan(settingsIdx);
  });

  it('Messages item is gated by org:manage_settings and placed after Activity, immediately before Org settings (FC-parity)', () => {
    const messages = NAV_ITEMS.find((i) => i.label === 'Messages');
    expect(messages?.requiredCapability).toBe('org:manage_settings');
    expect(messages?.href).toBe('/o/[slug]/settings/messages');
    const activityIdx = NAV_ITEMS.findIndex((i) => i.label === 'Activity');
    const messagesIdx = NAV_ITEMS.findIndex((i) => i.label === 'Messages');
    const settingsIdx = NAV_ITEMS.findIndex((i) => i.label === 'Org settings');
    expect(messagesIdx).toBeGreaterThan(activityIdx);
    expect(messagesIdx).toBe(settingsIdx - 1);
  });

  it('Messages is visible to owner + manager but NOT dispatcher, cfi, accountant, mechanic, renter, student', () => {
    const checkRole = (role: MembershipRole) => {
      const s = makeSession(role);
      return filterNavForSession(s, NAV_ITEMS, 'acme').some((i) => i.label === 'Messages');
    };
    expect(checkRole('owner')).toBe(true);
    expect(checkRole('manager')).toBe(true);
    expect(checkRole('dispatcher')).toBe(false);
    expect(checkRole('cfi')).toBe(false);
    expect(checkRole('accountant')).toBe(false);
    expect(checkRole('mechanic')).toBe(false);
  });

  it('Reports is visible to accountant (reporting:access) but not mechanic, renter, student', () => {
    const checkRole = (role: MembershipRole) => {
      const s = makeSession(role);
      return filterNavForSession(s, NAV_ITEMS, 'acme').some((i) => i.label === 'Reports');
    };
    expect(checkRole('accountant')).toBe(true);
    expect(checkRole('mechanic')).toBe(false);
    expect(checkRole('renter')).toBe(false);
    expect(checkRole('student')).toBe(false);
  });

  it('Fleet item is gated by fleet:access and placed after Training and before Maintenance', () => {
    const fleet = NAV_ITEMS.find((i) => i.label === 'Fleet');
    expect(fleet?.requiredCapability).toBe('fleet:access');
    expect(fleet?.href).toBe('/o/[slug]/fleet');
    const trainingIdx = NAV_ITEMS.findIndex((i) => i.label === 'Training');
    const fleetIdx = NAV_ITEMS.findIndex((i) => i.label === 'Fleet');
    const maintenanceIdx = NAV_ITEMS.findIndex((i) => i.label === 'Maintenance');
    expect(fleetIdx).toBeGreaterThan(trainingIdx);
    expect(fleetIdx).toBeLessThan(maintenanceIdx);
  });

  it('second-to-last item is Org settings with org:manage_settings', () => {
    const settings = NAV_ITEMS[NAV_ITEMS.length - 2];
    expect(settings?.label).toBe('Org settings');
    expect(settings?.requiredCapability).toBe('org:manage_settings');
    expect(settings?.href).toContain('[slug]');
    expect(settings?.href).toContain('settings');
  });

  it('last item is Help with app:access (Slice P1.8)', () => {
    const last = NAV_ITEMS[NAV_ITEMS.length - 1];
    expect(last?.label).toBe('Help');
    expect(last?.requiredCapability).toBe('app:access');
    expect(last?.href).toBe('/o/[slug]/help');
  });

  it('all NAV_ITEMS have [slug] placeholder in href', () => {
    for (const item of NAV_ITEMS) {
      expect(item.href).toContain('[slug]');
    }
  });

  it('Portal is visible to student and renter (portal:access) but NOT to mechanic/accountant (Slice P1.2)', () => {
    const checkRole = (role: MembershipRole) => {
      const s = makeSession(role);
      return filterNavForSession(s, NAV_ITEMS, 'acme').some((i) => i.label === 'Portal');
    };
    expect(checkRole('student')).toBe(true);
    expect(checkRole('renter')).toBe(true);
    expect(checkRole('owner')).toBe(true);
    expect(checkRole('manager')).toBe(true);
    expect(checkRole('mechanic')).toBe(false);
    expect(checkRole('accountant')).toBe(false);
    expect(checkRole('cfi')).toBe(false);
    expect(checkRole('dispatcher')).toBe(false);
  });

  it('Dashboard is NOT visible to student/renter/mechanic (Dashboard now requires reporting:access in P1.2)', () => {
    const checkRole = (role: MembershipRole) => {
      const s = makeSession(role);
      return filterNavForSession(s, NAV_ITEMS, 'acme').some((i) => i.label === 'Dashboard');
    };
    expect(checkRole('student')).toBe(false);
    expect(checkRole('renter')).toBe(false);
    expect(checkRole('mechanic')).toBe(false);
    // Staff roles that have reporting:access still see Dashboard.
    expect(checkRole('owner')).toBe(true);
    expect(checkRole('manager')).toBe(true);
    expect(checkRole('dispatcher')).toBe(true);
    expect(checkRole('cfi')).toBe(true);
    expect(checkRole('accountant')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 14. Activity visible to reporting:access roles; hidden from student/renter/mechanic (A1.2)
// ═════════════════════════════════════════════════════════════════════════════

describe('14. Activity (Slice A1.2)', () => {
  const checkRole = (role: MembershipRole) => {
    const s = makeSession(role);
    return filterNavForSession(s, NAV_ITEMS, 'acme').some((i) => i.label === 'Activity');
  };

  it('Activity is visible to owner (reporting:access)', () => {
    expect(checkRole('owner')).toBe(true);
  });

  it('Activity is visible to manager (reporting:access)', () => {
    expect(checkRole('manager')).toBe(true);
  });

  it('Activity is visible to dispatcher (reporting:access)', () => {
    expect(checkRole('dispatcher')).toBe(true);
  });

  it('Activity is visible to cfi (reporting:access)', () => {
    expect(checkRole('cfi')).toBe(true);
  });

  it('Activity is visible to accountant (reporting:access)', () => {
    expect(checkRole('accountant')).toBe(true);
  });

  it('Activity is NOT visible to student (no reporting:access)', () => {
    expect(checkRole('student')).toBe(false);
  });

  it('Activity is NOT visible to renter (no reporting:access)', () => {
    expect(checkRole('renter')).toBe(false);
  });

  it('Activity is NOT visible to mechanic (no reporting:access)', () => {
    expect(checkRole('mechanic')).toBe(false);
  });

  it('Activity href resolves to /o/{slug}/activity after slug substitution', () => {
    const session = makeSession('owner');
    const result = filterNavForSession(session, NAV_ITEMS, 'test-fbo');
    const activity = result.find((i) => i.label === 'Activity');
    expect(activity?.href).toBe('/o/test-fbo/activity');
    expect(activity?.href).not.toContain('[slug]');
  });

  it('Activity requiredCapability is reporting:access', () => {
    const activity = NAV_ITEMS.find((i) => i.label === 'Activity');
    expect(activity?.requiredCapability).toBe('reporting:access');
  });

  it('Activity comes after Reports and before Org settings in owner nav', () => {
    const session = makeSession('owner');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme');
    const labels = result.map((i) => i.label);
    const reportsIdx = labels.indexOf('Reports');
    const activityIdx = labels.indexOf('Activity');
    const settingsIdx = labels.indexOf('Org settings');
    expect(activityIdx).toBeGreaterThan(reportsIdx);
    expect(activityIdx).toBeLessThan(settingsIdx);
  });

  it('all 8 roles: Activity visibility matches RBAC matrix (reporting:access roles only)', () => {
    const expectedVisible: MembershipRole[] = ['owner', 'manager', 'dispatcher', 'cfi', 'accountant'];
    for (const role of ['owner', 'manager', 'dispatcher', 'cfi', 'accountant', 'mechanic', 'renter', 'student'] as MembershipRole[]) {
      const visible = checkRole(role);
      const expected = expectedVisible.includes(role);
      expect(visible, `role=${role}`).toBe(expected);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 12. isPortalOnly — truth table for all 8 roles + null/undefined (Slice P1.2)
// ═════════════════════════════════════════════════════════════════════════════

describe('12. isPortalOnly (Slice P1.2)', () => {
  it('null session → false (fail-closed)', () => {
    expect(isPortalOnly(null)).toBe(false);
  });

  it('undefined session → false (fail-closed)', () => {
    expect(isPortalOnly(undefined)).toBe(false);
  });

  it('student → true (portal:access only, no reporting:access)', () => {
    expect(isPortalOnly(makeSession('student'))).toBe(true);
  });

  it('renter → true (portal:access only, no reporting:access)', () => {
    expect(isPortalOnly(makeSession('renter'))).toBe(true);
  });

  it('owner → false (has both portal:access AND reporting:access)', () => {
    expect(isPortalOnly(makeSession('owner'))).toBe(false);
  });

  it('manager → false (has both portal:access AND reporting:access)', () => {
    expect(isPortalOnly(makeSession('manager'))).toBe(false);
  });

  it('cfi → false (has reporting:access, NOT portal:access)', () => {
    expect(isPortalOnly(makeSession('cfi'))).toBe(false);
  });

  it('dispatcher → false (has reporting:access, NOT portal:access)', () => {
    expect(isPortalOnly(makeSession('dispatcher'))).toBe(false);
  });

  it('accountant → false (has reporting:access, NOT portal:access)', () => {
    expect(isPortalOnly(makeSession('accountant'))).toBe(false);
  });

  it('mechanic → false (has NEITHER portal:access NOR reporting:access)', () => {
    expect(isPortalOnly(makeSession('mechanic'))).toBe(false);
  });

  it('all 8 roles: isPortalOnly matches RBAC matrix (student+renter only)', () => {
    const expectedTrue: MembershipRole[] = ['student', 'renter'];
    for (const role of MEMBERSHIP_ROLES) {
      const result = isPortalOnly(makeSession(role));
      const expected = expectedTrue.includes(role);
      expect(result, `role=${role}`).toBe(expected);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 13. Portal visible / Dashboard hidden (Slice P1.2 — separation regression)
// ═════════════════════════════════════════════════════════════════════════════

describe('13. Portal visible to student/renter; Dashboard hidden from student/renter (P1.2)', () => {
  it('student sees Portal, NOT Dashboard (Dashboard requires reporting:access)', () => {
    const session = makeSession('student');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme');
    const labels = result.map((i) => i.label);
    expect(labels).toContain('Portal');
    expect(labels).not.toContain('Dashboard');
  });

  it('renter sees Portal, NOT Dashboard', () => {
    const session = makeSession('renter');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme');
    const labels = result.map((i) => i.label);
    expect(labels).toContain('Portal');
    expect(labels).not.toContain('Dashboard');
  });

  it('owner sees BOTH Portal AND Dashboard (both portal:access and reporting:access)', () => {
    const session = makeSession('owner');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme');
    const labels = result.map((i) => i.label);
    expect(labels).toContain('Portal');
    expect(labels).toContain('Dashboard');
  });

  it('manager sees BOTH Portal AND Dashboard', () => {
    const session = makeSession('manager');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme');
    const labels = result.map((i) => i.label);
    expect(labels).toContain('Portal');
    expect(labels).toContain('Dashboard');
  });

  it('cfi does NOT see Portal (no portal:access) but sees Dashboard (reporting:access)', () => {
    const session = makeSession('cfi');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme');
    const labels = result.map((i) => i.label);
    expect(labels).not.toContain('Portal');
    expect(labels).toContain('Dashboard');
  });

  it('dispatcher does NOT see Portal but sees Dashboard', () => {
    const session = makeSession('dispatcher');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme');
    const labels = result.map((i) => i.label);
    expect(labels).not.toContain('Portal');
    expect(labels).toContain('Dashboard');
  });

  it('mechanic sees neither Portal nor Dashboard (no portal:access, no reporting:access)', () => {
    const session = makeSession('mechanic');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme');
    const labels = result.map((i) => i.label);
    expect(labels).not.toContain('Portal');
    expect(labels).not.toContain('Dashboard');
  });

  it('accountant does NOT see Portal but sees Dashboard (reporting:access, no portal:access)', () => {
    const session = makeSession('accountant');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme');
    const labels = result.map((i) => i.label);
    expect(labels).not.toContain('Portal');
    expect(labels).toContain('Dashboard');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 15. landingPathFor — all 8 roles + null/undefined (NIT 1)
// ═════════════════════════════════════════════════════════════════════════════

describe('15. landingPathFor', () => {
  it('null session → null (no redirect)', () => {
    expect(landingPathFor(null)).toBeNull();
  });

  it('undefined session → null (no redirect)', () => {
    expect(landingPathFor(undefined)).toBeNull();
  });

  // Roles with reporting:access stay on the dashboard (null = no redirect).
  it('owner → null (has reporting:access → stays on dashboard)', () => {
    expect(landingPathFor(makeSession('owner'))).toBeNull();
  });

  it('manager → null (has reporting:access → stays on dashboard)', () => {
    expect(landingPathFor(makeSession('manager'))).toBeNull();
  });

  it('dispatcher → null (has reporting:access → stays on dashboard)', () => {
    expect(landingPathFor(makeSession('dispatcher'))).toBeNull();
  });

  it('cfi → null (has reporting:access → stays on dashboard)', () => {
    expect(landingPathFor(makeSession('cfi'))).toBeNull();
  });

  it('accountant → null (has reporting:access → stays on dashboard)', () => {
    expect(landingPathFor(makeSession('accountant'))).toBeNull();
  });

  // Portal-only roles (student/renter) redirect to /portal.
  it('student → /o/[slug]/portal (portal:access only, no reporting:access)', () => {
    expect(landingPathFor(makeSession('student'))).toBe('/o/[slug]/portal');
  });

  it('renter → /o/[slug]/portal (portal:access only, no reporting:access)', () => {
    expect(landingPathFor(makeSession('renter'))).toBe('/o/[slug]/portal');
  });

  // Mechanic has fleet:access + maintenance:access — redirects to Fleet (first nav item).
  it('mechanic → /o/[slug]/fleet (first accessible nav item; no reporting:access, no portal:access)', () => {
    expect(landingPathFor(makeSession('mechanic'))).toBe('/o/[slug]/fleet');
  });

  // Hypothetical capless session: no matching nav item → null.
  it('capless hypothetical (no items match) → null', () => {
    // Build a session that has no nav capabilities at all by overriding role with
    // a mock that has no caps. We can simulate this by passing an empty items list.
    const sess = makeSession('mechanic');
    expect(landingPathFor(sess, [])).toBeNull();
  });

  // Verify mechanic's landing is the FIRST nav item they can see (Fleet before Maintenance).
  it('mechanic landing is Fleet (first of Fleet+Maintenance in NAV_ITEMS order)', () => {
    const landing = landingPathFor(makeSession('mechanic'));
    // Fleet is before Maintenance in NAV_ITEMS — must land on Fleet.
    expect(landing).toBe('/o/[slug]/fleet');
    expect(landing).not.toBe('/o/[slug]/maintenance/work-orders');
  });

  // The [slug] placeholder is preserved so the page.tsx caller can interpolate it.
  it('[slug] placeholder is present in returned path (not resolved by landingPathFor)', () => {
    expect(landingPathFor(makeSession('mechanic'))).toContain('[slug]');
    expect(landingPathFor(makeSession('student'))).toContain('[slug]');
    expect(landingPathFor(makeSession('renter'))).toContain('[slug]');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 16. Booking requests (Slice PB1.2) — visibility per role
// ═════════════════════════════════════════════════════════════════════════════

describe('16. Booking requests (Slice PB1.2)', () => {
  const checkRole = (role: MembershipRole) => {
    const s = makeSession(role);
    return filterNavForSession(s, NAV_ITEMS, 'acme').some(
      (i) => i.label === 'Booking requests',
    );
  };

  it('Booking requests is visible to owner (booking:triage)', () => {
    expect(checkRole('owner')).toBe(true);
  });

  it('Booking requests is visible to manager (booking:triage)', () => {
    expect(checkRole('manager')).toBe(true);
  });

  it('Booking requests is visible to dispatcher (booking:triage)', () => {
    expect(checkRole('dispatcher')).toBe(true);
  });

  it('Booking requests is NOT visible to cfi (no booking:triage)', () => {
    expect(checkRole('cfi')).toBe(false);
  });

  it('Booking requests is NOT visible to mechanic (no booking:triage)', () => {
    expect(checkRole('mechanic')).toBe(false);
  });

  it('Booking requests is NOT visible to renter (no booking:triage)', () => {
    expect(checkRole('renter')).toBe(false);
  });

  it('Booking requests is NOT visible to student (no booking:triage)', () => {
    expect(checkRole('student')).toBe(false);
  });

  it('Booking requests is NOT visible to accountant (no booking:triage)', () => {
    expect(checkRole('accountant')).toBe(false);
  });

  it('Booking requests href resolves to /o/{slug}/booking after slug substitution', () => {
    const session = makeSession('owner');
    const result = filterNavForSession(session, NAV_ITEMS, 'test-fbo');
    const item = result.find((i) => i.label === 'Booking requests');
    expect(item?.href).toBe('/o/test-fbo/booking');
    expect(item?.href).not.toContain('[slug]');
  });

  it('Booking requests requiredCapability is booking:triage', () => {
    const item = NAV_ITEMS.find((i) => i.label === 'Booking requests');
    expect(item?.requiredCapability).toBe('booking:triage');
    expect(item?.href).toBe('/o/[slug]/booking');
  });

  it('Booking requests is placed after Maintenance and before Reports in NAV_ITEMS', () => {
    const maintenanceIdx = NAV_ITEMS.findIndex((i) => i.label === 'Maintenance');
    const bookingIdx = NAV_ITEMS.findIndex((i) => i.label === 'Booking requests');
    const reportsIdx = NAV_ITEMS.findIndex((i) => i.label === 'Reports');
    expect(bookingIdx).toBeGreaterThan(maintenanceIdx);
    expect(bookingIdx).toBeLessThan(reportsIdx);
  });

  it('Booking requests comes after Maintenance in dispatcher nav (booking:triage)', () => {
    const session = makeSession('dispatcher');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme');
    const labels = result.map((i) => i.label);
    const maintenanceIdx = labels.indexOf('Maintenance');
    const bookingIdx = labels.indexOf('Booking requests');
    expect(bookingIdx).toBeGreaterThan(maintenanceIdx);
  });

  it('all 8 roles: Booking requests visibility matches RBAC matrix (owner/manager/dispatcher only)', () => {
    const expectedVisible: MembershipRole[] = ['owner', 'manager', 'dispatcher'];
    for (const role of [
      'owner',
      'manager',
      'dispatcher',
      'cfi',
      'mechanic',
      'renter',
      'student',
      'accountant',
    ] as MembershipRole[]) {
      const visible = checkRole(role);
      const expected = expectedVisible.includes(role);
      expect(visible, `role=${role}`).toBe(expected);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 17. Help (Slice P1.8) — visible to ALL 8 roles (app:access); always last
// ═════════════════════════════════════════════════════════════════════════════

describe('17. Help (Slice P1.8)', () => {
  const checkRole = (role: MembershipRole) => {
    const s = makeSession(role);
    return filterNavForSession(s, NAV_ITEMS, 'acme').some((i) => i.label === 'Help');
  };

  it('Help requiredCapability is app:access', () => {
    const item = NAV_ITEMS.find((i) => i.label === 'Help');
    expect(item?.requiredCapability).toBe('app:access');
    expect(item?.href).toBe('/o/[slug]/help');
  });

  it('Help href resolves to /o/{slug}/help after slug substitution', () => {
    const session = makeSession('owner');
    const result = filterNavForSession(session, NAV_ITEMS, 'test-fbo');
    const item = result.find((i) => i.label === 'Help');
    expect(item?.href).toBe('/o/test-fbo/help');
    expect(item?.href).not.toContain('[slug]');
  });

  it('all 8 roles see Help (app:access is universal)', () => {
    for (const role of MEMBERSHIP_ROLES) {
      expect(checkRole(role), `role=${role}`).toBe(true);
    }
  });

  it('Help is always the LAST item in every role’s filtered nav', () => {
    for (const role of MEMBERSHIP_ROLES) {
      const session = makeSession(role);
      const result = filterNavForSession(session, NAV_ITEMS, 'acme');
      expect(result[result.length - 1]?.label, `role=${role}`).toBe('Help');
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 18. Per-org module toggles (Slice CLUB-MODE, migration 0047) — filterNavForSession
// ═════════════════════════════════════════════════════════════════════════════

describe('18. Module toggles — filterNavForSession (Slice CLUB-MODE)', () => {
  // Club-preset-shaped flags: training / booking / auto_schedule off, rest on.
  const clubFlags: OrgFeatureFlags = {
    ...ALL_MODULES_ENABLED,
    training: false,
    booking: false,
    auto_schedule: false,
  };

  it('owner: disabling training/booking/auto_schedule hides exactly those 3 items; core items stay', () => {
    const session = makeSession('owner');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme', clubFlags);
    const labels = result.map((i) => i.label);

    expect(labels).not.toContain('Training');
    expect(labels).not.toContain('Booking requests');
    expect(labels).not.toContain('Auto-schedule');

    // Every other item from the full owner nav remains, in order.
    expect(labels).toEqual([
      'Portal',
      'Dashboard',
      'Reservations',
      'Board',
      'Resources',
      'People',
      'Fleet',
      'Maintenance',
      'Billing',
      'Reports',
      'Activity',
      'Messages',
      'Org settings',
      'Help',
    ]);
  });

  it('owner: result has exactly 14 items with the 3 modules off (was 17)', () => {
    const session = makeSession('owner');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme', clubFlags);
    expect(result.length).toBe(14);
  });

  it('default (no 4th arg / ALL_MODULES_ENABLED) keeps everything — byte-identical to today', () => {
    const session = makeSession('owner');
    const withDefault = filterNavForSession(session, NAV_ITEMS, 'acme');
    const withExplicitAllEnabled = filterNavForSession(session, NAV_ITEMS, 'acme', ALL_MODULES_ENABLED);
    expect(withDefault).toEqual(withExplicitAllEnabled);
    expect(withDefault.map((i) => i.label)).toContain('Training');
    expect(withDefault.map((i) => i.label)).toContain('Booking requests');
    expect(withDefault.map((i) => i.label)).toContain('Auto-schedule');
    expect(withDefault.length).toBe(17);
  });

  it('a disabled module hides the item even for a role that otherwise has the capability (dispatcher)', () => {
    const session = makeSession('dispatcher');
    const withAll = filterNavForSession(session, NAV_ITEMS, 'acme');
    const withClub = filterNavForSession(session, NAV_ITEMS, 'acme', clubFlags);
    expect(withAll.map((i) => i.label)).toContain('Training');
    expect(withAll.map((i) => i.label)).toContain('Booking requests');
    expect(withAll.map((i) => i.label)).toContain('Auto-schedule');
    expect(withClub.map((i) => i.label)).not.toContain('Training');
    expect(withClub.map((i) => i.label)).not.toContain('Booking requests');
    expect(withClub.map((i) => i.label)).not.toContain('Auto-schedule');
  });

  it('items with no module key (core) are never hidden by any flag combination', () => {
    const allOffExceptCore: OrgFeatureFlags = {
      training: false,
      maintenance: false,
      billing: false,
      booking: false,
      portal: false,
      reports: false,
      auto_schedule: false,
      messages: false,
    };
    const session = makeSession('owner');
    const result = filterNavForSession(session, NAV_ITEMS, 'acme', allOffExceptCore);
    const labels = result.map((i) => i.label);
    // Core items (no `module` key): Dashboard, Reservations, Board, Resources,
    // People, Fleet, Org settings, Help.
    expect(labels).toEqual([
      'Dashboard',
      'Reservations',
      'Board',
      'Resources',
      'People',
      'Fleet',
      'Org settings',
      'Help',
    ]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 19. Per-org module toggles — landingPathFor (Slice CLUB-MODE)
// ═════════════════════════════════════════════════════════════════════════════

describe('19. Module toggles — landingPathFor (Slice CLUB-MODE)', () => {
  it('student session with portal:false falls through to the first enabled nav item, not /portal', () => {
    const portalOffFlags: OrgFeatureFlags = { ...ALL_MODULES_ENABLED, portal: false };
    const landing = landingPathFor(makeSession('student'), NAV_ITEMS, portalOffFlags);
    expect(landing).not.toBe('/o/[slug]/portal');
    // Student only has app:access + portal:access; with portal off, the only
    // remaining nav item student can see is Help (core, app:access, last item).
    expect(landing).toBe('/o/[slug]/help');
  });

  it('renter session with portal:false falls through the same way', () => {
    const portalOffFlags: OrgFeatureFlags = { ...ALL_MODULES_ENABLED, portal: false };
    const landing = landingPathFor(makeSession('renter'), NAV_ITEMS, portalOffFlags);
    expect(landing).not.toBe('/o/[slug]/portal');
    expect(landing).toBe('/o/[slug]/help');
  });

  it('student session with portal:true (default) still lands on /portal', () => {
    expect(landingPathFor(makeSession('student'), NAV_ITEMS, ALL_MODULES_ENABLED)).toBe('/o/[slug]/portal');
    // And the 2-arg default form (no flags passed) is unaffected too.
    expect(landingPathFor(makeSession('student'))).toBe('/o/[slug]/portal');
  });

  it('mechanic landing (no portal/reporting access) is unaffected by portal:false', () => {
    const portalOffFlags: OrgFeatureFlags = { ...ALL_MODULES_ENABLED, portal: false };
    expect(landingPathFor(makeSession('mechanic'), NAV_ITEMS, portalOffFlags)).toBe('/o/[slug]/fleet');
  });
});
