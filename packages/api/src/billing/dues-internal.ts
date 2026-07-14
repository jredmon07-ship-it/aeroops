/**
 * billing/dues-internal.ts — graceful-absence internals for dues cadence
 * (migration 0050). NOT barrel-exported.
 *
 * anchor_month (migration 0050) is STAGED: until applied, dues_schedule has no
 * anchor_month column and cadence is 'monthly'-only. A full `select().from(
 * duesSchedule)` (which now projects anchor_month via the Drizzle schema) would
 * crash on such a DB. Every dues reader goes through the guarded loaders here:
 * when the column is present they use the normal projection; when absent they
 * fall back to an explicit column list and default anchorMonth to null. Either
 * way the caller gets the same normalized row, and a pre-0050 world behaves
 * byte-identically (all schedules read as monthly).
 */

import { sql, and, eq } from 'drizzle-orm';
import { duesSchedule } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { extractRows } from '../db-rows.js';

export interface DuesScheduleRow {
  id: string;
  userId: string;
  amountCents: number;
  cadence: string;
  dayOfMonth: number;
  active: boolean;
  memo: string | null;
  anchorMonth: number | null;
  createdAt: Date | string;
}

/** True iff migration 0050's dues_schedule.anchor_month column exists. */
export async function duesScheduleHasAnchorMonthColumn(tx: AnyDb): Promise<boolean> {
  const rows = extractRows<{ present: number }>(
    await tx.execute(sql`
      SELECT 1 AS present
      FROM information_schema.columns
      WHERE table_name = 'dues_schedule' AND column_name = 'anchor_month'
      LIMIT 1
    `),
  );
  return rows.length > 0;
}

/** Explicit-column raw select used when anchor_month is absent (pre-0050). */
async function loadExplicit(tx: AnyDb, whereSql: ReturnType<typeof sql>): Promise<DuesScheduleRow[]> {
  const rows = extractRows<{
    id: string;
    user_id: string;
    amount_cents: number;
    cadence: string;
    day_of_month: number;
    active: boolean;
    memo: string | null;
    created_at: string;
  }>(
    await tx.execute(sql`
      SELECT "id", "user_id", "amount_cents", "cadence", "day_of_month", "active", "memo", "created_at"
      FROM "dues_schedule"
      ${whereSql}
    `),
  );
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    amountCents: r.amount_cents,
    cadence: r.cadence,
    dayOfMonth: r.day_of_month,
    active: r.active,
    memo: r.memo,
    anchorMonth: null,
    createdAt: r.created_at,
  }));
}

/** Active dues schedules for the whole org (generation). Normalized + graceful. */
export async function loadActiveDuesSchedules(tx: AnyDb, orgId: string): Promise<DuesScheduleRow[]> {
  if (await duesScheduleHasAnchorMonthColumn(tx)) {
    const rows = await tx
      .select()
      .from(duesSchedule)
      .where(and(eq(duesSchedule.orgId, orgId), eq(duesSchedule.active, true)));
    return rows.map(normalizeDrizzleRow);
  }
  return loadExplicit(tx, sql`WHERE "org_id" = ${orgId}::uuid AND "active" = true`);
}

/** A member's active dues schedules (billing profile). Normalized + graceful. */
export async function loadMemberActiveDuesSchedules(
  tx: AnyDb,
  memberUserId: string,
): Promise<DuesScheduleRow[]> {
  if (await duesScheduleHasAnchorMonthColumn(tx)) {
    const rows = await tx
      .select()
      .from(duesSchedule)
      .where(and(eq(duesSchedule.userId, memberUserId), eq(duesSchedule.active, true)))
      .orderBy(sql`"created_at" DESC`);
    return rows.map(normalizeDrizzleRow);
  }
  return loadExplicit(tx, sql`WHERE "user_id" = ${memberUserId}::uuid AND "active" = true ORDER BY "created_at" DESC`);
}

/** Normalize a full Drizzle dues_schedule row (anchor_month present) to DuesScheduleRow. */
function normalizeDrizzleRow(r: typeof duesSchedule.$inferSelect): DuesScheduleRow {
  return {
    id: r.id,
    userId: r.userId,
    amountCents: r.amountCents,
    cadence: r.cadence,
    dayOfMonth: r.dayOfMonth,
    active: r.active,
    memo: r.memo,
    anchorMonth: r.anchorMonth ?? null,
    createdAt: r.createdAt,
  };
}
