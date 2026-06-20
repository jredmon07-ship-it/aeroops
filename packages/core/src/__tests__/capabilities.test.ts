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
 *  14. MAINTENANCE-3b maintenance:* capabilities — exact grants per role.
 *  15. DISPATCH-3c dispatch:manage_requirements — exact grants per role.
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
  it('owner returns app + dispatch:access + dispatch:create + dispatch:manage_requirements + fleet:access + fleet:manage + maintenance:* + org + people:access + people:manage + reporting:access + all three schedule capabilities + training:access + training:manage', () => {
    const caps = capabilitiesForRole('owner');
    expect(caps).toContain('app:access');
    expect(caps).toContain('dispatch:access');
    expect(caps).toContain('dispatch:create');
    expect(caps).toContain('dispatch:manage_requirements');
    expect(caps).toContain('fleet:access');
    expect(caps).toContain('fleet:manage');
    expect(caps).toContain('maintenance:access');
    expect(caps).toContain('maintenance:ground');
    expect(caps).toContain('maintenance:squawk');
    expect(caps).toContain('org:manage_settings');
    expect(caps).toContain('people:access');
    expect(caps).toContain('people:manage');
    expect(caps).toContain('reporting:access');
    expect(caps).toContain('schedule:access');
    expect(caps).toContain('schedule:create_reservation');
    expect(caps).toContain('schedule:manage_resources');
    expect(caps).toContain('training:access');
    expect(caps).toContain('training:manage');
    expect(caps).toContain('maintenance:work_order');
    expect(caps).toContain('portal:access');
    expect(caps.length).toBe(20);
  });

  it('manager returns app + dispatch:access + dispatch:create + dispatch:manage_requirements + fleet:access + fleet:manage + maintenance:* + org + people:access + people:manage + reporting:access + all three schedule capabilities + training:access + training:manage', () => {
    const caps = capabilitiesForRole('manager');
    expect(caps).toContain('app:access');
    expect(caps).toContain('dispatch:access');
    expect(caps).toContain('dispatch:create');
    expect(caps).toContain('dispatch:manage_requirements');
    expect(caps).toContain('fleet:access');
    expect(caps).toContain('fleet:manage');
    expect(caps).toContain('maintenance:access');
    expect(caps).toContain('maintenance:ground');
    expect(caps).toContain('maintenance:squawk');
    expect(caps).toContain('maintenance:work_order');
    expect(caps).toContain('org:manage_settings');
    expect(caps).toContain('people:access');
    expect(caps).toContain('people:manage');
    expect(caps).toContain('reporting:access');
    expect(caps).toContain('schedule:access');
    expect(caps).toContain('schedule:create_reservation');
    expect(caps).toContain('schedule:manage_resources');
    expect(caps).toContain('training:access');
    expect(caps).toContain('training:manage');
    expect(caps).toContain('portal:access');
    expect(caps.length).toBe(20);
  });

  it('student returns app:access + portal:access (P1.1)', () => {
    const caps = capabilitiesForRole('student');
    expect(caps).toContain('app:access');
    expect(caps).toContain('portal:access');
    expect(caps).not.toContain('org:manage_settings');
    expect(caps).not.toContain('dispatch:access');
    expect(caps).not.toContain('dispatch:create');
    expect(caps).not.toContain('maintenance:access');
    expect(caps).not.toContain('maintenance:ground');
    expect(caps).not.toContain('maintenance:squawk');
    expect(caps).not.toContain('reporting:access');
    // STANDALONE: portal:access must NOT transitively grant training/people/fleet/schedule.
    expect(caps).not.toContain('training:access');
    expect(caps).not.toContain('people:access');
    expect(caps).not.toContain('fleet:access');
    expect(caps).not.toContain('schedule:access');
    expect(caps.length).toBe(2);
  });

  it('accountant returns app:access + reporting:access (2 caps)', () => {
    const caps = capabilitiesForRole('accountant');
    expect(caps).toContain('app:access');
    expect(caps).toContain('reporting:access');
    expect(caps).not.toContain('org:manage_settings');
    expect(caps).not.toContain('dispatch:access');
    expect(caps).not.toContain('schedule:access');
    expect(caps.length).toBe(2);
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

  it('contains the two DISPATCH-3a dispatch capabilities', () => {
    expect(CAPABILITIES).toContain('dispatch:access');
    expect(CAPABILITIES).toContain('dispatch:create');
  });

  it('contains the DISPATCH-3c dispatch:manage_requirements capability', () => {
    expect(CAPABILITIES).toContain('dispatch:manage_requirements');
  });

  it('contains the three MAINTENANCE-3b maintenance capabilities', () => {
    expect(CAPABILITIES).toContain('maintenance:access');
    expect(CAPABILITIES).toContain('maintenance:ground');
    expect(CAPABILITIES).toContain('maintenance:squawk');
  });

  it('contains the two FLEET-5 fleet capabilities', () => {
    expect(CAPABILITIES).toContain('fleet:access');
    expect(CAPABILITIES).toContain('fleet:manage');
  });

  it('contains the two PEOPLE-6 people capabilities', () => {
    expect(CAPABILITIES).toContain('people:access');
    expect(CAPABILITIES).toContain('people:manage');
  });

  it('contains the REPORTING-7 reporting capability', () => {
    expect(CAPABILITIES).toContain('reporting:access');
  });

  it('has exactly 20 capabilities (+ portal:access — P1.1)', () => {
    expect(CAPABILITIES.length).toBe(20);
  });

  it('contains the P1.1 portal:access capability', () => {
    expect(CAPABILITIES).toContain('portal:access');
  });

  it('grants maintenance:work_order to owner/manager/dispatcher/mechanic only (MAINTENANCE-M1.2)', () => {
    expect(CAPABILITIES).toContain('maintenance:work_order');
    for (const role of ['owner', 'manager', 'dispatcher', 'mechanic'] as const) {
      expect(capabilitiesForRole(role)).toContain('maintenance:work_order');
    }
    for (const role of ['cfi', 'accountant', 'renter', 'student'] as const) {
      expect(capabilitiesForRole(role)).not.toContain('maintenance:work_order');
    }
  });

  it('contains the two TRAINING-T1.2 training capabilities', () => {
    expect(CAPABILITIES).toContain('training:access');
    expect(CAPABILITIES).toContain('training:manage');
  });

  it('has no duplicate capabilities', () => {
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
  });

  it('is sorted alphabetically', () => {
    const sorted = [...CAPABILITIES].sort();
    expect([...CAPABILITIES]).toEqual(sorted);
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
      'dispatch:access',
      'dispatch:create',
      'dispatch:manage_requirements',
      'fleet:access',
      'fleet:manage',
      'maintenance:access',
      'maintenance:ground',
      'maintenance:squawk',
      'people:access',
      'people:manage',
      'reporting:access',
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

// ─── 13. DISPATCH-3a dispatch:* capabilities — exact grants ──────────────────

describe('13b. DISPATCH-3a dispatch:* capabilities', () => {
  const DISPATCH_GRANTED: MembershipRole[] = ['owner', 'manager', 'dispatcher', 'cfi'];
  const DISPATCH_EXCLUDED: MembershipRole[] = ['mechanic', 'renter', 'student', 'accountant'];

  describe('dispatch:access', () => {
    for (const role of DISPATCH_GRANTED) {
      it(`${role} HAS dispatch:access`, () => {
        expect(can(role, 'dispatch:access')).toBe(true);
      });
    }
    for (const role of DISPATCH_EXCLUDED) {
      it(`${role} does NOT have dispatch:access`, () => {
        expect(can(role, 'dispatch:access')).toBe(false);
      });
    }
  });

  describe('dispatch:create', () => {
    for (const role of DISPATCH_GRANTED) {
      it(`${role} HAS dispatch:create`, () => {
        expect(can(role, 'dispatch:create')).toBe(true);
      });
    }
    for (const role of DISPATCH_EXCLUDED) {
      it(`${role} does NOT have dispatch:create`, () => {
        expect(can(role, 'dispatch:create')).toBe(false);
      });
    }
  });

  it('dispatch:access grant set equals dispatch:create grant set', () => {
    for (const role of MEMBERSHIP_ROLES) {
      expect(can(role, 'dispatch:access')).toBe(can(role, 'dispatch:create'));
    }
  });

  it('dispatch:access grant set equals schedule:access grant set', () => {
    for (const role of MEMBERSHIP_ROLES) {
      expect(can(role, 'dispatch:access')).toBe(can(role, 'schedule:access'));
    }
  });

  it('excluded roles (mechanic/renter/student/accountant) have NEITHER dispatch cap', () => {
    for (const role of DISPATCH_EXCLUDED) {
      expect(can(role, 'dispatch:access')).toBe(false);
      expect(can(role, 'dispatch:create')).toBe(false);
    }
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

  it('excluded roles (renter/student/mechanic/accountant) have NONE of the three schedule capabilities', () => {
    for (const role of EXCLUDED) {
      expect(can(role, 'schedule:access')).toBe(false);
      expect(can(role, 'schedule:create_reservation')).toBe(false);
      expect(can(role, 'schedule:manage_resources')).toBe(false);
    }
  });

  it('renter and student have exactly app:access + portal:access and nothing else (P1.1)', () => {
    // NOTE: mechanic now has maintenance:access/ground/squawk (Slice 3b).
    // NOTE: accountant now has reporting:access (Slice 7 D3) — tested separately.
    // NOTE: renter/student now hold portal:access (Slice P1.1) — standalone self-service cap.
    for (const role of ['renter', 'student'] as const) {
      expect(capabilitiesForRole(role)).toEqual(['app:access', 'portal:access']);
    }
  });

  it('accountant has app:access + reporting:access (Slice 7 D3) and nothing else', () => {
    const caps = capabilitiesForRole('accountant');
    expect(caps).toContain('app:access');
    expect(caps).toContain('reporting:access');
    expect(caps.length).toBe(2);
    // Confirm no other schedule/dispatch/maintenance caps
    expect(can('accountant', 'schedule:access')).toBe(false);
    expect(can('accountant', 'dispatch:access')).toBe(false);
    expect(can('accountant', 'maintenance:access')).toBe(false);
    expect(can('accountant', 'org:manage_settings')).toBe(false);
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

// ─── 14. MAINTENANCE-3b maintenance:* capabilities — exact grants ─────────────
//
// Per ADR-0008 / Slice 3b conductor decisions:
//   maintenance:access → owner, manager, dispatcher, cfi, mechanic
//   maintenance:ground → owner, manager, dispatcher, mechanic  (NOT cfi)
//   maintenance:squawk → owner, manager, dispatcher, cfi, mechanic  (NOT renter/student)

describe('14. MAINTENANCE-3b maintenance:* capabilities', () => {
  const ACCESS_GRANTED: MembershipRole[] = ['owner', 'manager', 'dispatcher', 'cfi', 'mechanic'];
  const ACCESS_EXCLUDED: MembershipRole[] = ['renter', 'student', 'accountant'];

  const GROUND_GRANTED: MembershipRole[] = ['owner', 'manager', 'dispatcher', 'mechanic'];
  const GROUND_EXCLUDED: MembershipRole[] = ['cfi', 'renter', 'student', 'accountant'];

  const SQUAWK_GRANTED: MembershipRole[] = ['owner', 'manager', 'dispatcher', 'cfi', 'mechanic'];
  const SQUAWK_EXCLUDED: MembershipRole[] = ['renter', 'student', 'accountant'];

  describe('maintenance:access', () => {
    for (const role of ACCESS_GRANTED) {
      it(`${role} HAS maintenance:access`, () => {
        expect(can(role, 'maintenance:access')).toBe(true);
      });
    }
    for (const role of ACCESS_EXCLUDED) {
      it(`${role} does NOT have maintenance:access`, () => {
        expect(can(role, 'maintenance:access')).toBe(false);
      });
    }
  });

  describe('maintenance:ground', () => {
    for (const role of GROUND_GRANTED) {
      it(`${role} HAS maintenance:ground`, () => {
        expect(can(role, 'maintenance:ground')).toBe(true);
      });
    }
    for (const role of GROUND_EXCLUDED) {
      it(`${role} does NOT have maintenance:ground`, () => {
        expect(can(role, 'maintenance:ground')).toBe(false);
      });
    }

    it('cfi specifically does NOT have maintenance:ground', () => {
      expect(can('cfi', 'maintenance:ground')).toBe(false);
    });
  });

  describe('maintenance:squawk', () => {
    for (const role of SQUAWK_GRANTED) {
      it(`${role} HAS maintenance:squawk`, () => {
        expect(can(role, 'maintenance:squawk')).toBe(true);
      });
    }
    for (const role of SQUAWK_EXCLUDED) {
      it(`${role} does NOT have maintenance:squawk`, () => {
        expect(can(role, 'maintenance:squawk')).toBe(false);
      });
    }
  });

  it('maintenance:access grant set equals maintenance:squawk grant set', () => {
    for (const role of MEMBERSHIP_ROLES) {
      expect(can(role, 'maintenance:access')).toBe(can(role, 'maintenance:squawk'));
    }
  });

  it('maintenance:ground is a strict subset of maintenance:access (cfi has access but not ground)', () => {
    expect(can('cfi', 'maintenance:access')).toBe(true);
    expect(can('cfi', 'maintenance:ground')).toBe(false);
    for (const role of MEMBERSHIP_ROLES) {
      if (can(role, 'maintenance:ground')) {
        expect(can(role, 'maintenance:access')).toBe(true);
      }
    }
  });

  it('mechanic has maintenance:access, maintenance:ground, and maintenance:squawk', () => {
    expect(can('mechanic', 'maintenance:access')).toBe(true);
    expect(can('mechanic', 'maintenance:ground')).toBe(true);
    expect(can('mechanic', 'maintenance:squawk')).toBe(true);
  });

  it('mechanic still does NOT have schedule:access or dispatch:access', () => {
    expect(can('mechanic', 'schedule:access')).toBe(false);
    expect(can('mechanic', 'dispatch:access')).toBe(false);
  });

  it('renter and student have NONE of the three maintenance capabilities', () => {
    for (const role of ['renter', 'student'] as const) {
      expect(can(role, 'maintenance:access')).toBe(false);
      expect(can(role, 'maintenance:ground')).toBe(false);
      expect(can(role, 'maintenance:squawk')).toBe(false);
    }
  });
});

// ─── 15. FLEET-5 fleet:* capabilities — exact grants ─────────────────────────
//
// Per Slice 5 conductor decisions (2026-06-18):
//   fleet:access → owner, manager, dispatcher, cfi, mechanic
//   fleet:manage → owner, manager, dispatcher, mechanic  (NOT cfi)
//   renter/student/accountant get neither.

describe('15. FLEET-5 fleet:* capabilities', () => {
  const ACCESS_GRANTED: MembershipRole[] = ['owner', 'manager', 'dispatcher', 'cfi', 'mechanic'];
  const ACCESS_EXCLUDED: MembershipRole[] = ['renter', 'student', 'accountant'];

  const MANAGE_GRANTED: MembershipRole[] = ['owner', 'manager', 'dispatcher', 'mechanic'];
  const MANAGE_EXCLUDED: MembershipRole[] = ['cfi', 'renter', 'student', 'accountant'];

  describe('fleet:access', () => {
    for (const role of ACCESS_GRANTED) {
      it(`${role} HAS fleet:access`, () => {
        expect(can(role, 'fleet:access')).toBe(true);
      });
    }
    for (const role of ACCESS_EXCLUDED) {
      it(`${role} does NOT have fleet:access`, () => {
        expect(can(role, 'fleet:access')).toBe(false);
      });
    }
  });

  describe('fleet:manage', () => {
    for (const role of MANAGE_GRANTED) {
      it(`${role} HAS fleet:manage`, () => {
        expect(can(role, 'fleet:manage')).toBe(true);
      });
    }
    for (const role of MANAGE_EXCLUDED) {
      it(`${role} does NOT have fleet:manage`, () => {
        expect(can(role, 'fleet:manage')).toBe(false);
      });
    }

    it('cfi specifically does NOT have fleet:manage (read-only, cannot edit identity)', () => {
      expect(can('cfi', 'fleet:manage')).toBe(false);
    });
  });

  it('fleet:manage is a strict subset of fleet:access (cfi has access but not manage)', () => {
    expect(can('cfi', 'fleet:access')).toBe(true);
    expect(can('cfi', 'fleet:manage')).toBe(false);
    for (const role of MEMBERSHIP_ROLES) {
      if (can(role, 'fleet:manage')) {
        expect(can(role, 'fleet:access')).toBe(true);
      }
    }
  });

  it('mechanic has fleet:access AND fleet:manage', () => {
    expect(can('mechanic', 'fleet:access')).toBe(true);
    expect(can('mechanic', 'fleet:manage')).toBe(true);
  });

  it('renter/student/accountant have NEITHER fleet cap', () => {
    for (const role of ['renter', 'student', 'accountant'] as const) {
      expect(can(role, 'fleet:access')).toBe(false);
      expect(can(role, 'fleet:manage')).toBe(false);
    }
  });

  it('fleet:access grant set matches maintenance:access grant set', () => {
    // Both: owner/manager/dispatcher/cfi/mechanic
    for (const role of MEMBERSHIP_ROLES) {
      expect(can(role, 'fleet:access')).toBe(can(role, 'maintenance:access'));
    }
  });

  it('fleet:manage grant set matches maintenance:ground grant set', () => {
    // Both: owner/manager/dispatcher/mechanic (NOT cfi)
    for (const role of MEMBERSHIP_ROLES) {
      expect(can(role, 'fleet:manage')).toBe(can(role, 'maintenance:ground'));
    }
  });
});

// ─── 16. PEOPLE-6 people:* capabilities — exact grants ────────────────────────
//
// Per Slice 6 conductor decisions (2026-06-19):
//   people:access → owner, manager, dispatcher, cfi (read roster)
//   people:manage → owner, manager ONLY (NOT dispatcher/cfi)
//   mechanic/renter/student/accountant get neither.

describe('16. PEOPLE-6 people:* capabilities', () => {
  const ACCESS_GRANTED: MembershipRole[] = ['owner', 'manager', 'dispatcher', 'cfi'];
  const ACCESS_EXCLUDED: MembershipRole[] = ['mechanic', 'renter', 'student', 'accountant'];

  const MANAGE_GRANTED: MembershipRole[] = ['owner', 'manager'];
  const MANAGE_EXCLUDED: MembershipRole[] = ['dispatcher', 'cfi', 'mechanic', 'renter', 'student', 'accountant'];

  describe('people:access', () => {
    for (const role of ACCESS_GRANTED) {
      it(`${role} HAS people:access`, () => {
        expect(can(role, 'people:access')).toBe(true);
      });
    }
    for (const role of ACCESS_EXCLUDED) {
      it(`${role} does NOT have people:access`, () => {
        expect(can(role, 'people:access')).toBe(false);
      });
    }
  });

  describe('people:manage', () => {
    for (const role of MANAGE_GRANTED) {
      it(`${role} HAS people:manage`, () => {
        expect(can(role, 'people:manage')).toBe(true);
      });
    }
    for (const role of MANAGE_EXCLUDED) {
      it(`${role} does NOT have people:manage`, () => {
        expect(can(role, 'people:manage')).toBe(false);
      });
    }

    it('dispatcher specifically does NOT have people:manage (read-only, cannot edit roles/status/tags)', () => {
      expect(can('dispatcher', 'people:manage')).toBe(false);
    });

    it('cfi specifically does NOT have people:manage (read-only, cannot edit roles/status/tags)', () => {
      expect(can('cfi', 'people:manage')).toBe(false);
    });
  });

  it('people:manage is a strict subset of people:access (dispatcher/cfi have access but not manage)', () => {
    expect(can('dispatcher', 'people:access')).toBe(true);
    expect(can('dispatcher', 'people:manage')).toBe(false);
    expect(can('cfi', 'people:access')).toBe(true);
    expect(can('cfi', 'people:manage')).toBe(false);
    for (const role of MEMBERSHIP_ROLES) {
      if (can(role, 'people:manage')) {
        expect(can(role, 'people:access')).toBe(true);
      }
    }
  });

  it('mechanic/renter/student/accountant have NEITHER people cap', () => {
    for (const role of ['mechanic', 'renter', 'student', 'accountant'] as const) {
      expect(can(role, 'people:access')).toBe(false);
      expect(can(role, 'people:manage')).toBe(false);
    }
  });

  it('people:access grant set equals schedule:access grant set', () => {
    // Both: owner/manager/dispatcher/cfi
    for (const role of MEMBERSHIP_ROLES) {
      expect(can(role, 'people:access')).toBe(can(role, 'schedule:access'));
    }
  });

  it('people:manage grant set equals org:manage_settings grant set', () => {
    // Both: owner/manager only
    for (const role of MEMBERSHIP_ROLES) {
      expect(can(role, 'people:manage')).toBe(can(role, 'org:manage_settings'));
    }
  });
});

// ─── 15. DISPATCH-3c dispatch:manage_requirements — exact grants ───────────────
//
// Per Slice 3c conductor decisions (2026-06-19):
//   dispatch:manage_requirements → owner, manager, dispatcher
//   cfi, mechanic, renter, student, accountant do NOT have this capability.

describe('15. DISPATCH-3c dispatch:manage_requirements', () => {
  const GRANTED: MembershipRole[] = ['owner', 'manager', 'dispatcher'];
  const DENIED: MembershipRole[] = ['cfi', 'mechanic', 'renter', 'student', 'accountant'];

  for (const role of GRANTED) {
    it(`${role} HAS dispatch:manage_requirements`, () => {
      expect(can(role, 'dispatch:manage_requirements')).toBe(true);
    });
  }

  for (const role of DENIED) {
    it(`${role} does NOT have dispatch:manage_requirements`, () => {
      expect(can(role, 'dispatch:manage_requirements')).toBe(false);
    });
  }

  it('cfi specifically does NOT have dispatch:manage_requirements (can access/create but not manage requirements)', () => {
    expect(can('cfi', 'dispatch:access')).toBe(true);
    expect(can('cfi', 'dispatch:create')).toBe(true);
    expect(can('cfi', 'dispatch:manage_requirements')).toBe(false);
  });

  it('mechanic has no dispatch capabilities at all', () => {
    expect(can('mechanic', 'dispatch:access')).toBe(false);
    expect(can('mechanic', 'dispatch:create')).toBe(false);
    expect(can('mechanic', 'dispatch:manage_requirements')).toBe(false);
  });

  it('dispatcher HAS dispatch:manage_requirements (can configure requirements for check-out)', () => {
    expect(can('dispatcher', 'dispatch:access')).toBe(true);
    expect(can('dispatcher', 'dispatch:create')).toBe(true);
    expect(can('dispatcher', 'dispatch:manage_requirements')).toBe(true);
  });

  it('dispatch:manage_requirements grant set = {owner, manager, dispatcher} (3 roles)', () => {
    const grantedRoles = MEMBERSHIP_ROLES.filter((r) => can(r, 'dispatch:manage_requirements'));
    expect(grantedRoles.sort()).toEqual(['dispatcher', 'manager', 'owner']);
  });

  it('dispatch:manage_requirements is a subset of dispatch:access (all who manage also have access)', () => {
    for (const role of MEMBERSHIP_ROLES) {
      if (can(role, 'dispatch:manage_requirements')) {
        expect(can(role, 'dispatch:access')).toBe(true);
      }
    }
  });

  it('renter and student have no dispatch capabilities', () => {
    for (const role of ['renter', 'student'] as const) {
      expect(can(role, 'dispatch:access')).toBe(false);
      expect(can(role, 'dispatch:create')).toBe(false);
      expect(can(role, 'dispatch:manage_requirements')).toBe(false);
    }
  });

  it('accountant has no dispatch capabilities', () => {
    expect(can('accountant', 'dispatch:access')).toBe(false);
    expect(can('accountant', 'dispatch:create')).toBe(false);
    expect(can('accountant', 'dispatch:manage_requirements')).toBe(false);
  });
});

// ─── 17. REPORTING-7 reporting:access — exact grants ──────────────────────────
//
// Per Slice 7 conductor decisions (D3, 2026-06-19):
//   reporting:access → owner, manager, dispatcher, cfi, accountant
//   mechanic/renter/student do NOT get reporting:access.
//   accountant included: utilization closest to their domain; carries zero money.

describe('17. REPORTING-7 reporting:access', () => {
  const GRANTED: MembershipRole[] = ['owner', 'manager', 'dispatcher', 'cfi', 'accountant'];
  const DENIED:  MembershipRole[] = ['mechanic', 'renter', 'student'];

  for (const role of GRANTED) {
    it(`${role} HAS reporting:access`, () => {
      expect(can(role, 'reporting:access')).toBe(true);
    });
  }

  for (const role of DENIED) {
    it(`${role} does NOT have reporting:access`, () => {
      expect(can(role, 'reporting:access')).toBe(false);
    });
  }

  it('accountant specifically has reporting:access (unique in Slice 7)', () => {
    expect(can('accountant', 'reporting:access')).toBe(true);
    // But accountant still lacks the other operational caps
    expect(can('accountant', 'dispatch:access')).toBe(false);
    expect(can('accountant', 'schedule:access')).toBe(false);
    expect(can('accountant', 'fleet:access')).toBe(false);
    expect(can('accountant', 'maintenance:access')).toBe(false);
  });

  it('mechanic specifically does NOT have reporting:access', () => {
    expect(can('mechanic', 'reporting:access')).toBe(false);
    // mechanic has maintenance caps but not reporting
    expect(can('mechanic', 'maintenance:access')).toBe(true);
  });

  it('renter and student do NOT have reporting:access', () => {
    expect(can('renter', 'reporting:access')).toBe(false);
    expect(can('student', 'reporting:access')).toBe(false);
  });

  it('reporting:access grant set = {owner,manager,dispatcher,cfi,accountant} (5 roles)', () => {
    const grantedRoles = MEMBERSHIP_ROLES.filter((r) => can(r, 'reporting:access'));
    expect(grantedRoles.sort()).toEqual(['accountant', 'cfi', 'dispatcher', 'manager', 'owner']);
  });
});

// ─── 18. P1.1 portal:access — exact grants + standalone (no transitive) ────────
//
// Per Slice P1.1 (resolves [VERIFY-T1-H]):
//   portal:access → owner, manager, student, renter
//   cfi/dispatcher/accountant/mechanic do NOT get portal:access.
//   STANDALONE: portal:access must NOT transitively grant
//   training/people/fleet/schedule access — the portal reads are SEPARATE
//   functions gated solely on portal:access + self-scoped to session.userId.

describe('18. P1.1 portal:access', () => {
  const GRANTED: MembershipRole[] = ['owner', 'manager', 'student', 'renter'];
  const DENIED:  MembershipRole[] = ['cfi', 'dispatcher', 'accountant', 'mechanic'];

  it('portal:access ∈ CAPABILITIES (sorted, no dup)', () => {
    expect(CAPABILITIES).toContain('portal:access');
    expect([...CAPABILITIES]).toEqual([...CAPABILITIES].sort());
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
  });

  for (const role of GRANTED) {
    it(`${role} HAS portal:access`, () => {
      expect(can(role, 'portal:access')).toBe(true);
    });
  }

  for (const role of DENIED) {
    it(`${role} does NOT have portal:access`, () => {
      expect(can(role, 'portal:access')).toBe(false);
    });
  }

  it('portal:access grant set = {owner, manager, renter, student} (4 roles)', () => {
    const grantedRoles = MEMBERSHIP_ROLES.filter((r) => can(r, 'portal:access'));
    expect(grantedRoles.sort()).toEqual(['manager', 'owner', 'renter', 'student']);
  });

  it('REGRESSION GUARD: can(student, training:access) === false (broad training access stays revoked)', () => {
    expect(can('student', 'training:access')).toBe(false);
    expect(can('student', 'training:manage')).toBe(false);
  });

  it('STANDALONE: student/renter with portal:access do NOT transitively get staff caps', () => {
    for (const role of ['student', 'renter'] as const) {
      expect(can(role, 'portal:access')).toBe(true);
      expect(can(role, 'training:access')).toBe(false);
      expect(can(role, 'people:access')).toBe(false);
      expect(can(role, 'fleet:access')).toBe(false);
      expect(can(role, 'schedule:access')).toBe(false);
      expect(can(role, 'dispatch:access')).toBe(false);
      expect(can(role, 'reporting:access')).toBe(false);
    }
  });

  it('mechanic does NOT have portal:access', () => {
    expect(can('mechanic', 'portal:access')).toBe(false);
  });
});
