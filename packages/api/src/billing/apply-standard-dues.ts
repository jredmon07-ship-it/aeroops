/**
 * billing/apply-standard-dues.ts — applyStandardDuesSchedule (bulk onboarding).
 *
 * Create the SAME dues/tuition schedule for every ACTIVE member who does not
 * already have an active schedule. The club/school onboarding accelerant: set
 * the standard membership dues once and apply it to the whole roster. NO charge
 * happens here (schedules only); generation + collection are the existing
 * unchanged paths.
 *
 * IDEMPOTENT-SAFE: a member who already has an active dues_schedule is SKIPPED,
 * so re-running never double-assigns. Members can still have their schedule
 * customized or removed individually afterward.
 *
 * GUARANTEES:
 *   - requireCapability('billing:manage') FIRST.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - amountCents INTEGER CENTS positive; non-monthly requires an anchor.
 *   - GRACEFUL ABSENCE (migration 0050): a non-monthly cadence is refused
 *     (cadence_not_available) until anchor_month exists.
 *   - ONE summary audit row 'billing.standard_dues_applied'.
 *
 * TWO CALLING FORMS:
 *   applyStandardDuesSchedule(session, input)          — app code.
 *   applyStandardDuesScheduleWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import { extractRows } from '../db-rows.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { duesScheduleHasAnchorMonthColumn } from './dues-internal.js';

const applyStandardDuesInputSchema = z
  .object({
    amountCents: z.number().int({ message: 'amountCents must be an integer' }).positive({ message: 'amountCents must be > 0' }),
    dayOfMonth: z.number().int().min(1).max(28),
    cadence: z.enum(['monthly', 'quarterly', 'semiannual', 'annual']).default('monthly'),
    anchorMonth: z.number().int().min(1).max(12).optional(),
    memo: z.string().trim().min(1).max(500).optional(),
  })
  .refine((v) => v.cadence === 'monthly' || v.anchorMonth !== undefined, {
    message: 'anchorMonth is required for a non-monthly cadence',
    path: ['anchorMonth'],
  });

export type ApplyStandardDuesInput = z.infer<typeof applyStandardDuesInputSchema>;

export type ApplyStandardDuesResult =
  | { ok: true; createdCount: number; skippedExistingCount: number }
  | { ok: false; reason: 'cadence_not_available' };

async function _impl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<ApplyStandardDuesResult> {
  requireCapability(session, 'billing:manage');

  const parsed = applyStandardDuesInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[billing] invalid applyStandardDuesSchedule input: ${first?.message ?? 'unknown'}`);
  }
  const { amountCents, dayOfMonth, cadence, memo } = parsed.data;
  const anchorMonth = cadence === 'monthly' ? null : (parsed.data.anchorMonth ?? null);

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const hasAnchor = await duesScheduleHasAnchorMonthColumn(tx);
    if (cadence !== 'monthly' && !hasAnchor) {
      return { ok: false, reason: 'cadence_not_available' } as const;
    }

    // Active members of this org who have NO active dues schedule yet.
    const targets = extractRows<{ user_id: string }>(
      await tx.execute(sql`
        SELECT m."user_id"
        FROM "membership" m
        JOIN "app_user" u ON u."id" = m."user_id" AND u."org_id" = m."org_id"
        WHERE m."org_id" = ${sess.orgId}::uuid
          AND u."status" = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM "dues_schedule" d
            WHERE d."org_id" = m."org_id" AND d."user_id" = m."user_id" AND d."active" = true
          )
      `),
    );

    // Count of members already covered (for the "skipped" tally).
    const coveredRows = extractRows<{ n: number | string }>(
      await tx.execute(sql`
        SELECT COUNT(DISTINCT d."user_id")::int AS n
        FROM "dues_schedule" d
        JOIN "membership" m ON m."user_id" = d."user_id" AND m."org_id" = d."org_id"
        JOIN "app_user" u ON u."id" = m."user_id" AND u."org_id" = m."org_id"
        WHERE d."org_id" = ${sess.orgId}::uuid AND d."active" = true AND u."status" = 'active'
      `),
    );
    const skippedExistingCount = Number(coveredRows[0]?.n ?? 0);

    let createdCount = 0;
    for (const t of targets) {
      if (hasAnchor) {
        await tx.execute(sql`
          INSERT INTO "dues_schedule"
            ("org_id","user_id","amount_cents","cadence","anchor_month","day_of_month","active","memo","created_by")
          VALUES (${sess.orgId}::uuid, ${t.user_id}::uuid, ${amountCents}, ${cadence}, ${anchorMonth},
                  ${dayOfMonth}, true, ${memo ?? null}, ${sess.userId}::uuid)
        `);
      } else {
        await tx.execute(sql`
          INSERT INTO "dues_schedule"
            ("org_id","user_id","amount_cents","cadence","day_of_month","active","memo","created_by")
          VALUES (${sess.orgId}::uuid, ${t.user_id}::uuid, ${amountCents}, ${cadence},
                  ${dayOfMonth}, true, ${memo ?? null}, ${sess.userId}::uuid)
        `);
      }
      createdCount += 1;
    }

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'billing.standard_dues_applied',
      entityType: 'org',
      entityId: sess.orgId,
      metadata: { amountCents, dayOfMonth, cadence, anchorMonth, createdCount, skippedExistingCount },
    });

    return { ok: true, createdCount, skippedExistingCount } as const;
  });
}

export async function applyStandardDuesSchedule(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<ApplyStandardDuesResult> {
  const db = await getDb();
  return _impl(db, session, input);
}

export async function applyStandardDuesScheduleWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<ApplyStandardDuesResult> {
  return _impl(db, session, input);
}
