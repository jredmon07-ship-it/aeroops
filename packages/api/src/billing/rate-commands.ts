/**
 * rate-commands.ts — Rate schedule CRUD (Slice B1).
 *
 * Operator-defined pricing rates. Money as INTEGER CENTS only.
 * NO Stripe, NO payment, NO card data, NO real money movement.
 *
 * GUARANTEES:
 *   - AUTHZ FIRST: billing:manage required for write ops; billing:access for reads.
 *   - org_id from session only (RLS backstop).
 *   - amount_cents must be >= 0 integer (validated by Zod + DB CHECK).
 *   - rate_kind must be one of 'wet_hourly'|'dry_hourly'|'instruction'|'flat'.
 *   - effective window: effective_to > effective_from when both set (DB CHECK mirrors).
 *   - Audited: one audit row per create/delete.
 *   - deleteRateSchedule: soft-check if used in finalized/draft line items → rejects.
 *     Hard-delete only when safe (no invoice_line_item references).
 *
 * TWO CALLING FORMS per command:
 *   fn(session, input)          — app code (uses getDb()).
 *   fnWithDb(db, session, input) — tests (inject pglite).
 */

import { z } from 'zod';
import { eq, isNull } from 'drizzle-orm';
import { rateSchedule, invoiceLineItem, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Rate kinds (mirrors rate_schedule_rate_kind_check) ───────────────────────

const RATE_KINDS = ['wet_hourly', 'dry_hourly', 'instruction', 'flat'] as const;
export type RateKind = (typeof RATE_KINDS)[number];

// ─── View type ─────────────────────────────────────────────────────────────────

export interface RateScheduleView {
  id:            string;
  orgId:         string;
  resourceId:    string | null;
  name:          string;
  rateKind:      RateKind;
  amountCents:   number;
  effectiveFrom: Date;
  effectiveTo:   Date | null;
  createdBy:     string;
  createdAt:     Date;
}

function toRateView(row: typeof rateSchedule.$inferSelect): RateScheduleView {
  return {
    id:            row.id,
    orgId:         row.orgId,
    resourceId:    row.resourceId ?? null,
    name:          row.name,
    rateKind:      row.rateKind as RateKind,
    amountCents:   row.amountCents,
    effectiveFrom: row.effectiveFrom instanceof Date ? row.effectiveFrom : new Date(row.effectiveFrom as string),
    effectiveTo:   row.effectiveTo ? (row.effectiveTo instanceof Date ? row.effectiveTo : new Date(row.effectiveTo as string)) : null,
    createdBy:     row.createdBy,
    createdAt:     row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt as string),
  };
}

// ─── CREATE ───────────────────────────────────────────────────────────────────

const createRateScheduleInputSchema = z.object({
  resourceId:    z.string().regex(UUID_RE).optional(),
  name:          z.string().min(1, { message: 'name must not be empty' }),
  rateKind:      z.enum(RATE_KINDS),
  amountCents:   z
    .number()
    .int({ message: 'amountCents must be an integer' })
    .min(0, { message: 'amountCents must be >= 0' }),
  effectiveFrom: z.coerce.date(),
  effectiveTo:   z.coerce.date().optional(),
}).refine(
  (d) => !d.effectiveTo || d.effectiveTo > d.effectiveFrom,
  { message: 'effectiveTo must be after effectiveFrom' },
);

export type CreateRateScheduleInput = z.infer<typeof createRateScheduleInputSchema>;

export type CreateRateScheduleResult =
  | { ok: true;  rate: RateScheduleView }
  | { ok: false; reason: 'validation_error'; message: string };

async function _createRateScheduleImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<CreateRateScheduleResult> {
  requireCapability(session, 'billing:manage');

  const parsed = createRateScheduleInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[billing] invalid createRateSchedule input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { resourceId, name, rateKind, amountCents, effectiveFrom, effectiveTo } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const inserted = await tx
      .insert(rateSchedule)
      .values({
        orgId:         sess.orgId,
        resourceId:    resourceId ?? null,
        name:          name.trim(),
        rateKind,
        amountCents,
        effectiveFrom,
        effectiveTo:   effectiveTo ?? null,
        createdBy:     sess.userId,
      })
      .returning();

    const row = inserted[0];
    if (!row) throw new Error('[billing] createRateSchedule: INSERT returned no rows');

    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'billing.rate_schedule_created',
      entityType:  'rate_schedule',
      entityId:    row.id,
      metadata: {
        name, rateKind, amountCents,
        resourceId: resourceId ?? null,
        effectiveFrom: effectiveFrom.toISOString(),
        effectiveTo:   effectiveTo?.toISOString() ?? null,
      },
    });

    return { ok: true, rate: toRateView(row) };
  });
}

export async function createRateSchedule(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CreateRateScheduleResult> {
  const db = await getDb();
  return _createRateScheduleImpl(db, session, input);
}

export async function createRateScheduleWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CreateRateScheduleResult> {
  return _createRateScheduleImpl(db, session, input);
}

// ─── LIST ─────────────────────────────────────────────────────────────────────

export interface ListRateSchedulesOptions {
  resourceId?: string | null; // null = org-wide only; undefined = all
}

export interface ListRateSchedulesResult {
  rates: RateScheduleView[];
}

async function _listRateSchedulesImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  options: ListRateSchedulesOptions = {},
): Promise<ListRateSchedulesResult> {
  requireCapability(session, 'billing:access');

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    let query = tx.select().from(rateSchedule);

    // Filter by resourceId if provided.
    if (options.resourceId !== undefined) {
      if (options.resourceId === null) {
        // org-wide rates only (resource_id IS NULL)
        query = query.where(isNull(rateSchedule.resourceId)) as typeof query;
      } else {
        // specific aircraft
        query = query.where(eq(rateSchedule.resourceId, options.resourceId)) as typeof query;
      }
    }

    const rows = await query.orderBy(rateSchedule.effectiveFrom);
    return { rates: rows.map(toRateView) };
  });
}

export async function listRateSchedules(
  session: AppSession | null | undefined,
  options: ListRateSchedulesOptions = {},
): Promise<ListRateSchedulesResult> {
  const db = await getDb();
  return _listRateSchedulesImpl(db, session, options);
}

export async function listRateSchedulesWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  options: ListRateSchedulesOptions = {},
): Promise<ListRateSchedulesResult> {
  return _listRateSchedulesImpl(db, session, options);
}

// ─── DELETE ───────────────────────────────────────────────────────────────────

const deleteRateScheduleInputSchema = z.object({
  id: z.string().regex(UUID_RE, { message: 'id must be a UUID' }),
});

export type DeleteRateScheduleInput = z.infer<typeof deleteRateScheduleInputSchema>;

export type DeleteRateScheduleResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'referenced_by_invoice' };

async function _deleteRateScheduleImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<DeleteRateScheduleResult> {
  requireCapability(session, 'billing:manage');

  const parsed = deleteRateScheduleInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[billing] invalid deleteRateSchedule input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { id } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // Verify the rate exists in this org (RLS scopes).
    const existing = await tx
      .select({ id: rateSchedule.id, name: rateSchedule.name })
      .from(rateSchedule)
      .where(eq(rateSchedule.id, id))
      .limit(1);

    if (!existing[0]) {
      return { ok: false, reason: 'not_found' } as const;
    }

    // Guard: reject if any invoice_line_item references this rate schedule.
    // Billing records must be preserved (RESTRICT FK in migration 0019).
    const references = await tx
      .select({ id: invoiceLineItem.id })
      .from(invoiceLineItem)
      .where(eq(invoiceLineItem.rateScheduleId, id))
      .limit(1);

    if (references.length > 0) {
      return { ok: false, reason: 'referenced_by_invoice' } as const;
    }

    // Safe to delete.
    await tx.delete(rateSchedule).where(eq(rateSchedule.id, id));

    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'billing.rate_schedule_deleted',
      entityType:  'rate_schedule',
      entityId:    id,
      metadata: { rateScheduleId: id, name: existing[0].name },
    });

    return { ok: true };
  });
}

export async function deleteRateSchedule(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<DeleteRateScheduleResult> {
  const db = await getDb();
  return _deleteRateScheduleImpl(db, session, input);
}

export async function deleteRateScheduleWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<DeleteRateScheduleResult> {
  return _deleteRateScheduleImpl(db, session, input);
}
