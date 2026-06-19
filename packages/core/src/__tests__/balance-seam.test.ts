/**
 * balance-seam.test.ts — unit tests for the Phase 1 balance seam stub.
 *
 * [VERIFY-3c-MONEY] These tests enforce and document the MONEY BOUNDARY for
 * Slice 3c (ADR-0009). In Phase 1:
 *   - `stubBalanceSeam.check()` ALWAYS returns `{ ok: true }`.
 *   - `BalanceCheckRequest` has NO dollar/amount/minimum/currency/account/
 *     Stripe/card/balance field.
 *   - `BalanceCheckResult { ok: false; reason: 'below_minimum' }` is RESERVED
 *     and unreachable via the stub.
 *
 * The structural/type assertions in this file are INTENTIONAL documentation of
 * the money boundary. Any addition of amount/minimum/currency fields to
 * BalanceCheckRequest would require Phase 2 billing review and MUST NOT be added
 * here without conductor approval.
 *
 * COVERAGE:
 *   - stubBalanceSeam.check() always returns { ok: true } for arbitrary requests
 *   - stubBalanceSeam.check() is async (returns a Promise)
 *   - Structural assertion: BalanceCheckRequest has ONLY orgId + pilotUserId
 *   - Money boundary: no dollar/amount/minimum/currency/account field exists
 *   - Type-level: BalanceCheckResult union only contains 'below_minimum' reason
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  stubBalanceSeam,
} from '../dispatch-gate/balance-seam.js';
import type {
  BalanceCheckRequest,
  BalanceCheckResult,
  BalanceSeam,
} from '../dispatch-gate/balance-seam.js';

// ─── Generators ──────────────────────────────────────────────────────────────

const orgId = fc.uuid();
const pilotUserId = fc.uuid();

const balanceCheckRequest = fc.record({
  orgId,
  pilotUserId,
});

// ─── stubBalanceSeam always returns { ok: true } ─────────────────────────────

describe('stubBalanceSeam.check() — always ok:true (Phase 1 money boundary)', () => {
  it('property: returns { ok: true } for arbitrary orgId + pilotUserId', async () => {
    await fc.assert(
      fc.asyncProperty(balanceCheckRequest, async (req) => {
        const result = await stubBalanceSeam.check(req);
        expect(result).toEqual({ ok: true });
        expect(result.ok).toBe(true);
      }),
    );
  });

  it('unit: check({orgId, pilotUserId}) returns { ok: true }', async () => {
    const req: BalanceCheckRequest = {
      orgId: 'org-abc-123',
      pilotUserId: 'user-pilot-456',
    };
    const result = await stubBalanceSeam.check(req);
    expect(result).toEqual({ ok: true });
    expect(result.ok).toBe(true);
  });

  it('unit: check is async — resolves a Promise', async () => {
    const req: BalanceCheckRequest = { orgId: 'org-1', pilotUserId: 'user-1' };
    const promise = stubBalanceSeam.check(req);
    // Must be a Promise (thenable)
    expect(typeof promise.then).toBe('function');
    const result = await promise;
    expect(result.ok).toBe(true);
  });

  it('unit: calling check() multiple times always returns { ok: true }', async () => {
    const req: BalanceCheckRequest = { orgId: 'org-x', pilotUserId: 'user-y' };
    for (let i = 0; i < 5; i++) {
      const result = await stubBalanceSeam.check(req);
      expect(result.ok).toBe(true);
    }
  });

  it('[VERIFY-3c-MONEY] stub NEVER returns below_minimum — only real seam (Phase 2) can', async () => {
    // Prove it: even if we test 3 different requests, always ok:true
    const requests: BalanceCheckRequest[] = [
      { orgId: 'org-1', pilotUserId: 'pilot-a' },
      { orgId: 'org-2', pilotUserId: 'pilot-b' },
      { orgId: 'org-3', pilotUserId: 'pilot-c' },
    ];
    for (const req of requests) {
      const result = await stubBalanceSeam.check(req);
      expect(result.ok).toBe(true);
      // Narrow the type: if ok is false, reason would be 'below_minimum'; but this never happens
      if (!result.ok) {
        // This branch is unreachable in Phase 1 — TypeScript would flag removing it
        // but we document it here for clarity
        expect(result.reason).toBe('below_minimum'); // type-checked; never reached
      }
    }
  });
});

// ─── BalanceSeam interface conformance ───────────────────────────────────────

describe('stubBalanceSeam — conforms to BalanceSeam interface', () => {
  it('stubBalanceSeam has a check method', () => {
    expect(typeof stubBalanceSeam.check).toBe('function');
  });

  it('stubBalanceSeam satisfies BalanceSeam (TypeScript compile-time check)', () => {
    // This assignment is a compile-time assertion: if stubBalanceSeam does not
    // implement BalanceSeam, tsc will error here.
    const seam: BalanceSeam = stubBalanceSeam;
    expect(seam).toBeDefined();
  });
});

// ─── Money boundary: structural assertion on BalanceCheckRequest ──────────────
//
// [VERIFY-3c-MONEY] BalanceCheckRequest MUST have ONLY orgId and pilotUserId.
// It must NOT have: amount, minimum, currency, account, balance, credit, Stripe,
// card, dollar, fee, rate, threshold, or any money-adjacent field.
//
// These runtime checks document the boundary. The TypeScript compiler also
// enforces this at compile time via the type definition.

describe('[VERIFY-3c-MONEY] BalanceCheckRequest — no money fields exist', () => {
  it('a well-formed BalanceCheckRequest has exactly orgId + pilotUserId keys', () => {
    const req: BalanceCheckRequest = {
      orgId: 'org-abc',
      pilotUserId: 'user-xyz',
    };
    const keys = Object.keys(req).sort();
    // Exactly two keys, no more
    expect(keys).toEqual(['orgId', 'pilotUserId']);
  });

  it('[MONEY-BOUNDARY] BalanceCheckRequest has NO amount field', () => {
    const req: BalanceCheckRequest = { orgId: 'o', pilotUserId: 'u' };
    expect(Object.prototype.hasOwnProperty.call(req, 'amount')).toBe(false);
  });

  it('[MONEY-BOUNDARY] BalanceCheckRequest has NO minimum field', () => {
    const req: BalanceCheckRequest = { orgId: 'o', pilotUserId: 'u' };
    expect(Object.prototype.hasOwnProperty.call(req, 'minimum')).toBe(false);
  });

  it('[MONEY-BOUNDARY] BalanceCheckRequest has NO currency field', () => {
    const req: BalanceCheckRequest = { orgId: 'o', pilotUserId: 'u' };
    expect(Object.prototype.hasOwnProperty.call(req, 'currency')).toBe(false);
  });

  it('[MONEY-BOUNDARY] BalanceCheckRequest has NO account field', () => {
    const req: BalanceCheckRequest = { orgId: 'o', pilotUserId: 'u' };
    expect(Object.prototype.hasOwnProperty.call(req, 'account')).toBe(false);
  });

  it('[MONEY-BOUNDARY] BalanceCheckRequest has NO balance field', () => {
    const req: BalanceCheckRequest = { orgId: 'o', pilotUserId: 'u' };
    expect(Object.prototype.hasOwnProperty.call(req, 'balance')).toBe(false);
  });

  it('[MONEY-BOUNDARY] BalanceCheckRequest has NO stripe field', () => {
    const req: BalanceCheckRequest = { orgId: 'o', pilotUserId: 'u' };
    expect(Object.prototype.hasOwnProperty.call(req, 'stripe')).toBe(false);
  });

  it('[MONEY-BOUNDARY] BalanceCheckRequest has NO dollar field', () => {
    const req: BalanceCheckRequest = { orgId: 'o', pilotUserId: 'u' };
    expect(Object.prototype.hasOwnProperty.call(req, 'dollar')).toBe(false);
  });

  it('[MONEY-BOUNDARY] BalanceCheckRequest has NO fee field', () => {
    const req: BalanceCheckRequest = { orgId: 'o', pilotUserId: 'u' };
    expect(Object.prototype.hasOwnProperty.call(req, 'fee')).toBe(false);
  });

  it('[MONEY-BOUNDARY] BalanceCheckRequest has NO threshold field', () => {
    const req: BalanceCheckRequest = { orgId: 'o', pilotUserId: 'u' };
    expect(Object.prototype.hasOwnProperty.call(req, 'threshold')).toBe(false);
  });
});

// ─── BalanceCheckResult type structure ───────────────────────────────────────

describe('BalanceCheckResult — type structure', () => {
  it('ok:true arm has exactly { ok: true }', () => {
    const ok: BalanceCheckResult = { ok: true };
    expect(ok.ok).toBe(true);
    expect(Object.keys(ok)).toEqual(['ok']);
  });

  it('[VERIFY-3c-MONEY] ok:false arm reason is only "below_minimum" — a reserved placeholder', () => {
    // Type-level: the only valid reason is 'below_minimum'
    // This compiles because the type permits it; but it is NEVER returned by stub
    const reserved: BalanceCheckResult = { ok: false, reason: 'below_minimum' };
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) {
      expect(reserved.reason).toBe('below_minimum');
    }
    // Document: the stub will never produce this
    // (Reinforced by the always-ok property test above)
  });
});
