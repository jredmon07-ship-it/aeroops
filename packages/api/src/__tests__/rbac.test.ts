/**
 * rbac.test.ts — Slice 0.3 RBAC enforcement tests.
 *
 * COVERAGE:
 *
 *   1. requireCapability — app:access (all 8 roles pass)
 *   2. requireCapability — org:manage_settings (owner + manager pass; 6 others throw ForbiddenError)
 *   3. requireCapability — null/incomplete session → UnauthenticatedError
 *   4. ForbiddenError shape (code, capability, instanceof)
 *   5. hasCapability — never throws; correct booleans; null/incomplete session → false
 *   6. Adversarial: prototype-key roles — requireCapability throws ForbiddenError or
 *      UnauthenticatedError (NEVER TypeError); hasCapability returns false (never throws).
 *   7. Session-boundary guard: a session built from a token with an invalid role
 *      behaves as unauthenticated (sessionCallback omits role → requireCapability
 *      throws UnauthenticatedError; hasCapability returns false).
 *
 * These are pure unit tests (no DB needed).
 */

import { describe, it, expect } from 'vitest';
import { MEMBERSHIP_ROLES } from '@aeroops/core';
import type { MembershipRole, Capability } from '@aeroops/core';
import {
  requireCapability,
  hasCapability,
  ForbiddenError,
} from '../auth/require-capability.js';
import { UnauthenticatedError } from '../auth/session.js';
import { sessionCallback, jwtCallback } from '../auth/edge-callbacks.js';
import type { AppSession } from '../auth/types.js';

// Prototype-key role strings that would previously escape the lookup table.
const PROTOTYPE_KEY_ROLES = [
  'constructor',
  'toString',
  'valueOf',
  'hasOwnProperty',
  '__proto__',
  'prototype',
  '',
] as const;

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

// ═════════════════════════════════════════════════════════════════════════════
// 1. requireCapability — app:access
// ═════════════════════════════════════════════════════════════════════════════

describe('1. requireCapability — app:access (all 8 roles pass)', () => {
  for (const role of MEMBERSHIP_ROLES) {
    it(`${role} can app:access`, () => {
      const session = makeSession(role);
      const result = requireCapability(session, 'app:access');
      // Must return the same session object (narrowed)
      expect(result).toBe(session);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. requireCapability — org:manage_settings
// ═════════════════════════════════════════════════════════════════════════════

describe('2. requireCapability — org:manage_settings', () => {
  it('owner passes org:manage_settings', () => {
    const session = makeSession('owner');
    expect(() => requireCapability(session, 'org:manage_settings')).not.toThrow();
    expect(requireCapability(session, 'org:manage_settings')).toBe(session);
  });

  it('manager passes org:manage_settings', () => {
    const session = makeSession('manager');
    expect(() => requireCapability(session, 'org:manage_settings')).not.toThrow();
    expect(requireCapability(session, 'org:manage_settings')).toBe(session);
  });

  const restrictedRoles: MembershipRole[] = [
    'dispatcher',
    'cfi',
    'mechanic',
    'renter',
    'student',
    'accountant',
  ];

  for (const role of restrictedRoles) {
    it(`${role} throws ForbiddenError for org:manage_settings`, () => {
      const session = makeSession(role);
      expect(() => requireCapability(session, 'org:manage_settings')).toThrow(ForbiddenError);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. requireCapability — null/incomplete session → UnauthenticatedError
// ═════════════════════════════════════════════════════════════════════════════

describe('3. requireCapability — null/incomplete session → UnauthenticatedError', () => {
  it('null session → UnauthenticatedError', () => {
    expect(() => requireCapability(null, 'app:access')).toThrow(UnauthenticatedError);
  });

  it('undefined session → UnauthenticatedError', () => {
    expect(() => requireCapability(undefined, 'app:access')).toThrow(UnauthenticatedError);
  });

  it('session missing userId → UnauthenticatedError', () => {
    const badSession = makeSession('owner', { userId: '' });
    expect(() => requireCapability(badSession, 'app:access')).toThrow(UnauthenticatedError);
  });

  it('session missing orgId → UnauthenticatedError', () => {
    const badSession = makeSession('owner', { orgId: '' });
    expect(() => requireCapability(badSession, 'app:access')).toThrow(UnauthenticatedError);
  });

  it('session missing role → UnauthenticatedError', () => {
    const badSession = makeSession('owner', { role: '' as MembershipRole });
    expect(() => requireCapability(badSession, 'app:access')).toThrow(UnauthenticatedError);
  });

  it('UnauthenticatedError takes priority over ForbiddenError (missing orgId + restricted cap)', () => {
    // Even if the role WOULD fail capability check, the missing session field
    // must produce UnauthenticatedError, not ForbiddenError.
    const badSession = makeSession('student', { orgId: '' });
    expect(() => requireCapability(badSession, 'org:manage_settings')).toThrow(UnauthenticatedError);
    expect(() => requireCapability(badSession, 'org:manage_settings')).not.toThrow(ForbiddenError);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. ForbiddenError shape
// ═════════════════════════════════════════════════════════════════════════════

describe('4. ForbiddenError shape', () => {
  it('has code === FORBIDDEN', () => {
    const session = makeSession('student');
    let err: unknown;
    try {
      requireCapability(session, 'org:manage_settings');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).code).toBe('FORBIDDEN');
  });

  it('carries the attempted capability on .capability', () => {
    const session = makeSession('renter');
    let err: unknown;
    try {
      requireCapability(session, 'org:manage_settings');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForbiddenError);
    expect((err as ForbiddenError).capability).toBe('org:manage_settings');
  });

  it('is an instanceof Error', () => {
    const session = makeSession('mechanic');
    let err: unknown;
    try {
      requireCapability(session, 'org:manage_settings');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  it('has a meaningful message including the role and capability', () => {
    const session = makeSession('cfi');
    let err: unknown;
    try {
      requireCapability(session, 'org:manage_settings');
    } catch (e) {
      err = e;
    }
    expect((err as ForbiddenError).message).toContain('cfi');
    expect((err as ForbiddenError).message).toContain('org:manage_settings');
  });

  it('ForbiddenError capability field typed as Capability (structural check)', () => {
    const err = new ForbiddenError('org:manage_settings', 'student');
    // If TypeScript compiled, the type is correct. Runtime check:
    const cap: Capability = err.capability;
    expect(cap).toBe('org:manage_settings');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. hasCapability — never throws, correct booleans
// ═════════════════════════════════════════════════════════════════════════════

describe('5. hasCapability — never throws; correct booleans', () => {
  it('never throws for null session', () => {
    expect(() => hasCapability(null, 'app:access')).not.toThrow();
    expect(hasCapability(null, 'app:access')).toBe(false);
  });

  it('never throws for undefined session', () => {
    expect(() => hasCapability(undefined, 'org:manage_settings')).not.toThrow();
    expect(hasCapability(undefined, 'org:manage_settings')).toBe(false);
  });

  it('null session → false for any capability', () => {
    expect(hasCapability(null, 'app:access')).toBe(false);
    expect(hasCapability(null, 'org:manage_settings')).toBe(false);
  });

  it('session missing role → false', () => {
    const badSession = makeSession('owner', { role: '' as MembershipRole });
    expect(hasCapability(badSession, 'app:access')).toBe(false);
    expect(hasCapability(badSession, 'org:manage_settings')).toBe(false);
  });

  it('owner: app:access → true', () => {
    expect(hasCapability(makeSession('owner'), 'app:access')).toBe(true);
  });

  it('owner: org:manage_settings → true', () => {
    expect(hasCapability(makeSession('owner'), 'org:manage_settings')).toBe(true);
  });

  it('student: app:access → true', () => {
    expect(hasCapability(makeSession('student'), 'app:access')).toBe(true);
  });

  it('student: org:manage_settings → false', () => {
    expect(hasCapability(makeSession('student'), 'org:manage_settings')).toBe(false);
  });

  it('all 8 roles return true for app:access', () => {
    for (const role of MEMBERSHIP_ROLES) {
      expect(hasCapability(makeSession(role), 'app:access')).toBe(true);
    }
  });

  it('only owner + manager return true for org:manage_settings', () => {
    const permitted: MembershipRole[] = ['owner', 'manager'];
    const denied: MembershipRole[] = ['dispatcher', 'cfi', 'mechanic', 'renter', 'student', 'accountant'];

    for (const role of permitted) {
      expect(hasCapability(makeSession(role), 'org:manage_settings')).toBe(true);
    }
    for (const role of denied) {
      expect(hasCapability(makeSession(role), 'org:manage_settings')).toBe(false);
    }
  });

  it('incomplete session (missing orgId) still returns boolean, never throws', () => {
    const incompleteSession = makeSession('owner', { orgId: '' });
    // hasCapability only checks session.role, so orgId doesn't affect it
    // but it should not throw regardless
    expect(() => hasCapability(incompleteSession, 'app:access')).not.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Adversarial: prototype-key roles — fail-closed, never TypeError
//
// A session whose role field is a prototype-chain key ('constructor', 'toString',
// '__proto__', etc.) must:
//   - requireCapability: throw ForbiddenError OR UnauthenticatedError (the empty
//     string '' is falsy and hits the UnauthenticatedError path; the non-empty
//     prototype keys are truthy so they pass the session-incomplete guard and
//     reach can(), which returns false → ForbiddenError). Either is acceptable;
//     the important invariant is NO TypeError.
//   - hasCapability: return false without throwing.
// ═════════════════════════════════════════════════════════════════════════════

describe('6. Adversarial: prototype-key roles — no TypeError, fail-closed', () => {
  for (const protoRole of PROTOTYPE_KEY_ROLES) {
    it(`requireCapability with role='${protoRole}' throws ForbiddenError or UnauthenticatedError (NOT TypeError)`, () => {
      const session = makeSession('owner', { role: protoRole as MembershipRole });
      let caught: unknown;
      try {
        requireCapability(session, 'app:access');
      } catch (e) {
        caught = e;
      }
      // Must have thrown something
      expect(caught).toBeDefined();
      // Must NOT be a TypeError
      expect(caught).not.toBeInstanceOf(TypeError);
      // Must be one of the two known auth errors
      const isKnownError =
        caught instanceof ForbiddenError || caught instanceof UnauthenticatedError;
      expect(isKnownError).toBe(true);
    });

    it(`hasCapability with role='${protoRole}' returns false (no throw)`, () => {
      const session = makeSession('owner', { role: protoRole as MembershipRole });
      expect(() => hasCapability(session, 'app:access')).not.toThrow();
      expect(hasCapability(session, 'app:access')).toBe(false);
    });

    it(`hasCapability with role='${protoRole}' returns false for org:manage_settings (no throw)`, () => {
      const session = makeSession('owner', { role: protoRole as MembershipRole });
      expect(() => hasCapability(session, 'org:manage_settings')).not.toThrow();
      expect(hasCapability(session, 'org:manage_settings')).toBe(false);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Session-boundary guard: invalid role in token → session has no role →
//    downstream behaves as unauthenticated (UnauthenticatedError / false).
//
// sessionCallback validates token['role'] with isMembershipRole(). If the
// role is invalid, it is omitted from session.role. The resulting session
// behaves identically to one with a missing role field.
// ═════════════════════════════════════════════════════════════════════════════

describe('7. Session-boundary guard: invalid token role → unauthenticated behaviour', () => {
  const invalidRoles = [
    'constructor',
    'toString',
    '__proto__',
    'admin',
    'superuser',
    '',
    123,
    null,
    undefined,
  ];

  for (const badRole of invalidRoles) {
    it(`sessionCallback with token role=${JSON.stringify(badRole)} produces session without role`, async () => {
      const token = {
        userId: 'user-uuid',
        orgId: 'org-uuid',
        slug: 'alpha',
        role: badRole,
        email: 'test@example.com',
      };
      const session: Record<string, unknown> = { expires: '2099-01-01T00:00:00.000Z' };
      const result = await sessionCallback({ session, token });
      // role must be absent (not written) when the value is not a valid MembershipRole
      expect(result.role).toBeUndefined();
    });

    it(`requireCapability throws UnauthenticatedError when session built from token with role=${JSON.stringify(badRole)}`, async () => {
      const token = {
        userId: 'user-uuid',
        orgId: 'org-uuid',
        slug: 'alpha',
        role: badRole,
        email: 'test@example.com',
      };
      const session: Record<string, unknown> = { expires: '2099-01-01T00:00:00.000Z' };
      const result = await sessionCallback({ session, token });
      // The session produced by sessionCallback must behave as unauthenticated
      expect(() =>
        requireCapability(result as unknown as AppSession, 'app:access'),
      ).toThrow(UnauthenticatedError);
    });

    it(`hasCapability returns false when session built from token with role=${JSON.stringify(badRole)}`, async () => {
      const token = {
        userId: 'user-uuid',
        orgId: 'org-uuid',
        slug: 'alpha',
        role: badRole,
        email: 'test@example.com',
      };
      const session: Record<string, unknown> = { expires: '2099-01-01T00:00:00.000Z' };
      const result = await sessionCallback({ session, token });
      expect(() => hasCapability(result as unknown as AppSession, 'app:access')).not.toThrow();
      expect(hasCapability(result as unknown as AppSession, 'app:access')).toBe(false);
    });
  }

  it('jwtCallback with invalid role does NOT write role to token', async () => {
    const token = { sub: 'sub', iat: 123 };
    const user = {
      id: 'user-uuid',
      orgId: 'org-uuid',
      slug: 'alpha',
      role: 'constructor', // prototype key — invalid
      email: 'test@example.com',
    };
    const result = await jwtCallback({ token, user });
    // role must NOT be written to the token
    expect(result['role']).toBeUndefined();
    // Other fields must be written
    expect(result['userId']).toBe('user-uuid');
    expect(result['orgId']).toBe('org-uuid');
  });

  it('jwtCallback with valid role DOES write role to token (happy path unchanged)', async () => {
    const token = { sub: 'sub', iat: 123 };
    const user = {
      id: 'user-uuid',
      orgId: 'org-uuid',
      slug: 'alpha',
      role: 'owner', // valid
      email: 'test@example.com',
    };
    const result = await jwtCallback({ token, user });
    expect(result['role']).toBe('owner');
  });
});
