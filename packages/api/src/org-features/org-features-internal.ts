/**
 * org-features/org-features-internal.ts — shared internals for per-org module
 * toggles (migration 0047). NOT barrel-exported from @aeroops/api.
 *
 * GRACEFUL ABSENCE (load-bearing): migration 0047 is STAGED, NOT APPLIED to
 * prod. Until a human applies it, the org_feature_config table does not exist.
 * Every consumer first calls orgFeatureConfigTableExists (a catalog-only
 * to_regclass probe that can never poison a transaction); when the table is
 * absent the whole layer degrades to ALL-MODULES-ENABLED — byte-identical to
 * the pre-0047 world.
 *
 * There is deliberately NO Drizzle table object for org_feature_config: all
 * access goes through the guarded raw projections here (exactly the
 * guarded raw-SQL pattern), so no unguarded
 * `select().from(...)` can ever hit a DB that lacks the table.
 *
 * All helpers run on the passed tx (RLS-scoped by caller — org GUC already
 * set). They NEVER set org context themselves.
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { ALL_MODULES_ENABLED } from '@aeroops/core';
import type { OrgFeatureFlags, OperatingMode } from '@aeroops/core';
import { extractRows } from '../db-rows.js';

export interface OrgFeatureState {
  operatingMode: OperatingMode;
  features: OrgFeatureFlags;
}

export const DEFAULT_ORG_FEATURE_STATE: OrgFeatureState = Object.freeze({
  operatingMode: 'school',
  features: ALL_MODULES_ENABLED,
});

/**
 * orgFeatureConfigTableExists — true iff migration 0047's org_feature_config
 * table exists. Catalog-only (to_regclass) — always succeeds regardless of
 * whether the table is present.
 */
export async function orgFeatureConfigTableExists(tx: AnyDb): Promise<boolean> {
  const rows = extractRows<{ reg: string | null }>(
    await tx.execute(sql`SELECT to_regclass('org_feature_config')::text AS reg`),
  );
  return Boolean(rows[0]?.reg);
}

/**
 * loadOrgFeatureState — the org's operating mode + module flags, read within
 * an already-set org context (RLS-scoped by tx). Returns the all-enabled
 * default when the table is absent (0047 unapplied) OR no row exists — both
 * are the canonical pre-0047 behavior.
 */
export async function loadOrgFeatureState(tx: AnyDb, orgId: string): Promise<OrgFeatureState> {
  if (!(await orgFeatureConfigTableExists(tx))) {
    return DEFAULT_ORG_FEATURE_STATE;
  }

  const rows = extractRows<{
    operating_mode: string;
    module_training: boolean;
    module_maintenance: boolean;
    module_booking: boolean;
    module_portal: boolean;
    module_reports: boolean;
    module_auto_schedule: boolean;
    module_messages: boolean;
  }>(
    await tx.execute(sql`
      SELECT
        "operating_mode",
        "module_training",
        "module_maintenance",
        "module_booking",
        "module_portal",
        "module_reports",
        "module_auto_schedule",
        "module_messages"
      FROM "org_feature_config"
      WHERE "org_id" = ${orgId}::uuid
      LIMIT 1
    `),
  );
  const row = rows[0];
  if (!row) return DEFAULT_ORG_FEATURE_STATE;

  return {
    operatingMode: row.operating_mode === 'club' ? 'club' : 'school',
    features: {
      training: row.module_training === true,
      maintenance: row.module_maintenance === true,
      booking: row.module_booking === true,
      portal: row.module_portal === true,
      reports: row.module_reports === true,
      auto_schedule: row.module_auto_schedule === true,
      messages: row.module_messages === true,
    },
  };
}
