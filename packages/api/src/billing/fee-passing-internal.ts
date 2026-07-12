/**
 * billing/fee-passing-internal.ts — shared internals for the fee-passing +
 * pay-full-balance features (migration 0045). NOT barrel-exported from
 * @aeroops/api.
 *
 * GRACEFUL ABSENCE (load-bearing): migration 0045 is STAGED, NOT APPLIED to
 * prod. Until a human applies it, `dispatch_config.pass_ach_fee_to_member` and
 * the `balance_payment` table do not exist. Reading them directly would crash.
 * Every consumer of these features first calls the *Exists guard here; when the
 * schema is absent the feature degrades to OFF / not_available — byte-identical
 * to the pre-0045 world. Both guards issue catalog queries that ALWAYS succeed
 * (0 or 1 rows) — they never touch the missing object, so they cannot poison
 * the surrounding transaction.
 *
 * All helpers run on the passed tx (RLS-scoped by caller — org GUC already set
 * where relevant). They NEVER set org context themselves.
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { extractRows } from '../db-rows.js';

/**
 * dispatchConfigHasFeeColumn — true iff migration 0045's
 * `dispatch_config.pass_ach_fee_to_member` column exists. Catalog-only query
 * (information_schema.columns) — always succeeds regardless of whether the
 * column is present.
 */
export async function dispatchConfigHasFeeColumn(tx: AnyDb): Promise<boolean> {
  const rows = extractRows<{ present: number }>(
    await tx.execute(sql`
      SELECT 1 AS present
      FROM information_schema.columns
      WHERE table_name = 'dispatch_config'
        AND column_name = 'pass_ach_fee_to_member'
      LIMIT 1
    `),
  );
  return rows.length > 0;
}

/**
 * balancePaymentTableExists — true iff migration 0045's `balance_payment` table
 * exists. Catalog-only query (to_regclass) — always succeeds; returns NULL (→
 * false) when the table is absent.
 */
export async function balancePaymentTableExists(tx: AnyDb): Promise<boolean> {
  const rows = extractRows<{ reg: string | null }>(
    await tx.execute(sql`SELECT to_regclass('public.balance_payment') AS reg`),
  );
  return rows[0]?.reg != null;
}

/**
 * loadFeePassingEnabled — the org's pass-ACH-fee-to-member setting, read within
 * an already-set org context (RLS-scoped by tx). Returns false (fee-passing
 * OFF) when the column is absent (0045 unapplied) OR no dispatch_config row
 * exists — both are the canonical "OFF" default, so the money path is
 * byte-identical to the pre-0045 world.
 *
 * Uses a raw projection of ONLY the new column (guarded by
 * dispatchConfigHasFeeColumn) so it never widens the FROZEN loadDispatchConfig
 * read and never selects the column against a DB that lacks it.
 */
export async function loadFeePassingEnabled(tx: AnyDb, orgId: string): Promise<boolean> {
  if (!(await dispatchConfigHasFeeColumn(tx))) return false;

  const rows = extractRows<{ pass_ach_fee_to_member: boolean }>(
    await tx.execute(sql`
      SELECT "pass_ach_fee_to_member"
      FROM "dispatch_config"
      WHERE "org_id" = ${orgId}::uuid
      LIMIT 1
    `),
  );
  return rows[0]?.pass_ach_fee_to_member === true;
}
