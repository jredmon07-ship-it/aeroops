/**
 * billing/real-balance-seam.ts — realBalanceSeam (Slice B2).
 *
 * A REAL (ledger-backed) implementation of the `BalanceSeam` interface
 * (@aeroops/core, packages/core/src/dispatch-gate/balance-seam.ts). SAME
 * shape as `stubBalanceSeam` — `check(req): Promise<BalanceCheckResult>` —
 * so it can be injected into `openDispatchWithDb`'s `balanceSeam` parameter
 * with ZERO signature change, exactly like a test-injected fake seam
 * already can (see dispatch-gate-api.test.ts's `fakeBelowMinimumSeam`).
 *
 * [VERIFY-B2-MONEY] HARD MONEY BOUNDARY (carried forward from ADR-0015 /
 * migration 0022): this seam is FULLY BUILT and UNIT/PROPERTY-TESTED in this
 * slice, but it is NOT injected anywhere in app code. `openDispatch()`'s
 * app-code form (packages/api/src/dispatch/open-dispatch.ts:337-338) still
 * hard-codes `stubBalanceSeam` — this file changes NOTHING about that. The
 * boundary-lift checklist item 6 (docs/specs/slice-b2-b3-payments.md) is the
 * SEPARATE, later, explicitly-reviewed step that would ever wire this seam
 * into the live dispatch gate.
 *
 * LOGIC:
 *   1. Look up the pilot's billing_account (may not exist yet → balance 0).
 *   2. computeBalance (@aeroops/core) over that account's ledger_entry rows.
 *   3. Load dispatch_config.minimum_balance_cents for the org (default 0).
 *   4. balance >= minimum → { ok: true }. balance < minimum → { ok: false,
 *      reason: 'below_minimum' } (the RESERVED arm the core type already
 *      carries — see balance-seam.ts).
 *
 * READ-ONLY: this seam performs zero writes (a balance check is a read, not
 * a money movement). NO Stripe, NO card/bank data.
 */

import type { BalanceSeam, BalanceCheckRequest, BalanceCheckResult } from '@aeroops/core';
import { computeBalance } from '@aeroops/core';
import type { AnyDb } from '@aeroops/db';
import { withOrgContext } from '@aeroops/db';
import { findBillingAccountTx, loadLedgerEntryAmountsTx } from './ledger-internal.js';
import { loadDispatchConfig } from '../dispatch-gate/internal.js';

/**
 * makeRealBalanceSeam — factory that binds a `BalanceSeam` to a specific db
 * client. openDispatch's `balanceSeam.check(req)` call carries `orgId` +
 * `pilotUserId` (@aeroops/core's BalanceCheckRequest — see the
 * [VERIFY-3c-MONEY] comment there: it intentionally has NO amount/minimum
 * field), so this seam opens its OWN short-lived org-scoped transaction per
 * check (mirrors how a provider-backed seam would need to make its own I/O
 * call — it cannot assume it is already inside the caller's transaction).
 */
export function makeRealBalanceSeam(db: AnyDb): BalanceSeam {
  return {
    async check(req: BalanceCheckRequest): Promise<BalanceCheckResult> {
      return withOrgContext(db, req.orgId, async (tx) => {
        const accountId = await findBillingAccountTx(tx, req.orgId, req.pilotUserId);
        const entries = accountId ? await loadLedgerEntryAmountsTx(tx, accountId) : [];
        const balanceCents = computeBalance(entries);

        const cfg = await loadDispatchConfig(tx, req.orgId);

        if (balanceCents >= cfg.minimumBalanceCents) {
          return { ok: true } as const;
        }
        return { ok: false, reason: 'below_minimum' } as const;
      });
    },
  };
}
