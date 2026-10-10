/**
 * settings/actions.ts — Server actions for the org settings page's
 * modules / operating-mode card.
 *
 * Pattern mirrors booking/actions.ts (retention settings) and
 * people/actions.ts: auth() → call @aeroops/api fn (requireCapability
 * inside) → map ForbiddenError/UnauthenticatedError → tagged error result.
 *
 * The page itself already gates on org:manage_settings (only owner/manager
 * ever reach /o/[slug]/settings), so every action here inherits that gate;
 * the @aeroops/api functions independently re-check the specific capability
 * they need (app:access for reads, org:manage_settings for writes) — defense
 * in depth, never trust the page-level gate alone.
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 */
'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import { getOrgFeatures, setOrgFeatures } from '@aeroops/api';
import type { OperatingMode, OrgFeatureFlags } from '@aeroops/core';

// ─── Error shapes ──────────────────────────────────────────────────────────────

import { mapAuthError, isValidationError } from '@/lib/action-errors-result';
import type { AuthErrorResult, ValidationErrorResult, ServerErrorResult } from '@/lib/action-errors-result';

export type { AuthErrorResult, ValidationErrorResult, ServerErrorResult };

// ─── Org modules / operating mode (migration 0047) ────────────────────────────
//
// getOrgFeatures: app:access. setOrgFeatures: org:manage_settings. Both
// enforced inside @aeroops/api. When migration 0047 is unapplied the read
// returns available:false and everything reads as enabled ('school' mode, all
// modules on) — byte-identical to the pre-0047 world; the setter returns
// not_available and the settings/setup UI render a disabled "available in an
// upcoming update" state rather than crashing.
//
// "HIDE, DON'T DESTROY": toggling a module off only hides its nav/search/route
// surface for the org. No module data is ever deleted or mutated by a toggle.

export type GetOrgFeaturesActionResult =
  | { ok: true; operatingMode: OperatingMode; features: OrgFeatureFlags; available: boolean }
  | AuthErrorResult
  | ServerErrorResult;

export async function getOrgFeaturesAction(): Promise<GetOrgFeaturesActionResult> {
  const session = await auth();
  try {
    const result = await getOrgFeatures(session);
    return {
      ok: true,
      operatingMode: result.operatingMode,
      features: result.features,
      available: result.available,
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

export interface SetOrgFeaturesActionInput {
  operatingMode?: OperatingMode;
  applyPreset?: boolean;
  features?: Partial<OrgFeatureFlags>;
}

export type SetOrgFeaturesActionResult =
  | { ok: true; operatingMode: OperatingMode; features: OrgFeatureFlags }
  | { ok: false; reason: 'not_available' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function setOrgFeaturesAction(
  slug: string,
  input: SetOrgFeaturesActionInput,
): Promise<SetOrgFeaturesActionResult> {
  const session = await auth();
  try {
    const result = await setOrgFeatures(session, input);
    // Module toggles change nav app-wide, not just this settings page.
    revalidatePath(`/o/${slug}/settings`);
    revalidatePath(`/o/${slug}`);
    return result;
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}
