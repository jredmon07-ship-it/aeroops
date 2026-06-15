/**
 * auth-errors.test.ts — Pure unit tests for mapAuthErrorToResponse (lib/auth-errors.ts).
 *
 * COVERAGE:
 *
 *   1. ForbiddenError → returns 'forbidden'
 *   2. UnauthenticatedError → returns 'login'
 *   3. Generic Error → returns 'rethrow'
 *   4. Non-Error values (strings, numbers, null, undefined) → returns 'rethrow'
 *   5. Subclasses of Error that are not ForbiddenError/UnauthenticatedError → 'rethrow'
 *   6. ForbiddenError subclass → 'forbidden' (instanceof chain)
 *   7. Return type is always a valid AuthErrorAction
 *   8. Does not throw under any circumstance
 *
 * These are PURE unit tests — no DOM, no Next.js, no DB.
 *
 * Context (from lib/auth-errors.ts):
 *   This helper is the bridge between requireCapability() errors and Next.js
 *   redirect() calls in settings/page.tsx. The function is pure so it is
 *   independently testable.
 */

import { describe, it, expect } from 'vitest';
import { ForbiddenError, UnauthenticatedError } from '@aeroops/api';
import { mapAuthErrorToResponse } from '../auth-errors';
import type { AuthErrorAction } from '../auth-errors';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function assertValidAction(action: unknown): asserts action is AuthErrorAction {
  expect(['forbidden', 'login', 'rethrow']).toContain(action);
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. ForbiddenError → 'forbidden'
// ═════════════════════════════════════════════════════════════════════════════

describe('1. ForbiddenError → forbidden', () => {
  it('direct ForbiddenError returns "forbidden"', () => {
    const err = new ForbiddenError('org:manage_settings', 'student');
    expect(mapAuthErrorToResponse(err)).toBe('forbidden');
  });

  it('ForbiddenError from any role returns "forbidden"', () => {
    const roles = ['student', 'dispatcher', 'cfi', 'mechanic', 'renter', 'accountant'];
    for (const role of roles) {
      const err = new ForbiddenError('org:manage_settings', role);
      expect(mapAuthErrorToResponse(err)).toBe('forbidden');
    }
  });

  it('ForbiddenError with app:access cap (hypothetical) still returns "forbidden"', () => {
    // This shouldn't happen at runtime but the mapping is cap-agnostic
    const err = new ForbiddenError('app:access', 'student');
    expect(mapAuthErrorToResponse(err)).toBe('forbidden');
  });

  it('ForbiddenError instanceof check works through mapAuthErrorToResponse', () => {
    const err = new ForbiddenError('org:manage_settings', 'renter');
    const action = mapAuthErrorToResponse(err);
    expect(action).toBe('forbidden');
    expect(action).not.toBe('login');
    expect(action).not.toBe('rethrow');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. UnauthenticatedError → 'login'
// ═════════════════════════════════════════════════════════════════════════════

describe('2. UnauthenticatedError → login', () => {
  it('direct UnauthenticatedError returns "login"', () => {
    const err = new UnauthenticatedError('No session');
    expect(mapAuthErrorToResponse(err)).toBe('login');
  });

  it('UnauthenticatedError with any message returns "login"', () => {
    const messages = [
      'No session found',
      '[withSessionOrgContext] No authenticated session.',
      '[requireCapability] No authenticated session.',
      '',
    ];
    for (const msg of messages) {
      const err = new UnauthenticatedError(msg);
      expect(mapAuthErrorToResponse(err)).toBe('login');
    }
  });

  it('UnauthenticatedError result is not "forbidden"', () => {
    const err = new UnauthenticatedError('session expired');
    const action = mapAuthErrorToResponse(err);
    expect(action).toBe('login');
    expect(action).not.toBe('forbidden');
    expect(action).not.toBe('rethrow');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Generic Error → 'rethrow'
// ═════════════════════════════════════════════════════════════════════════════

describe('3. Generic Error → rethrow', () => {
  it('plain Error returns "rethrow"', () => {
    const err = new Error('something went wrong');
    expect(mapAuthErrorToResponse(err)).toBe('rethrow');
  });

  it('TypeError returns "rethrow"', () => {
    const err = new TypeError('type error');
    expect(mapAuthErrorToResponse(err)).toBe('rethrow');
  });

  it('RangeError returns "rethrow"', () => {
    const err = new RangeError('range error');
    expect(mapAuthErrorToResponse(err)).toBe('rethrow');
  });

  it('SyntaxError returns "rethrow"', () => {
    const err = new SyntaxError('syntax error');
    expect(mapAuthErrorToResponse(err)).toBe('rethrow');
  });

  it('Error with message that looks like auth returns "rethrow"', () => {
    // An error whose message contains "FORBIDDEN" but is not a ForbiddenError class
    const err = new Error('FORBIDDEN — access denied');
    expect(mapAuthErrorToResponse(err)).toBe('rethrow');
  });

  it('Error with message that looks like "UNAUTHENTICATED" returns "rethrow"', () => {
    const err = new Error('UNAUTHENTICATED');
    expect(mapAuthErrorToResponse(err)).toBe('rethrow');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Non-Error values → 'rethrow'
// ═════════════════════════════════════════════════════════════════════════════

describe('4. Non-Error values (string, number, null, undefined, object) → rethrow', () => {
  it('string throws → "rethrow"', () => {
    expect(mapAuthErrorToResponse('forbidden')).toBe('rethrow');
  });

  it('number → "rethrow"', () => {
    expect(mapAuthErrorToResponse(403)).toBe('rethrow');
  });

  it('null → "rethrow"', () => {
    expect(mapAuthErrorToResponse(null)).toBe('rethrow');
  });

  it('undefined → "rethrow"', () => {
    expect(mapAuthErrorToResponse(undefined)).toBe('rethrow');
  });

  it('plain object → "rethrow"', () => {
    expect(mapAuthErrorToResponse({ code: 'FORBIDDEN' })).toBe('rethrow');
  });

  it('empty object → "rethrow"', () => {
    expect(mapAuthErrorToResponse({})).toBe('rethrow');
  });

  it('false → "rethrow"', () => {
    expect(mapAuthErrorToResponse(false)).toBe('rethrow');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Error subclasses that are not ForbiddenError or UnauthenticatedError
// ═════════════════════════════════════════════════════════════════════════════

describe('5. Unknown Error subclasses → rethrow', () => {
  class CustomAppError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'CustomAppError';
    }
  }

  class DatabaseError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'DatabaseError';
    }
  }

  it('custom app error → "rethrow"', () => {
    expect(mapAuthErrorToResponse(new CustomAppError('db error'))).toBe('rethrow');
  });

  it('database error → "rethrow"', () => {
    expect(mapAuthErrorToResponse(new DatabaseError('connection failed'))).toBe('rethrow');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Instanceof chain correctness
// ═════════════════════════════════════════════════════════════════════════════

describe('6. Instanceof check is class-based (not duck-typed)', () => {
  it('object with code=FORBIDDEN but not ForbiddenError class → rethrow', () => {
    const fakeErr = { code: 'FORBIDDEN', capability: 'org:manage_settings', message: 'Denied' };
    expect(mapAuthErrorToResponse(fakeErr)).toBe('rethrow');
  });

  it('object with code=UNAUTHENTICATED but not UnauthenticatedError class → rethrow', () => {
    const fakeErr = { code: 'UNAUTHENTICATED', message: 'No session' };
    expect(mapAuthErrorToResponse(fakeErr)).toBe('rethrow');
  });

  it('ForbiddenError is an instanceof Error (not just ForbiddenError)', () => {
    const err = new ForbiddenError('org:manage_settings', 'student');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ForbiddenError);
  });

  it('ForbiddenError instanceof check produces forbidden, not rethrow', () => {
    const err = new ForbiddenError('org:manage_settings', 'student');
    // Verify it IS an Error but still maps to 'forbidden', not 'rethrow'
    expect(err instanceof Error).toBe(true);
    expect(mapAuthErrorToResponse(err)).toBe('forbidden');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. Return type is always a valid AuthErrorAction
// ═════════════════════════════════════════════════════════════════════════════

describe('7. Return type is always a valid AuthErrorAction', () => {
  const testCases: unknown[] = [
    new ForbiddenError('org:manage_settings', 'student'),
    new UnauthenticatedError('no session'),
    new Error('generic'),
    null,
    undefined,
    'string',
    42,
    {},
  ];

  for (const [idx, testCase] of testCases.entries()) {
    it(`test case ${idx} produces a valid AuthErrorAction`, () => {
      const action = mapAuthErrorToResponse(testCase);
      assertValidAction(action);
    });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Does not throw under any circumstance
// ═════════════════════════════════════════════════════════════════════════════

describe('8. mapAuthErrorToResponse never throws', () => {
  const edgeCases: unknown[] = [
    new ForbiddenError('org:manage_settings', 'student'),
    new UnauthenticatedError('no session'),
    new Error('generic'),
    null,
    undefined,
    'string error',
    0,
    false,
    [],
    {},
    Symbol('symbol'),
    42n, // bigint
  ];

  for (const [idx, val] of edgeCases.entries()) {
    it(`case ${idx}: mapAuthErrorToResponse(${typeof val}) never throws`, () => {
      expect(() => mapAuthErrorToResponse(val)).not.toThrow();
    });
  }
});
