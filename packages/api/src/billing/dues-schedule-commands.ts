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
import { eq, and } from 'drizzle-orm';
import { membership, duesSchedule, auditLog } from '@aeroops/db';
import type { AnyDb, DuesScheduleSelect } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── View ─────────────────────────────────────────────────────────────────────

export interface DuesScheduleView {
  id: string;
  userId: string;
  amountCents: number;
  cadence: 'monthly';
  dayOfMonth: number;
  active: boolean;
  memo: string | null;
  createdAt: Date;
}

function toDuesScheduleView(row: DuesScheduleSelect): DuesScheduleView {
  return {
    id: row.id,
    userId: row.userId,
    amountCents: row.amountCents,
    cadence: row.cadence as 'monthly',
    dayOfMonth: row.dayOfMonth,
    active: row.active,
    memo: row.memo,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt as unknown as string),
  };
}

// ─── createDuesSchedule ────────────────────────────────────────────────────────

const createDuesScheduleInputSchema = z.object({
  memberUserId: z.string().regex(UUID_RE, { message: 'memberUserId must be a UUID' }),
  amountCents: z.number().int({ message: 'amountCents must be an integer' }).positive({ message: 'amountCents must be > 0' }),
  dayOfMonth: z.number().int().min(1).max(28),
  memo: z.string().trim().min(1).max(500).optional(),
});

export type CreateDuesScheduleInput = z.infer<typeof createDuesScheduleInputSchema>;

export type CreateDuesScheduleResult =
  | { ok: true; schedule: DuesScheduleView }
  | { ok: false; reason: 'member_not_found' };

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
  const { memberUserId, amountCents, dayOfMonth, memo } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const memberRows = await tx
      .select({ userId: membership.userId })
      .from(membership)
      .where(and(eq(membership.userId, memberUserId), eq(membership.orgId, sess.orgId)))
      .limit(1);
    if (!memberRows[0]) {
      return { ok: false, reason: 'member_not_found' } as const;
    }

    const inserted = await tx
      .insert(duesSchedule)
      .values({
        orgId: sess.orgId,
        userId: memberUserId,
        amountCents,
        cadence: 'monthly',
        dayOfMonth,
        active: true,
        memo: memo ?? null,
        createdBy: sess.userId,
      })
      .returning();

    const row = inserted[0];
    if (!row) throw new Error('[billing] createDuesSchedule: INSERT returned no rows');

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'billing.dues_schedule_created',
      entityType: 'dues_schedule',
      entityId: row.id,
      metadata: { memberUserId, amountCents, dayOfMonth },
    });

    return { ok: true, schedule: toDuesScheduleView(row) } as const;
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
    const updated = await tx
      .update(duesSchedule)
      .set({ active, updatedAt: new Date() })
      .where(eq(duesSchedule.id, scheduleId))
      .returning();

    const row = updated[0];
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

    return { ok: true, schedule: toDuesScheduleView(row) } as const;
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
