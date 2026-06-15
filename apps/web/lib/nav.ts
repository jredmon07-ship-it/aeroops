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
 *   1. Dashboard — always first; visible to all authenticated roles.
 *   2. Org settings — owner + manager only (org:manage_settings).
 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    label: 'Dashboard',
    href: '/o/[slug]',
    requiredCapability: 'app:access',
  },
  {
    label: 'Org settings',
    href: '/o/[slug]/settings',
    requiredCapability: 'org:manage_settings',
  },
] as const;

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
