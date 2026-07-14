/**
 * integrations/qbo/qbo-sync-internal.ts — shared internals for the QBO SYNC
 * layer (migration 0046: auto-sync toggle + payment sync). NOT barrel-exported
 * from @aeroops/api.
 *
 * GRACEFUL ABSENCE (load-bearing): migration 0046 is STAGED, NOT APPLIED to
 * prod. Until a human applies it, `qbo_connection.auto_export_invoices` does
 * not exist AND qbo_export_log.entity_type='payment' is rejected by the old
 * CHECK. Reading/writing them directly would crash. Every SYNC-layer consumer
 * first calls the column guard here; when the schema is absent the whole layer
 * degrades to OFF / not_available — byte-identical to the pre-0046 manual-export
 * world. Because the column and the widened CHECK land together in ONE atomic
 * migration, the column probe is a sufficient single guard for BOTH features.
 *
 * The column is DELIBERATELY absent from the qbo_connection Drizzle table so
 * that the existing `select().from(qboConnection)` reads (export-invoice.ts /
 * status.ts) stay byte-identical and prod-safe (they never project a column the
 * DB may lack). This module reaches the new column via a raw guarded projection
 * only — exactly the fee-passing (migration 0045) pattern.
 *
 * All helpers run on the passed tx (RLS-scoped by caller — org GUC already set
 * where relevant). They NEVER set org context themselves.
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { extractRows } from '../../db-rows.js';

/**
 * qboConnectionHasAutoExportColumn — true iff migration 0046's
 * `qbo_connection.auto_export_invoices` column exists. Catalog-only query
 * (information_schema.columns) — always succeeds regardless of whether the
 * column is present, so it never poisons the surrounding transaction.
 */
export async function qboConnectionHasAutoExportColumn(tx: AnyDb): Promise<boolean> {
  const rows = extractRows<{ present: number }>(
    await tx.execute(sql`
      SELECT 1 AS present
      FROM information_schema.columns
      WHERE table_name = 'qbo_connection'
        AND column_name = 'auto_export_invoices'
      LIMIT 1
    `),
  );
  return rows.length > 0;
}

/**
 * loadQboAutoExportEnabled — the org's auto-export-finalized-invoices setting,
 * read within an already-set org context (RLS-scoped by tx). Returns false
 * (auto-sync OFF) when the column is absent (0046 unapplied) OR no
 * qbo_connection row exists — both are the canonical "OFF" default, so the
 * finalize path is byte-identical to the pre-0046 world.
 *
 * Uses a raw projection of ONLY the new column (guarded by
 * qboConnectionHasAutoExportColumn) so it never widens the existing
 * qbo_connection reads and never selects the column against a DB that lacks it.
 */
export async function loadQboAutoExportEnabled(tx: AnyDb, orgId: string): Promise<boolean> {
  if (!(await qboConnectionHasAutoExportColumn(tx))) return false;

  const rows = extractRows<{ auto_export_invoices: boolean }>(
    await tx.execute(sql`
      SELECT "auto_export_invoices"
      FROM "qbo_connection"
      WHERE "org_id" = ${orgId}::uuid
      LIMIT 1
    `),
  );
  return rows[0]?.auto_export_invoices === true;
}
