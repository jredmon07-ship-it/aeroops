/**
 * billing/dues-schedule-commands.ts — createDuesSchedule /
 * setDuesScheduleActive (Slice P0-REV, C5).
 *
 * Staff-initiated (billing:manage): configure a member's recurring-dues line.
 * NO charge happens here — this only creates/toggles the SCHEDULE.
 * Generation of DRAFT invoices from active schedules is generateDuesInvoices
 * (generate-dues-invoices.ts); charging (if the member has autopay) happens
 * only when a generated invoice is later finalized.
 *
 * GUARANTEES:
 *   - authz FIRST: billing:manage before any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - memberUserId must be a member of this org (membership check).
 *   - amountCents = INTEGER CENTS, positive. dayOfMonth 1–28 (DB CHECK backstop).
 *   - Audited: 'billing.dues_schedule_created' / 'billing.dues_schedule_active_set'.
 *
 * TWO CALLING FORMS per command:
 *   fn(session, input)          — app code.
 *   fnWithDb(db, session, input) — tests.
 */
import { z } from 'zod';
import { sql, eq, and } from 'drizzle-orm';
import { membership, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { DUES_CADENCES } from '@aeroops/core';
import type { DuesCadence } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import { extractRows } from '../db-rows.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { duesScheduleHasAnchorMonthColumn } from './dues-internal.js';
import type { DuesScheduleRow } from './dues-internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── View ─────────────────────────────────────────────────────────────────────

export interface DuesScheduleView {
  id: string;
  userId: string;
  amountCents: number;
  cadence: DuesCadence;
  /** 1–12, the month a non-monthly cadence anchors on; null for monthly. */
  anchorMonth: number | null;
  dayOfMonth: number;
  active: boolean;
  memo: string | null;
  createdAt: Date;
}

function toDuesScheduleView(row: DuesScheduleRow): DuesScheduleView {
  return {
    id: row.id,
    userId: row.userId,
    amountCents: row.amountCents,
    cadence: (DUES_CADENCES as readonly string[]).includes(row.cadence) ? (row.cadence as DuesCadence) : 'monthly',
    anchorMonth: row.anchorMonth,
    dayOfMonth: row.dayOfMonth,
    active: row.active,
    memo: row.memo,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt as unknown as string),
  };
}

// ─── createDuesSchedule ────────────────────────────────────────────────────────

const createDuesScheduleInputSchema = z
  .object({
    memberUserId: z.string().regex(UUID_RE, { message: 'memberUserId must be a UUID' }),
    amountCents: z.number().int({ message: 'amountCents must be an integer' }).positive({ message: 'amountCents must be > 0' }),
    dayOfMonth: z.number().int().min(1).max(28),
    cadence: z.enum(['monthly', 'quarterly', 'semiannual', 'annual']).default('monthly'),
    /** Required for a non-monthly cadence; ignored for monthly. */
    anchorMonth: z.number().int().min(1).max(12).optional(),
    memo: z.string().trim().min(1).max(500).optional(),
  })
  .refine((v) => v.cadence === 'monthly' || v.anchorMonth !== undefined, {
    message: 'anchorMonth is required for a non-monthly cadence',
    path: ['anchorMonth'],
  });

export type CreateDuesScheduleInput = z.infer<typeof createDuesScheduleInputSchema>;

export type CreateDuesScheduleResult =
  | { ok: true; schedule: DuesScheduleView }
  | { ok: false; reason: 'member_not_found' }
  | { ok: false; reason: 'cadence_not_available' };

async function _createDuesScheduleImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<CreateDuesScheduleResult> {
  requireCapability(session, 'billing:manage');

  const parsed = createDuesScheduleInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[billing] invalid createDuesSchedule input: ${first?.message ?? 'unknown'}`);
  }
  const { memberUserId, amountCents, dayOfMonth, cadence, memo } = parsed.data;
  // Monthly ignores the anchor (it bills every period); non-monthly requires it.
  const anchorMonth = cadence === 'monthly' ? null : (parsed.data.anchorMonth ?? null);

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const memberRows = await tx
      .select({ userId: membership.userId })
      .from(membership)
      .where(and(eq(membership.userId, memberUserId), eq(membership.orgId, sess.orgId)))
      .limit(1);
    if (!memberRows[0]) {
      return { ok: false, reason: 'member_not_found' } as const;
    }

    // GRACEFUL ABSENCE: a non-monthly cadence needs migration 0050's anchor_month
    // column + widened CHECK. Without it, only monthly is available.
    const hasAnchor = await duesScheduleHasAnchorMonthColumn(tx);
    if (cadence !== 'monthly' && !hasAnchor) {
      return { ok: false, reason: 'cadence_not_available' } as const;
    }

    // Insert + read back through explicit columns so the RETURNING projection
    // never references anchor_month on a pre-0050 DB.
    const insertedId = extractRows<{ id: string }>(
      hasAnchor
        ? await tx.execute(sql`
            INSERT INTO "dues_schedule"
              ("org_id","user_id","amount_cents","cadence","anchor_month","day_of_month","active","memo","created_by")
            VALUES (${sess.orgId}::uuid, ${memberUserId}::uuid, ${amountCents}, ${cadence}, ${anchorMonth},
                    ${dayOfMonth}, true, ${memo ?? null}, ${sess.userId}::uuid)
            RETURNING "id"
          `)
        : await tx.execute(sql`
            INSERT INTO "dues_schedule"
              ("org_id","user_id","amount_cents","cadence","day_of_month","active","memo","created_by")
            VALUES (${sess.orgId}::uuid, ${memberUserId}::uuid, ${amountCents}, ${cadence},
                    ${dayOfMonth}, true, ${memo ?? null}, ${sess.userId}::uuid)
            RETURNING "id"
          `),
    );
    const id = insertedId[0]?.id;
    if (!id) throw new Error('[billing] createDuesSchedule: INSERT returned no rows');

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'billing.dues_schedule_created',
      entityType: 'dues_schedule',
      entityId: id,
      metadata: { memberUserId, amountCents, dayOfMonth, cadence, anchorMonth },
    });

    const view: DuesScheduleView = {
      id,
      userId: memberUserId,
      amountCents,
      cadence,
      anchorMonth,
      dayOfMonth,
      active: true,
      memo: memo ?? null,
      createdAt: new Date(),
    };
    return { ok: true, schedule: view } as const;
  });
}

export async function createDuesSchedule(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CreateDuesScheduleResult> {
  const db = await getDb();
  return _createDuesScheduleImpl(db, session, input);
}

export async function createDuesScheduleWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CreateDuesScheduleResult> {
  return _createDuesScheduleImpl(db, session, input);
}

// ─── setDuesScheduleActive ──────────────────────────────────────────────────────

const setDuesScheduleActiveInputSchema = z.object({
  scheduleId: z.string().regex(UUID_RE, { message: 'scheduleId must be a UUID' }),
  active: z.boolean(),
});

export type SetDuesScheduleActiveInput = z.infer<typeof setDuesScheduleActiveInputSchema>;

export type SetDuesScheduleActiveResult =
  | { ok: true; schedule: DuesScheduleView }
  | { ok: false; reason: 'not_found' };

async function _setDuesScheduleActiveImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SetDuesScheduleActiveResult> {
  requireCapability(session, 'billing:manage');

  const parsed = setDuesScheduleActiveInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[billing] invalid setDuesScheduleActive input: ${first?.message ?? 'unknown'}`);
  }
  const { scheduleId, active } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const hasAnchor = await duesScheduleHasAnchorMonthColumn(tx);
    // Explicit RETURNING columns (+ anchor_month only when it exists) so this
    // never projects a missing column on a pre-0050 DB.
    const anchorSelect = hasAnchor ? sql`, "anchor_month"` : sql``;
    const rows = extractRows<{
      id: string;
      user_id: string;
      amount_cents: number;
      cadence: string;
      day_of_month: number;
      active: boolean;
      memo: string | null;
      created_at: string;
      anchor_month?: number | null;
    }>(
      await tx.execute(sql`
        UPDATE "dues_schedule"
        SET "active" = ${active}, "updated_at" = NOW()
        WHERE "id" = ${scheduleId}::uuid
        RETURNING "id","user_id","amount_cents","cadence","day_of_month","active","memo","created_at"${anchorSelect}
      `),
    );
    const row = rows[0];
    if (!row) {
      return { ok: false, reason: 'not_found' } as const;
    }

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'billing.dues_schedule_active_set',
      entityType: 'dues_schedule',
      entityId: row.id,
      metadata: { active },
    });

    const normalized: DuesScheduleRow = {
      id: row.id,
      userId: row.user_id,
      amountCents: row.amount_cents,
      cadence: row.cadence,
      dayOfMonth: row.day_of_month,
      active: row.active,
      memo: row.memo,
      anchorMonth: row.anchor_month ?? null,
      createdAt: row.created_at,
    };
    return { ok: true, schedule: toDuesScheduleView(normalized) } as const;
  });
}

export async function setDuesScheduleActive(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SetDuesScheduleActiveResult> {
  const db = await getDb();
  return _setDuesScheduleActiveImpl(db, session, input);
}

export async function setDuesScheduleActiveWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SetDuesScheduleActiveResult> {
  return _setDuesScheduleActiveImpl(db, session, input);
}

export { toDuesScheduleView };
