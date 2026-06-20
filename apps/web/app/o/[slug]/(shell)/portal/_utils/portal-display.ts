/**
 * portal/_utils/portal-display.ts — Pure display helpers for the portal page.
 *
 * PURE: no DOM, no Next.js imports, no I/O. Safe to import in tests.
 * Exported here so they can be unit-tested without importing the RSC page
 * (which has Next.js/React imports that don't work in node vitest).
 *
 * [VERIFY-T1-B]: progress display helpers are content-coverage indicators only.
 */

/**
 * deriveFirstName — extracts the first name from a displayName string.
 * "John Doe" → "John", "jane@acme.com" → "jane@acme.com" (email fallback).
 * Pure; unit-tested.
 */
export function deriveFirstName(displayName: string): string {
  const trimmed = displayName.trim();
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx === -1) return trimmed;
  return trimmed.slice(0, spaceIdx);
}

/**
 * reservationRoleLabel — human-readable label for a reservation role.
 * Pure; unit-tested.
 */
export function reservationRoleLabel(
  role: 'booker' | 'pilot' | 'booker_and_pilot',
): string {
  switch (role) {
    case 'booker':
      return 'Booker';
    case 'pilot':
      return 'Pilot';
    case 'booker_and_pilot':
      return 'Booker & Pilot';
  }
}
