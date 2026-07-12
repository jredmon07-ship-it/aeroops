/**
 * billing/fee-passing-setting.ts — per-org "pass the ACH fee to the member"
 * setting (fee-passing feature, migration 0045). Stored as a boolean column on
 * the existing dispatch_config row (reusing the per-org config table — no new
 * config table). Absent row → default false (fee-passing OFF).
 *
 * FUNCTIONS:
 *   getFeePassing — org:manage_settings → { passAchFeeToMember, available }.
 *   setFeePassing — org:manage_settings → upsert dispatch_config + ONE audit row.
 *
 * GRACEFUL ABSENCE: migration 0045 is STAGED, NOT APPLIED to prod. Until a
 * human applies it, `dispatch_config.pass_ach_fee_to_member` does not exist.
 *   - getFeePassing returns { passAchFeeToMember:false, available:false } (the
 *     settings UI shows the toggle as unavailable rather than crashing).
 *   - setFeePassing returns { ok:false, reason:'not_available' }.
 *
 * GUARANTEES:
 *   - requireCapability(session, 'org:manage_settings') FIRST.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - No-op writes nothing (no audit row, no updated_at bump).
 *   - ONE audit row 'billing.fee_passing_config_changed' { passAchFeeToMember,
 *     previous } on a real change. NO dollar value (the fee is computed at
 *     checkout from the invoice/balance amount — this flag is a pure boolean).
 *
 * TWO CALLING FORMS per function:
 *   fn(session[, input])       — app code.
 *   fnWithDb(db, session[, in]) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { dispatchConfigHasFeeColumn, loadFeePassingEnabled } from './fee-passing-internal.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FeePassingView {
  /** Whether the org passes the ACH processing fee to the member at checkout. */
  passAchFeeToMember: boolean;
  /**
   * false when migration 0045 has not been applied yet — the feature cannot be
   * toggled and the setting is forced OFF. The UI renders an "available in an
   * upcoming update" state in that case.
   */
  available: boolean;
}

export type GetFeePassingResult = FeePassingView;

export type SetFeePassingResult =
  | { ok: true; passAchFeeToMember: boolean }
  | { ok: false; reason: 'not_available' };

// ─── Input schema ─────────────────────────────────────────────────────────────

const setFeePassingInputSchema = z.object({
  passAchFeeToMember: z.boolean(),
});

export interface SetFeePassingInput {
  passAchFeeToMember: boolean;
}

// ─── getFeePassing ────────────────────────────────────────────────────────────

async function _getFeePassingImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<GetFeePassingResult> {
  requireCapability(session, 'org:manage_settings');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const available = await dispatchConfigHasFeeColumn(tx);
    if (!available) {
      return { passAchFeeToMember: false, available: false };
    }
    const passAchFeeToMember = await loadFeePassingEnabled(tx, sess.orgId);
    return { passAchFeeToMember, available: true };
  });
}

export async function getFeePassing(
  session: AppSession | null | undefined,
): Promise<GetFeePassingResult> {
  const db = await getDb();
  return _getFeePassingImpl(db, session);
}

export async function getFeePassingWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<GetFeePassingResult> {
  return _getFeePassingImpl(db, session);
}

// ─── setFeePassing ────────────────────────────────────────────────────────────

async function _setFeePassingImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SetFeePassingResult> {
  requireCapability(session, 'org:manage_settings');

  const parsed = setFeePassingInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[fee-passing] invalid setFeePassing input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { passAchFeeToMember } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // GRACEFUL ABSENCE: cannot toggle until 0045 is applied.
    if (!(await dispatchConfigHasFeeColumn(tx))) {
      return { ok: false, reason: 'not_available' } as const;
    }

    const before = await loadFeePassingEnabled(tx, sess.orgId);
    if (before === passAchFeeToMember) {
      // No-op — write nothing.
      return { ok: true, passAchFeeToMember } as const;
    }

    // Upsert dispatch_config. Every OTHER column has a DB DEFAULT (migrations
    // 0009+), so a minimal INSERT is sufficient for a new row; ON CONFLICT
    // updates ONLY the fee flag + updated_at, preserving all other config.
    await tx.execute(sql`
      INSERT INTO "dispatch_config" ("org_id", "pass_ach_fee_to_member", "created_at", "updated_at")
      VALUES (${sess.orgId}::uuid, ${passAchFeeToMember}, NOW(), NOW())
      ON CONFLICT ("org_id") DO UPDATE SET
        "pass_ach_fee_to_member" = EXCLUDED."pass_ach_fee_to_member",
        "updated_at"             = NOW()
    `);

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'billing.fee_passing_config_changed',
      entityType: 'dispatch_config',
      entityId: sess.orgId,
      metadata: { passAchFeeToMember, previous: before },
    });

    return { ok: true, passAchFeeToMember } as const;
  });
}

export async function setFeePassing(
  session: AppSession | null | undefined,
  input: SetFeePassingInput,
): Promise<SetFeePassingResult> {
  const db = await getDb();
  return _setFeePassingImpl(db, session, input);
}

export async function setFeePassingWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SetFeePassingResult> {
  return _setFeePassingImpl(db, session, input);
}
