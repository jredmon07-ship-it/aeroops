/**
 * org-features/get-org-features.ts — getOrgFeatures (per-org module toggles,
 * migration 0047).
 *
 * The read every shell render uses to decide which modules exist for this org:
 * nav filtering, dashboard tiles, global search, and each module route's
 * server-side gate. Gated on `app:access` (the broadest capability — every
 * member needs to know what nav to draw; this is UI configuration, not
 * sensitive data).
 *
 * GRACEFUL ABSENCE: migration 0047 is STAGED, NOT APPLIED to prod. Until a
 * human applies it:
 *   - available:false and everything reads as enabled ('school' mode, all
 *     modules on) — byte-identical to the pre-0047 world.
 *   - The settings UI renders the module card as "available in an upcoming
 *     update".
 *
 * GUARANTEES:
 *   - requireCapability(session, 'app:access') FIRST.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Read-only; never writes.
 *
 * TWO CALLING FORMS:
 *   getOrgFeatures(session)          — app code.
 *   getOrgFeaturesWithDb(db, session) — tests.
 */

import type { AnyDb } from '@aeroops/db';
import type { OrgFeatureFlags, OperatingMode } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { loadOrgFeatureState, orgFeatureConfigTableExists } from './org-features-internal.js';

export interface OrgFeaturesView {
  operatingMode: OperatingMode;
  features: OrgFeatureFlags;
  /**
   * false when migration 0047 has not been applied yet — modules cannot be
   * toggled and everything reads as enabled. The settings UI renders an
   * "available in an upcoming update" state in that case.
   */
  available: boolean;
}

export type GetOrgFeaturesResult = OrgFeaturesView;

async function _getOrgFeaturesImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<GetOrgFeaturesResult> {
  requireCapability(session, 'app:access');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const available = await orgFeatureConfigTableExists(tx);
    const state = await loadOrgFeatureState(tx, sess.orgId);
    return { ...state, available };
  });
}

export async function getOrgFeatures(
  session: AppSession | null | undefined,
): Promise<GetOrgFeaturesResult> {
  const db = await getDb();
  return _getOrgFeaturesImpl(db, session);
}

export async function getOrgFeaturesWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<GetOrgFeaturesResult> {
  return _getOrgFeaturesImpl(db, session);
}
