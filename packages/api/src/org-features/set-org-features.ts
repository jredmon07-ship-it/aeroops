/**
 * org-features/set-org-features.ts — setOrgFeatures (per-org module toggles +
 * operating mode, migration 0047).
 *
 * One setter for both concerns, mirroring updateDispatchConfig's partial-merge
 * shape:
 *   - { operatingMode } — record the mode label. When `applyPreset` is true
 *     (the "switch mode" button in setup/settings) the mode's preset is ALSO
 *     written into the module flags; otherwise flags are untouched.
 *   - { features }      — a PARTIAL per-module patch; unprovided modules keep
 *     their current value.
 * Both can be sent together (mode switch + explicit overrides).
 *
 * "HIDE, DON'T DESTROY": flags gate nav/search/routes only. No module data is
 * ever deleted or mutated by a toggle.
 *
 * GRACEFUL ABSENCE: until migration 0047 is applied there is no table —
 * returns { ok:false, reason:'not_available' }.
 *
 * GUARANTEES:
 *   - requireCapability(session, 'org:manage_settings') FIRST.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - No-op writes nothing (no audit row, no updated_at bump).
 *   - Full-column ON CONFLICT upsert of the MERGED state (absent row → merged
 *     over the all-enabled default).
 *   - ONE audit row 'org.feature_config_changed' with before/after on a real
 *     change.
 *
 * TWO CALLING FORMS:
 *   setOrgFeatures(session, input)          — app code.
 *   setOrgFeaturesWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { OPERATING_MODE_PRESETS, mergeFeatureFlags } from '@aeroops/core';
import type { OrgFeatureFlags, OperatingMode } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { loadOrgFeatureState, orgFeatureConfigTableExists } from './org-features-internal.js';

// ─── Input schema ─────────────────────────────────────────────────────────────

const featurePatchSchema = z
  .object({
    training: z.boolean().optional(),
    maintenance: z.boolean().optional(),
    booking: z.boolean().optional(),
    portal: z.boolean().optional(),
    reports: z.boolean().optional(),
    auto_schedule: z.boolean().optional(),
    messages: z.boolean().optional(),
  })
  .strict();

const setOrgFeaturesInputSchema = z
  .object({
    operatingMode: z.enum(['school', 'club']).optional(),
    /** Apply the operatingMode's preset to the flags (requires operatingMode). */
    applyPreset: z.boolean().optional(),
    features: featurePatchSchema.optional(),
  })
  .strict()
  .refine((v) => v.operatingMode !== undefined || v.features !== undefined, {
    message: 'provide operatingMode and/or features',
  })
  .refine((v) => !v.applyPreset || v.operatingMode !== undefined, {
    message: 'applyPreset requires operatingMode',
  });

export interface SetOrgFeaturesInput {
  operatingMode?: OperatingMode;
  applyPreset?: boolean;
  features?: Partial<OrgFeatureFlags>;
}

export type SetOrgFeaturesResult =
  | { ok: true; operatingMode: OperatingMode; features: OrgFeatureFlags }
  | { ok: false; reason: 'not_available' };

// ─── Implementation ───────────────────────────────────────────────────────────

async function _setOrgFeaturesImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SetOrgFeaturesResult> {
  requireCapability(session, 'org:manage_settings');

  const parsed = setOrgFeaturesInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[org-features] invalid setOrgFeatures input: ${first?.message ?? 'unknown'}`,
    );
  }
  const input = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // GRACEFUL ABSENCE: cannot toggle until 0047 is applied.
    if (!(await orgFeatureConfigTableExists(tx))) {
      return { ok: false, reason: 'not_available' } as const;
    }

    const before = await loadOrgFeatureState(tx, sess.orgId);

    // Merge order: current → mode preset (if applyPreset) → explicit patch.
    const nextMode: OperatingMode = input.operatingMode ?? before.operatingMode;
    let nextFeatures: OrgFeatureFlags = before.features;
    if (input.applyPreset && input.operatingMode) {
      nextFeatures = OPERATING_MODE_PRESETS[input.operatingMode];
    }
    if (input.features) {
      nextFeatures = mergeFeatureFlags(nextFeatures, input.features);
    }

    const unchanged =
      nextMode === before.operatingMode &&
      (Object.keys(nextFeatures) as Array<keyof OrgFeatureFlags>).every(
        (k) => nextFeatures[k] === before.features[k],
      );
    if (unchanged) {
      // No-op — write nothing.
      return { ok: true, operatingMode: nextMode, features: nextFeatures } as const;
    }

    // Full-column upsert of the merged state (0..1 row per org).
    await tx.execute(sql`
      INSERT INTO "org_feature_config" (
        "org_id", "operating_mode",
        "module_training", "module_maintenance", "module_booking",
        "module_portal", "module_reports", "module_auto_schedule", "module_messages",
        "created_at", "updated_at"
      )
      VALUES (
        ${sess.orgId}::uuid, ${nextMode},
        ${nextFeatures.training}, ${nextFeatures.maintenance}, ${nextFeatures.booking},
        ${nextFeatures.portal}, ${nextFeatures.reports}, ${nextFeatures.auto_schedule}, ${nextFeatures.messages},
        NOW(), NOW()
      )
      ON CONFLICT ("org_id") DO UPDATE SET
        "operating_mode"       = EXCLUDED."operating_mode",
        "module_training"      = EXCLUDED."module_training",
        "module_maintenance"   = EXCLUDED."module_maintenance",
        "module_booking"       = EXCLUDED."module_booking",
        "module_portal"        = EXCLUDED."module_portal",
        "module_reports"       = EXCLUDED."module_reports",
        "module_auto_schedule" = EXCLUDED."module_auto_schedule",
        "module_messages"      = EXCLUDED."module_messages",
        "updated_at"           = NOW()
    `);

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'org.feature_config_changed',
      entityType: 'org_feature_config',
      entityId: sess.orgId,
      metadata: {
        operatingMode: nextMode,
        features: nextFeatures,
        previous: { operatingMode: before.operatingMode, features: before.features },
        presetApplied: Boolean(input.applyPreset && input.operatingMode),
      },
    });

    return { ok: true, operatingMode: nextMode, features: nextFeatures } as const;
  });
}

export async function setOrgFeatures(
  session: AppSession | null | undefined,
  input: SetOrgFeaturesInput,
): Promise<SetOrgFeaturesResult> {
  const db = await getDb();
  return _setOrgFeaturesImpl(db, session, input);
}

export async function setOrgFeaturesWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SetOrgFeaturesResult> {
  return _setOrgFeaturesImpl(db, session, input);
}
