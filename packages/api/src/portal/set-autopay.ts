/**
 * portal/set-autopay.ts — setMyAutopay (Slice P0-REV, C3).
 *
 * SELF-SCOPED (portal:access): the member's explicit auto-pay opt-in/out.
 * subject = session.userId ONLY. Upserts autopay_setting on UNIQUE
 * (org_id, user_id).
 *
 * VALIDATION (belt-and-suspenders — the DB shape CHECK
 * autopay_enabled_requires_pm is the structural backstop, migration 0024):
 *   enabled=true REQUIRES defaultPaymentMethodId, AND that PM must be a
 *   stripe_payment_method row SELF-OWNED by session.userId — a member can
 *   never arm autopay against another member's saved PM.
 *
 * GUARANTEES:
 *   - authz FIRST: portal:access before any data access.
 *   - org_id + subject from session only (withSessionOrgContextWithDb).
 *   - Audited 'billing.autopay_updated'.
 *
 * TWO CALLING FORMS:
 *   setMyAutopay(session, input)          — app code.
 *   setMyAutopayWithDb(db, session, input) — tests.
 */
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { autopaySetting, stripePaymentMethod, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const setMyAutopayInputSchema = z.object({
  enabled: z.boolean(),
  defaultPaymentMethodId: z.string().regex(UUID_RE, { message: 'defaultPaymentMethodId must be a UUID' }).optional(),
});

export type SetMyAutopayInput = z.infer<typeof setMyAutopayInputSchema>;

export interface AutopaySettingView {
  enabled: boolean;
  defaultPaymentMethodId: string | null;
}

export type SetMyAutopayResult =
  | { ok: true; setting: AutopaySettingView }
  | { ok: false; reason: 'pm_required' }
  | { ok: false; reason: 'pm_not_found' };

async function _setMyAutopayImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SetMyAutopayResult> {
  requireCapability(session, 'portal:access');

  const parsed = setMyAutopayInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[portal] invalid setMyAutopay input: ${first?.message ?? 'unknown'}`);
  }
  const { enabled, defaultPaymentMethodId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    if (enabled) {
      if (!defaultPaymentMethodId) {
        return { ok: false, reason: 'pm_required' } as const;
      }
      // SELF-OWNED check: the PM must be session.userId's own saved PM.
      const pmRows = await tx
        .select({ id: stripePaymentMethod.id })
        .from(stripePaymentMethod)
        .where(
          and(
            eq(stripePaymentMethod.id, defaultPaymentMethodId),
            eq(stripePaymentMethod.orgId, sess.orgId),
            eq(stripePaymentMethod.userId, sess.userId),
          ),
        )
        .limit(1);
      if (!pmRows[0]) {
        return { ok: false, reason: 'pm_not_found' } as const;
      }
    }

    const upserted = await tx
      .insert(autopaySetting)
      .values({
        orgId: sess.orgId,
        userId: sess.userId,
        enabled,
        defaultPaymentMethodId: enabled ? (defaultPaymentMethodId ?? null) : null,
      })
      .onConflictDoUpdate({
        target: [autopaySetting.orgId, autopaySetting.userId],
        set: {
          enabled,
          defaultPaymentMethodId: enabled ? (defaultPaymentMethodId ?? null) : null,
          updatedAt: new Date(),
        },
      })
      .returning();

    const row = upserted[0];
    if (!row) throw new Error('[portal] setMyAutopay: upsert returned no rows');

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'billing.autopay_updated',
      entityType: 'autopay_setting',
      entityId: row.id,
      metadata: { enabled, defaultPaymentMethodId: row.defaultPaymentMethodId },
    });

    return {
      ok: true,
      setting: { enabled: row.enabled, defaultPaymentMethodId: row.defaultPaymentMethodId },
    } as const;
  });
}

export async function setMyAutopay(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SetMyAutopayResult> {
  const db = await getDb();
  return _setMyAutopayImpl(db, session, input);
}

export async function setMyAutopayWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SetMyAutopayResult> {
  return _setMyAutopayImpl(db, session, input);
}
