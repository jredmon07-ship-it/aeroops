/**
 * lib/nav.ts — Pure, framework-agnostic nav helpers for the app shell.
 *
 * These helpers have zero DOM or Next.js imports so they are:
 *   1. Unit-testable without spinning up React or Next.js.
 *   2. Safe to call in any server component or utility.
 *
 * AUTHZ NOTE:
 *   filterNavForSession is a UX/nav convenience ONLY.
 *   It uses hasCapability (a UI predicate — never a gate).
 *   The real gate is requireCapability(), called server-side in each
 *   protected route. Removing a nav link is cosmetic; the gate stops
 *   unauthorized access even if someone hits the URL directly.
 *
 * isPortalOnly — pure predicate used by the org-root dashboard page to
 *   redirect student/renter users to the portal instead of the empty dashboard.
 *   Roles: portal:access WITHOUT reporting:access → portal-only.
 *   owner/manager have BOTH portal:access and reporting:access → NOT portal-only.
 *   cfi/dispatcher have reporting:access but NOT portal:access → NOT portal-only.
 */

import { hasCapability } from '@aeroops/api';
import type { AppSession } from '@aeroops/api';
import type { Capability } from '@aeroops/core';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NavItem {
  label: string;
  /** href may contain [slug] placeholder — callers are responsible for interpolation. */
  href: string;
  requiredCapability: Capability;
}

// ─── Nav item registry ────────────────────────────────────────────────────────

/**
 * NAV_ITEMS — the master ordered list of navigation items for the app shell.
 *
 * Paths use a [slug] placeholder. The layout resolves the real slug at render
 * time (e.g. href.replace('[slug]', slug)).
 *
 * Order is intentional:
 *   1. Portal — self-service portal for student/renter (+ owner/manager preview);
 *      portal:access. FIRST so portal-only roles see it immediately.
 *   2. Dashboard — ops console; raised to reporting:access (Slice P1.2).
 *      Hidden from student/renter (they are redirected to Portal).
 *   3. Reservations — Schedule hub entry point (schedule:access).
 *   4. Board — Single-day dispatch board (schedule:access); after Reservations.
 *   5. Auto-schedule — Intelligent auto-scheduler (schedule:create_reservation);
 *      after Board, before Resources — scheduling operators only.
 *   6. Resources — Resource admin (schedule:manage_resources only).
 *   7. People — Roster management (people:access); after Resources, before Training.
 *   8. Training — Training hub (training:access); after People, before Fleet.
 *   9. Fleet — Aircraft detail hub (fleet:access); after Training, before Maintenance.
 *  10. Maintenance — Squawks + grounding (maintenance:access).
 *  11. Reports — Operational reports (reporting:access); after Maintenance, before Activity.
 *  12. Activity — Audit trail feed (reporting:access); after Reports, before Org settings.
 *  13. Org settings — owner + manager only (org:manage_settings).
 */
export const NAV_ITEMS: readonly NavItem[] = [
  // Slice P1.2: Portal — student/renter self-service (+ owner/manager preview).
  // Placed FIRST so portal-only roles (student/renter) see it as the top item.
  // portal:access → owner, manager, student, renter. NOT cfi/dispatcher/mechanic/accountant.
  {
    label: 'Portal',
    href: '/o/[slug]/portal',
    requiredCapability: 'portal:access',
  },
  {
    label: 'Dashboard',
    href: '/o/[slug]',
    requiredCapability: 'reporting:access',
  },
  {
    label: 'Reservations',
    href: '/o/[slug]/schedule',
    requiredCapability: 'schedule:access',
  },
  {
    label: 'Board',
    href: '/o/[slug]/schedule/board',
    requiredCapability: 'schedule:access',
  },
  // Slice 4b: Auto-scheduler — gated by schedule:create_reservation (same as the
  // commit it produces). Visible to owner, manager, dispatcher, cfi.
  {
    label: 'Auto-schedule',
    href: '/o/[slug]/schedule/auto',
    requiredCapability: 'schedule:create_reservation',
  },
  {
    label: 'Resources',
    href: '/o/[slug]/schedule/resources',
    requiredCapability: 'schedule:manage_resources',
  },
  {
    label: 'People',
    href: '/o/[slug]/people',
    requiredCapability: 'people:access',
  },
  // Slice T1.3: Training hub — gated by training:access (owner/manager/cfi/dispatcher).
  // Placed after People and before Fleet per the breadth re-sequence (approved 2026-06-18).
  {
    label: 'Training',
    href: '/o/[slug]/training',
    requiredCapability: 'training:access',
  },
  {
    label: 'Fleet',
    href: '/o/[slug]/fleet',
    requiredCapability: 'fleet:access',
  },
  // Slice M1.3: Maintenance hub entry point is work-orders (squawks accessible via
  // links from the list). Gated by maintenance:access (owner/manager/dispatcher/cfi/mechanic).
  {
    label: 'Maintenance',
    href: '/o/[slug]/maintenance/work-orders',
    requiredCapability: 'maintenance:access',
  },
  // Slice R1.2: Operational reports — gated by reporting:access (owner/manager/
  // dispatcher/cfi/accountant). Placed after Maintenance, before Activity.
  // Visible to: owner, manager, dispatcher, cfi, accountant.
  // NOT visible to: mechanic, renter, student.
  {
    label: 'Reports',
    href: '/o/[slug]/reporting/reports',
    requiredCapability: 'reporting:access',
  },
  // Slice A1.2: Activity feed — audit trail read-only view. Gated by
  // reporting:access (same audience as Reports + Dashboard).
  // Placed after Reports, before Org settings.
  // Visible to: owner, manager, dispatcher, cfi, accountant.
  // NOT visible to: mechanic, renter, student.
  {
    label: 'Activity',
    href: '/o/[slug]/activity',
    requiredCapability: 'reporting:access',
  },
  {
    label: 'Org settings',
    href: '/o/[slug]/settings',
    requiredCapability: 'org:manage_settings',
  },
] as const;

// ─── isPortalOnly ─────────────────────────────────────────────────────────────

/**
 * isPortalOnly — pure predicate: does this session belong to a portal-only role?
 *
 * Returns true when the session has portal:access but NOT reporting:access.
 * In practice this means: student and renter.
 * owner and manager have BOTH portal:access AND reporting:access → false.
 * cfi, dispatcher, accountant have reporting:access but NOT portal:access → false.
 * mechanic has neither → false.
 *
 * Used by the org-root dashboard page to redirect student/renter users to the
 * portal (/o/[slug]/portal) rather than leaving them on an empty dashboard.
 *
 * PURE: no DOM, no I/O. Unit-testable.
 *
 * @param session - AppSession (may be null/undefined → false fail-closed).
 * @returns true iff the session is a portal-only role (student | renter).
 */
export function isPortalOnly(
  session: AppSession | null | undefined,
): boolean {
  if (!session) return false;
  return (
    hasCapability(session, 'portal:access') &&
    !hasCapability(session, 'reporting:access')
  );
}

// ─── landingPathFor ───────────────────────────────────────────────────────────

/**
 * landingPathFor — pure helper: returns the preferred landing path for a session,
 * or null when the session should stay on the dashboard.
 *
 * Decision order:
 *   1. null/undefined session            → null (no redirect; middleware blocks)
 *   2. has reporting:access              → null (dashboard is the right home)
 *   3. has portal:access (student/renter)→ '/portal' (existing isPortalOnly case)
 *   4. else → href of the FIRST visible NAV_ITEM (slug placeholder intact, caller
 *      must interpolate), e.g. mechanic → '/o/[slug]/fleet' which the page resolves.
 *   5. no nav items at all               → null (nothing to redirect to)
 *
 * PURE: no DOM, no I/O. Unit-testable.
 *
 * @param session - AppSession (may be null/undefined → null fail-closed).
 * @param items   - The nav items to inspect (defaults to NAV_ITEMS).
 * @returns       - A path string (still [slug]-templated) or null.
 */
export function landingPathFor(
  session: AppSession | null | undefined,
  items: readonly NavItem[] = NAV_ITEMS,
): string | null {
  if (!session) return null;

  // Roles with reporting:access belong on the dashboard — no redirect.
  if (hasCapability(session, 'reporting:access')) return null;

  // Portal-only roles (student/renter) redirect to the portal.
  if (hasCapability(session, 'portal:access')) return '/o/[slug]/portal';

  // Everyone else (e.g. mechanic): find the first nav item they can access.
  const first = items.find((item) => hasCapability(session, item.requiredCapability));
  return first?.href ?? null;
}

// ─── filterNavForSession ──────────────────────────────────────────────────────

/**
 * filterNavForSession — returns only the nav items the session's role
 * may see, with [slug] replaced by the actual slug.
 *
 * PURE: no DOM, no I/O, no React. Call this in any server component or test.
 *
 * UI ONLY — the gate is requireCapability() in the protected route handler.
 * An absent link is cosmetic; direct URL access is blocked server-side.
 *
 * @param session - AppSession (may be null/undefined → returns []).
 * @param items   - The nav items to filter (defaults to NAV_ITEMS).
 * @param slug    - The org URL slug; replaces [slug] in each href.
 * @returns       - Filtered and slug-resolved nav items.
 */
export function filterNavForSession(
  session: AppSession | null | undefined,
  items: readonly NavItem[],
  slug: string,
): NavItem[] {
  if (!session) return [];

  return items
    .filter(
      (item) =>
        // UI only — never the gate; see AUTHZ NOTE above.
        hasCapability(session, item.requiredCapability),
    )
    .map((item) => ({
      ...item,
      href: item.href.replace('[slug]', slug),
    }));
}
