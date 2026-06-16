/**
 * capabilities.test.ts — Unit tests for the RBAC capability model.
 *
 * COVERAGE:
 *   1. All 8 roles have app:access.
 *   2. Only owner and manager have org:manage_settings.
 *   3. The other 6 roles do NOT have org:manage_settings.
 *   4. Unknown role → false (fail-closed).
 *   5. Unknown capability → false (fail-closed).
 *   6. Unknown role + unknown capability → false.
 *   7. ROLE_CAPABILITIES keys exactly equal MEMBERSHIP_ROLES (exhaustiveness).
 *   8. capabilitiesForRole — returns correct arrays; unknown role → [].
 *   9. Cross-product invariant: can(role, cap) === ROLE_CAPABILITIES[role].includes(cap)
 *      for every (role, cap) pair.
 *  10. CAPABILITIES array completeness.
 *  11. Adversarial: prototype-key roles never throw and are fail-closed.
 *  12. isMembershipRole type guard.
 *  13. SCHED-1 schedule:* capabilities — exact grants per role.
 */

import { describe, it, expect } from 'vitest';
import {
  MEMBERSHIP_ROLES,
  CAPABILITIES,
  ROLE_CAPABILITIES,
  can,
  capabilitiesForRole,
  isMembershipRole,
} from '../index.js';
import type { MembershipRole, Capability } from '../index.js';

// Prototype-key role strings that would previously resolve up the chain.
const PROTOTYPE_KEY_ROLES = [
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  '__proto__',
  'prototype',
  '',
] as const;

// ─── 1. All 8 roles have app:access ─────────────────────────────────────────

describe('1. app:access — all 8 roles', () => {
  for (const role of MEMBERSHIP_ROLES) {
    it(`${role} has app:access`, () => {
      expect(can(role, 'app:access')).toBe(true);
    });
  }
});

// ─── 2. owner + manager have org:manage_settings ─────────────────────────────

describe('2. org:manage_settings — owner and manager only', () => {
  it('owner has org:manage_settings', () => {
    expect(can('owner', 'org:manage_settings')).toBe(true);
  });

  it('manager has org:manage_settings', () => {
    expect(can('manager', 'org:manage_settings')).toBe(true);
  });
});

// ─── 3. The other 6 roles do NOT have org:manage_settings ────────────────────

describe('3. org:manage_settings — the other 6 roles are denied', () => {
  const restrictedRoles: MembershipRole[] = [
    'dispatcher',
    'cfi',
    'mechanic',
    'renter',
    'student',
    'accountant',
  ];

  for (const role of restrictedRoles) {
    it(`${role} does NOT have org:manage_settings`, () => {
      expect(can(role, 'org:manage_settings')).toBe(false);
    });
  }
});

// ─── 4. Unknown role → false ─────────────────────────────────────────────────

describe('4. Fail-closed — unknown role', () => {
  it('unknown role + known capability → false', () => {
    expect(can('superadmin' as MembershipRole, 'app:access')).toBe(false);
  });

  it('unknown role + another known capability → false', () => {
    expect(can('pilot' as MembershipRole, 'org:manage_settings')).toBe(false);
  });
});

// ─── 5. Unknown capability → false ──────────────────────────────────────────

describe('5. Fail-closed — unknown capability', () => {
  it('known role + unknown capability → false', () => {
    expect(can('owner', 'schedule:create' as Capability)).toBe(false);
  });

  it('owner + billing:view (not yet defined) → false', () => {
    expect(can('owner', 'billing:view' as Capability)).toBe(false);
  });
});

// ─── 6. Unknown role + unknown capability → false ────────────────────────────

describe('6. Fail-closed — unknown role + unknown capability', () => {
  it('unknown role + unknown capability → false', () => {
    expect(can('nobody' as MembershipRole, 'schedule:anything' as Capability)).toBe(false);
  });
});

// ─── 7. ROLE_CAPABILITIES keys exactly equal MEMBERSHIP_ROLES ────────────────

describe('7. ROLE_CAPABILITIES exhaustiveness', () => {
  it('ROLE_CAPABILITIES keys exactly equal MEMBERSHIP_ROLES (same set, same count)', () => {
    const matrixKeys = Object.keys(ROLE_CAPABILITIES).sort();
    const roleSet = [...MEMBERSHIP_ROLES].sort();
    expect(matrixKeys).toEqual(roleSet);
  });

  it('no extra keys in ROLE_CAPABILITIES beyond MEMBERSHIP_ROLES', () => {
    for (const key of Object.keys(ROLE_CAPABILITIES)) {
      expect((MEMBERSHIP_ROLES as readonly string[]).includes(key)).toBe(true);
    }
  });

  it('every role in MEMBERSHIP_ROLES has an entry in ROLE_CAPABILITIES', () => {
    for (const role of MEMBERSHIP_ROLES) {
      expect(Object.prototype.hasOwnProperty.call(ROLE_CAPABILITIES, role)).toBe(true);
    }
  });
});

// ─── 8. capabilitiesForRole ──────────────────────────────────────────────────

describe('8. capabilitiesForRole', () => {
  it('owner returns app + org + all three schedule capabilities', () => {
    const caps = capabilitiesForRole('owner');
    expect(caps).toContain('app:access');
    expect(caps).toContain('org:manage_settings');
    expect(caps).toContain('schedule:access');
    expect(caps).toContain('schedule:create_reservation');
    expect(caps).toContain('schedule:manage_resources');
    expect(caps.length).toBe(5);
  });

  it('manager returns app + org + all three schedule capabilities', () => {
    const caps = capabilitiesForRole('manager');
    expect(caps).toContain('app:access');
    expect(caps).toContain('org:manage_settings');
    expect(caps).toContain('schedule:access');
    expect(caps).toContain('schedule:create_reservation');
    expect(caps).toContain('schedule:manage_resources');
    expect(caps.length).toBe(5);
  });

  it('student returns only app:access', () => {
    const caps = capabilitiesForRole('student');
    expect(caps).toContain('app:access');
    expect(caps).not.toContain('org:manage_settings');
    expect(caps.length).toBe(1);
  });

  it('unknown role returns empty array', () => {
    const caps = capabilitiesForRole('unknown-role' as MembershipRole);
    expect(caps).toEqual([]);
    expect(caps.length).toBe(0);
  });

  it('all 8 roles return non-empty arrays', () => {
    for (const role of MEMBERSHIP_ROLES) {
      const caps = capabilitiesForRole(role);
      expect(caps.length).toBeGreaterThan(0);
    }
  });
});

// ─── 9. Cross-product invariant ──────────────────────────────────────────────

describe('9. Cross-product invariant: can(role, cap) === ROLE_CAPABILITIES[role].includes(cap)', () => {
  for (const role of MEMBERSHIP_ROLES) {
    for (const cap of CAPABILITIES) {
      it(`can('${role}', '${cap}') === ROLE_CAPABILITIES['${role}'].includes('${cap}')`, () => {
        const fromCan = can(role, cap);
        const fromMatrix = (ROLE_CAPABILITIES[role] as readonly string[]).includes(cap);
        expect(fromCan).toBe(fromMatrix);
      });
    }
  }
});

// ─── 10. CAPABILITIES array completeness ─────────────────────────────────────

describe('10. CAPABILITIES array', () => {
  it('contains app:access', () => {
    expect(CAPABILITIES).toContain('app:access');
  });

  it('contains org:manage_settings', () => {
    expect(CAPABILITIES).toContain('org:manage_settings');
  });

  it('contains the three SCHED-1 schedule capabilities', () => {
    expect(CAPABILITIES).toContain('schedule:access');
    expect(CAPABILITIES).toContain('schedule:create_reservation');
    expect(CAPABILITIES).toContain('schedule:manage_resources');
  });

  it('has exactly 5 capabilities (Phase 0 + SCHED-1 schedule:*)', () => {
    expect(CAPABILITIES.length).toBe(5);
  });

  it('has no duplicate capabilities', () => {
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
  });
});

// ─── 11. Adversarial: prototype-key roles — fail-closed, never throw ─────────
//
// Roles that are Object.prototype member names ('constructor', 'toString', etc.)
// would previously resolve up the prototype chain to a truthy non-array,
// causing `caps.includes(cap)` to throw a TypeError. The contract is:
//   can(protoKeyRole, anyCap) === false  (no throw)
//   capabilitiesForRole(protoKeyRole)   deep-equals []  (no throw)

describe('11. Adversarial: prototype-key and empty-string roles are fail-closed (never throw)', () => {
  for (const role of PROTOTYPE_KEY_ROLES) {
    it(`can('${role}', 'app:access') === false (no throw)`, () => {
      expect(() => can(role as MembershipRole, 'app:access')).not.toThrow();
      expect(can(role as MembershipRole, 'app:access')).toBe(false);
    });

    it(`can('${role}', 'org:manage_settings') === false (no throw)`, () => {
      expect(() => can(role as MembershipRole, 'org:manage_settings')).not.toThrow();
      expect(can(role as MembershipRole, 'org:manage_settings')).toBe(false);
    });

    for (const cap of [
      'schedule:access',
      'schedule:create_reservation',
      'schedule:manage_resources',
    ] as const) {
      it(`can('${role}', '${cap}') === false (no throw)`, () => {
        expect(() => can(role as MembershipRole, cap)).not.toThrow();
        expect(can(role as MembershipRole, cap)).toBe(false);
      });
    }

    it(`capabilitiesForRole('${role}') deep-equals [] (no throw)`, () => {
      expect(() => capabilitiesForRole(role as MembershipRole)).not.toThrow();
      expect(capabilitiesForRole(role as MembershipRole)).toEqual([]);
    });
  }
});

// ─── 12. isMembershipRole type guard ─────────────────────────────────────────

describe('12. isMembershipRole', () => {
  it('returns true for all 8 MEMBERSHIP_ROLES', () => {
    for (const role of MEMBERSHIP_ROLES) {
      expect(isMembershipRole(role)).toBe(true);
    }
  });

  it('returns false for each prototype-key string', () => {
    for (const role of PROTOTYPE_KEY_ROLES) {
      expect(isMembershipRole(role)).toBe(false);
    }
  });

  it('returns false for unknown string', () => {
    expect(isMembershipRole('superadmin')).toBe(false);
    expect(isMembershipRole('pilot')).toBe(false);
    expect(isMembershipRole('admin')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isMembershipRole(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isMembershipRole(undefined)).toBe(false);
  });

  it('returns false for number', () => {
    expect(isMembershipRole(0)).toBe(false);
    expect(isMembershipRole(1)).toBe(false);
  });

  it('returns false for object', () => {
    expect(isMembershipRole({})).toBe(false);
    expect(isMembershipRole([])).toBe(false);
  });

  it('returns false for boolean', () => {
    expect(isMembershipRole(true)).toBe(false);
    expect(isMembershipRole(false)).toBe(false);
  });
});

// ─── 13. SCHED-1 schedule:* capabilities — exact grants ──────────────────────
//
// Per ADR-0004 / SCHED-1:
//   schedule:access             → owner, manager, dispatcher, cfi
//   schedule:create_reservation → owner, manager, dispatcher, cfi (also gates cancel)
//   schedule:manage_resources   → owner, manager, dispatcher
//   renter, student, mechanic, accountant get NONE of the three.

describe('13. SCHED-1 schedule:* capabilities', () => {
  const GRANTED: Record<
    'schedule:access' | 'schedule:create_reservation' | 'schedule:manage_resources',
    MembershipRole[]
  > = {
    'schedule:access': ['owner', 'manager', 'dispatcher', 'cfi'],
    'schedule:create_reservation': ['owner', 'manager', 'dispatcher', 'cfi'],
    'schedule:manage_resources': ['owner', 'manager', 'dispatcher'],
  };

  const EXCLUDED: MembershipRole[] = ['renter', 'student', 'mechanic', 'accountant'];

  for (const [cap, grantedRoles] of Object.entries(GRANTED) as [
    keyof typeof GRANTED,
    MembershipRole[],
  ][]) {
    describe(cap, () => {
      for (const role of grantedRoles) {
        it(`${role} HAS ${cap}`, () => {
          expect(can(role, cap)).toBe(true);
        });
      }

      for (const role of MEMBERSHIP_ROLES) {
        if (grantedRoles.includes(role)) continue;
        it(`${role} does NOT have ${cap}`, () => {
          expect(can(role, cap)).toBe(false);
        });
      }
    });
  }

  it('excluded roles (renter/student/mechanic/accountant) have NONE of the three', () => {
    for (const role of EXCLUDED) {
      expect(can(role, 'schedule:access')).toBe(false);
      expect(can(role, 'schedule:create_reservation')).toBe(false);
      expect(can(role, 'schedule:manage_resources')).toBe(false);
      // They retain exactly app:access and nothing else.
      expect(capabilitiesForRole(role)).toEqual(['app:access']);
    }
  });

  it('schedule:access grant set equals create_reservation grant set (cfi gets both)', () => {
    for (const role of MEMBERSHIP_ROLES) {
      expect(can(role, 'schedule:access')).toBe(can(role, 'schedule:create_reservation'));
    }
  });

  it('manage_resources is a strict subset of access (cfi can access but not manage)', () => {
    expect(can('cfi', 'schedule:access')).toBe(true);
    expect(can('cfi', 'schedule:manage_resources')).toBe(false);
    for (const role of MEMBERSHIP_ROLES) {
      if (can(role, 'schedule:manage_resources')) {
        expect(can(role, 'schedule:access')).toBe(true);
      }
    }
  });
});
