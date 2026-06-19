/**
 * dispatch-gate/config.ts — read + update dispatch gate configuration.
 *
 * Manages the 0..1 dispatch_config row per org. Absent row → canonical defaults.
 *
 * [VERIFY-3c-MONEY] (HARD MONEY BOUNDARY): balanceCheckEnabled is a FEATURE FLAG
 * ONLY. No dollar value, minimum, Stripe, or payment concept anywhere in this file.
 * The balance seam is always the stub (returns {ok:true}) in Phase 1.
 *
 * FUNCTIONS:
 *   getDispatchConfig    — dispatch:access → DispatchConfigView (defaults when absent)
 *   updateDispatchConfig — dispatch:manage_requirements → upsert + audit
 *
 * GUARANTEES:
 *   - requireCapability FIRST.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - eligibilityMode validated ∈ {'block','warn'} → ValidationError if invalid.
 *   - updateDispatchConfig: ON CONFLICT(org_id) DO UPDATE preserving unprovided field.
 *   - ONE audit row 'dispatch.config_updated' (before/after snapshot). NO dollar value.
 *   - Refusals returned; auth+validation thrown.
 *
 * TWO CALLING FORMS per function:
 *   fn(session, input)        — app code.
 *   fnWithDb(db, session, in) — tests.
 */

import { z } from 'zod';
import { sql, eq } from 'drizzle-orm';
import { dispatchConfig, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { loadDispatchConfig } from './internal.js';
import type { DispatchConfigView, GetDispatchConfigResult, UpdateDispatchConfigResult } from './types.js';

// ─── Input schemas ────────────────────────────────────────────────────────────

const updateConfigInputSchema = z.object({
  eligibilityMode:           z.enum(['block', 'warn']).optional(),
  balanceCheckEnabled:       z.boolean().optional(),
  twilightConstraintEnabled: z.boolean().optional(),
  twilightMode:              z.enum(['block', 'warn']).optional(),
  // omit = preserve; null = clear the exempt tag; non-empty trimmed string = set it.
  twilightExemptTag:         z.string().trim().min(1).nullable().optional(),
});

export interface UpdateDispatchConfigInput {
  eligibilityMode?:           'block' | 'warn';
  balanceCheckEnabled?:       boolean;
  twilightConstraintEnabled?: boolean;
  twilightMode?:              'block' | 'warn';
  twilightExemptTag?:         string | null;
}

// ─── getDispatchConfig ────────────────────────────────────────────────────────

async function _getDispatchConfigImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<GetDispatchConfigResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'dispatch:access');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 2. Load config (defaults when absent via loadDispatchConfig).
    return loadDispatchConfig(tx, sess.orgId);
  });
}

export async function getDispatchConfig(
  session: AppSession | null | undefined,
): Promise<GetDispatchConfigResult> {
  const db = await getDb();
  return _getDispatchConfigImpl(db, session);
}

export async function getDispatchConfigWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<GetDispatchConfigResult> {
  return _getDispatchConfigImpl(db, session);
}

// ─── updateDispatchConfig ─────────────────────────────────────────────────────

async function _updateDispatchConfigImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<UpdateDispatchConfigResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'dispatch:manage_requirements');

  // 2. VALIDATE input.
  const parsed = updateConfigInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[dispatch-gate] invalid updateDispatchConfig input: ${first?.message ?? 'unknown'}`,
    );
  }
  const input = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Load before-state for audit (also gives us the current values for
    //    partial-preserve on upsert).
    const before: DispatchConfigView = await loadDispatchConfig(tx, sess.orgId);

    // 4. Compute the merged (after) values — unprovided fields preserved.
    const afterMode      = input.eligibilityMode           !== undefined ? input.eligibilityMode           : before.eligibilityMode;
    const afterBalance   = input.balanceCheckEnabled        !== undefined ? input.balanceCheckEnabled        : before.balanceCheckEnabled;
    const afterTwEnabled = input.twilightConstraintEnabled  !== undefined ? input.twilightConstraintEnabled  : before.twilightConstraintEnabled;
    const afterTwMode    = input.twilightMode               !== undefined ? input.twilightMode               : before.twilightMode;
    const afterTwExempt  = input.twilightExemptTag          !== undefined ? input.twilightExemptTag          : before.twilightExemptTag;

    const after: DispatchConfigView = {
      eligibilityMode:           afterMode,
      balanceCheckEnabled:       afterBalance,
      twilightConstraintEnabled: afterTwEnabled,
      twilightMode:              afterTwMode,
      twilightExemptTag:         afterTwExempt,
    };

    // 5. No-op short-circuit: if nothing actually changes, write NOTHING — no
    //    upsert (no updated_at bump) and no audit row (spec §4: no-ops write zero).
    const changed =
      before.eligibilityMode !== after.eligibilityMode ||
      before.balanceCheckEnabled !== after.balanceCheckEnabled ||
      before.twilightConstraintEnabled !== after.twilightConstraintEnabled ||
      before.twilightMode !== after.twilightMode ||
      before.twilightExemptTag !== after.twilightExemptTag;
    if (!changed) {
      return { ok: true, config: after } as const;
    }

    // 6. Upsert: ON CONFLICT(org_id) DO UPDATE.
    //    The DO UPDATE SET must include ALL columns because the excluded row may
    //    have the opposite partial-preserve. We set to the computed after-values.
    await tx.execute(sql`
      INSERT INTO dispatch_config (org_id, eligibility_mode, balance_check_enabled, twilight_constraint_enabled, twilight_mode, twilight_exempt_tag, created_at, updated_at)
      VALUES (
        ${sess.orgId}::uuid,
        ${afterMode},
        ${afterBalance},
        ${afterTwEnabled},
        ${afterTwMode},
        ${afterTwExempt},
        NOW(),
        NOW()
      )
      ON CONFLICT (org_id) DO UPDATE SET
        eligibility_mode            = EXCLUDED.eligibility_mode,
        balance_check_enabled       = EXCLUDED.balance_check_enabled,
        twilight_constraint_enabled = EXCLUDED.twilight_constraint_enabled,
        twilight_mode               = EXCLUDED.twilight_mode,
        twilight_exempt_tag         = EXCLUDED.twilight_exempt_tag,
        updated_at                  = NOW()
    `);

    // 7. ONE audit row — before/after snapshot. NO dollar value in metadata
    //    (twilight is an operator scheduling rule from astronomy; no money).
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'dispatch.config_updated',
      entityType:  'dispatch_config',
      entityId:    sess.orgId,
      metadata: {
        before: {
          eligibilityMode:           before.eligibilityMode,
          balanceCheckEnabled:       before.balanceCheckEnabled,
          twilightConstraintEnabled: before.twilightConstraintEnabled,
          twilightMode:              before.twilightMode,
          twilightExemptTag:         before.twilightExemptTag,
        },
        after: {
          eligibilityMode:           after.eligibilityMode,
          balanceCheckEnabled:       after.balanceCheckEnabled,
          twilightConstraintEnabled: after.twilightConstraintEnabled,
          twilightMode:              after.twilightMode,
          twilightExemptTag:         after.twilightExemptTag,
        },
      },
    });

    return { ok: true, config: after } as const;
  });
}

export async function updateDispatchConfig(
  session: AppSession | null | undefined,
  input: UpdateDispatchConfigInput,
): Promise<UpdateDispatchConfigResult> {
  const db = await getDb();
  return _updateDispatchConfigImpl(db, session, input);
}

export async function updateDispatchConfigWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: UpdateDispatchConfigInput,
): Promise<UpdateDispatchConfigResult> {
  return _updateDispatchConfigImpl(db, session, input);
}
