/**
 * dispatch-gate/internal.ts — shared internals for the dispatch gate module.
 *
 * NOT barrel-exported from @aeroops/api. Holds:
 *   - loadDispatchConfig — reads the 0..1 dispatch_config row, returns defaults
 *     when absent. Shared by getDispatchConfig AND openDispatch to ensure they
 *     never diverge.
 *   - loadRequiredTags — loads required_tag strings for a resource.
 *   - loadPilotTags — loads member_tag values for a pilot (used in openDispatch
 *     eligibility arm when requiredTags is non-empty).
 *
 * These helpers run on the passed tx (RLS-scoped by caller — org GUC already set).
 * They NEVER set org context themselves.
 *
 * ADR-0009 §2: absent dispatch_config row → defaults:
 *   { eligibilityMode: 'block', balanceCheckEnabled: false }
 *
 * [VERIFY-3c-A]: requiredTag values are FREE-TEXT operator labels. No FAA/currency/
 * medical/regulatory meaning is attached or inferred.
 * [VERIFY-3c-MONEY]: balanceCheckEnabled is a FEATURE FLAG only. No dollar value.
 */

import { eq } from 'drizzle-orm';
import { dispatchConfig, dispatchRequirement, memberTag } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import type { DispatchConfigView, RequiredTagView } from './types.js';

// ─── loadDispatchConfig ───────────────────────────────────────────────────────

/**
 * loadDispatchConfig — returns the org's dispatch gate config.
 *
 * Reads the 0..1 dispatch_config row for orgId (RLS-scoped by tx). When no row
 * exists, returns the canonical defaults per ADR-0009:
 *   { eligibilityMode: 'block', balanceCheckEnabled: false }
 *
 * SHARED by:
 *   - getDispatchConfig (API read endpoint)
 *   - _openDispatchImpl (eligibility + balance arms, called with sess.orgId)
 *
 * NEVER diverge these two callers — always call this function, never inline the
 * default logic.
 *
 * [VERIFY-3c-MONEY]: balanceCheckEnabled is a feature flag. No money concept.
 */
export async function loadDispatchConfig(
  tx: AnyDb,
  orgId: string,
): Promise<DispatchConfigView> {
  const rows = await tx
    .select({
      eligibilityMode:           dispatchConfig.eligibilityMode,
      balanceCheckEnabled:       dispatchConfig.balanceCheckEnabled,
      twilightConstraintEnabled: dispatchConfig.twilightConstraintEnabled,
      twilightMode:              dispatchConfig.twilightMode,
      twilightExemptTag:         dispatchConfig.twilightExemptTag,
      availabilityConstraintEnabled: dispatchConfig.availabilityConstraintEnabled,
      availabilityMode:              dispatchConfig.availabilityMode,
      bookingRequestRetentionDays:              dispatchConfig.bookingRequestRetentionDays,
      bookingRequestRetentionIncludesConverted: dispatchConfig.bookingRequestRetentionIncludesConverted,
    })
    .from(dispatchConfig)
    .where(eq(dispatchConfig.orgId, orgId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    // Absent row → canonical defaults (ADR-0009 + Slice 4a + AV1.2 + PB-LR.A).
    return {
      eligibilityMode:           'block',
      balanceCheckEnabled:       false,
      twilightConstraintEnabled: false,
      twilightMode:              'warn',
      twilightExemptTag:         null,
      availabilityConstraintEnabled: false,
      availabilityMode:              'warn',
      bookingRequestRetentionDays:              365,
      bookingRequestRetentionIncludesConverted: false,
    };
  }

  return {
    eligibilityMode:           row.eligibilityMode as 'block' | 'warn',
    balanceCheckEnabled:       row.balanceCheckEnabled,
    twilightConstraintEnabled: row.twilightConstraintEnabled,
    twilightMode:              row.twilightMode as 'block' | 'warn',
    twilightExemptTag:         row.twilightExemptTag,
    availabilityConstraintEnabled: row.availabilityConstraintEnabled,
    availabilityMode:              row.availabilityMode as 'block' | 'warn',
    bookingRequestRetentionDays:              row.bookingRequestRetentionDays,
    bookingRequestRetentionIncludesConverted: row.bookingRequestRetentionIncludesConverted,
  };
}

// ─── loadRequiredTags ─────────────────────────────────────────────────────────

/**
 * loadRequiredTags — returns required_tag strings for a resource (aircraft).
 *
 * Returns an empty array when the aircraft has no requirements (no gate applies).
 * RLS-scoped by the caller's tx.
 *
 * [VERIFY-3c-A]: tag strings are FREE-TEXT opaque labels only.
 */
export async function loadRequiredTags(
  tx: AnyDb,
  resourceId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ requiredTag: dispatchRequirement.requiredTag })
    .from(dispatchRequirement)
    .where(eq(dispatchRequirement.resourceId, resourceId));

  return rows.map((r) => r.requiredTag);
}

// ─── loadRequiredTagViews ─────────────────────────────────────────────────────

/**
 * loadRequiredTagViews — returns full RequiredTagView rows for a resource.
 *
 * Used by the CRUD read/write endpoints (get/add/remove). Returns the live list
 * after a mutation to give callers a fresh snapshot.
 */
export async function loadRequiredTagViews(
  tx: AnyDb,
  resourceId: string,
): Promise<RequiredTagView[]> {
  const rows = await tx
    .select({
      id:          dispatchRequirement.id,
      requiredTag: dispatchRequirement.requiredTag,
      createdBy:   dispatchRequirement.createdBy,
      createdAt:   dispatchRequirement.createdAt,
    })
    .from(dispatchRequirement)
    .where(eq(dispatchRequirement.resourceId, resourceId));

  return rows.map((r) => ({
    id:          r.id,
    requiredTag: r.requiredTag,
    createdBy:   r.createdBy,
    createdAt:   r.createdAt instanceof Date ? r.createdAt : new Date(r.createdAt),
  }));
}

// ─── loadPilotTags ────────────────────────────────────────────────────────────

/**
 * loadPilotTags — returns member_tag values for a pilot user.
 *
 * Called in openDispatch ONLY when requiredTags is non-empty (to avoid a
 * pointless query on aircraft with no requirements). RLS-scoped by tx.
 *
 * [VERIFY-3c-A]: tag strings are opaque free-text labels only.
 */
export async function loadPilotTags(
  tx: AnyDb,
  pilotUserId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ tag: memberTag.tag })
    .from(memberTag)
    .where(eq(memberTag.userId, pilotUserId));

  return rows.map((r) => r.tag);
}
