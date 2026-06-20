/**
 * portal-helpers.test.ts — Pure unit tests for portal display helpers and
 * the isPortalOnly nav predicate (Slice P1.2).
 *
 * COVERAGE:
 *
 *   deriveFirstName (apps/web/app/o/[slug]/(shell)/portal/page.tsx):
 *     1. "John Doe" → "John"
 *     2. "Jane Smith" → "Jane"
 *     3. "Alice" (no space) → "Alice"
 *     4. "  Bob Jones  " (leading/trailing spaces) → "Bob"
 *     5. "jane@acme.com" (email fallback) → "jane@acme.com"
 *     6. "First Middle Last" (three words) → "First"
 *     7. "" empty string → ""
 *
 *   reservationRoleLabel (apps/web/app/o/[slug]/(shell)/portal/page.tsx):
 *     8. 'booker' → 'Booker'
 *     9. 'pilot' → 'Pilot'
 *    10. 'booker_and_pilot' → 'Booker & Pilot'
 *
 *   isPortalOnly (apps/web/lib/nav.ts):
 *    11. null session → false
 *    12. undefined session → false
 *    13. student → true (portal:access, no reporting:access)
 *    14. renter → true (portal:access, no reporting:access)
 *    15. owner → false (has both portal:access AND reporting:access)
 *    16. manager → false (has both portal:access AND reporting:access)
 *    17. cfi → false (has reporting:access, no portal:access)
 *    18. dispatcher → false (has reporting:access, no portal:access)
 *    19. accountant → false (has reporting:access, no portal:access)
 *    20. mechanic → false (neither portal:access nor reporting:access)
 *
 * These are PURE unit tests — no DOM, no Next.js, no DB.
 */

import { describe, it, expect } from 'vitest';
import { MEMBERSHIP_ROLES } from '@aeroops/core';
import type { MembershipRole } from '@aeroops/core';
import type { AppSession } from '@aeroops/api';
import { isPortalOnly } from '../nav';
// Import from the pure helper file — NOT the page (page has Next.js/React imports
// that don't work in the node vitest environment).
import { deriveFirstName, reservationRoleLabel } from '../../app/o/[slug]/(shell)/portal/_utils/portal-display';

// ─── Session helper ───────────────────────────────────────────────────────────

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

// ─── deriveFirstName ─────────────────────────────────────────────────────────

describe('deriveFirstName', () => {
  it('1. "John Doe" → "John"', () => {
    expect(deriveFirstName('John Doe')).toBe('John');
  });

  it('2. "Jane Smith" → "Jane"', () => {
    expect(deriveFirstName('Jane Smith')).toBe('Jane');
  });

  it('3. "Alice" (no space) → "Alice"', () => {
    expect(deriveFirstName('Alice')).toBe('Alice');
  });

  it('4. "  Bob Jones  " (leading/trailing spaces) → "Bob"', () => {
    expect(deriveFirstName('  Bob Jones  ')).toBe('Bob');
  });

  it('5. "jane@acme.com" (email fallback — no space) → "jane@acme.com"', () => {
    expect(deriveFirstName('jane@acme.com')).toBe('jane@acme.com');
  });

  it('6. "First Middle Last" (three words) → "First"', () => {
    expect(deriveFirstName('First Middle Last')).toBe('First');
  });

  it('7. "" (empty string) → ""', () => {
    expect(deriveFirstName('')).toBe('');
  });

  it('8. "  " (only spaces) → ""', () => {
    // trim() collapses to "", no space → returns ""
    expect(deriveFirstName('  ')).toBe('');
  });
});

// ─── reservationRoleLabel ─────────────────────────────────────────────────────

describe('reservationRoleLabel', () => {
  it("9. 'booker' → 'Booker'", () => {
    expect(reservationRoleLabel('booker')).toBe('Booker');
  });

  it("10. 'pilot' → 'Pilot'", () => {
    expect(reservationRoleLabel('pilot')).toBe('Pilot');
  });

  it("11. 'booker_and_pilot' → 'Booker & Pilot'", () => {
    expect(reservationRoleLabel('booker_and_pilot')).toBe('Booker & Pilot');
  });
});

// ─── isPortalOnly ─────────────────────────────────────────────────────────────

describe('isPortalOnly', () => {
  it('12. null session → false (fail-closed)', () => {
    expect(isPortalOnly(null)).toBe(false);
  });

  it('13. undefined session → false (fail-closed)', () => {
    expect(isPortalOnly(undefined)).toBe(false);
  });

  it('14. student → true (portal:access only, no reporting:access)', () => {
    expect(isPortalOnly(makeSession('student'))).toBe(true);
  });

  it('15. renter → true (portal:access only, no reporting:access)', () => {
    expect(isPortalOnly(makeSession('renter'))).toBe(true);
  });

  it('16. owner → false (has both portal:access AND reporting:access)', () => {
    expect(isPortalOnly(makeSession('owner'))).toBe(false);
  });

  it('17. manager → false (has both portal:access AND reporting:access)', () => {
    expect(isPortalOnly(makeSession('manager'))).toBe(false);
  });

  it('18. cfi → false (has reporting:access, NOT portal:access)', () => {
    expect(isPortalOnly(makeSession('cfi'))).toBe(false);
  });

  it('19. dispatcher → false (has reporting:access, NOT portal:access)', () => {
    expect(isPortalOnly(makeSession('dispatcher'))).toBe(false);
  });

  it('20. accountant → false (has reporting:access, NOT portal:access)', () => {
    expect(isPortalOnly(makeSession('accountant'))).toBe(false);
  });

  it('21. mechanic → false (has NEITHER portal:access NOR reporting:access)', () => {
    expect(isPortalOnly(makeSession('mechanic'))).toBe(false);
  });

  it('22. all 8 roles: isPortalOnly is consistent with RBAC matrix', () => {
    const expectedPortalOnly: MembershipRole[] = ['student', 'renter'];
    for (const role of MEMBERSHIP_ROLES) {
      const result = isPortalOnly(makeSession(role));
      const expected = expectedPortalOnly.includes(role);
      expect(result, `role=${role}`).toBe(expected);
    }
  });
});
