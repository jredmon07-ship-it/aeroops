/**
 * update-maintenance-item.ts — updateMaintenanceItem write path (Slice P1.5).
 *
 * Edits the MUTABLE fields on an existing maintenance_item: title,
 * dueValueHours, dueDate, warnThresholdHours, warnLeadDays, notes.
 * resourceId / trackBy / meterBasis / createdBy are write-once and NOT
 * editable here (mirrors work_order's write-once posture on resource_id/
 * title-at-open). Distinct from markMaintenanceItemServiced, which advances
 * the due threshold as an explicit "serviced" action with its own audit label.
 *
 * At least one editable field must be present in the input (mirrors
 * updateAircraft's "at least one field" posture) — an empty update is a
 * validation error, not a silent no-op.
 *
 * GUARANTEES:
 *   - authz first: requireCapability('maintenance:work_order').
 *   - org_id from session only; cross-org id → not_found (never a 500, never a peek).
 *   - guarded UPDATE (WHERE id=$ — RLS already scopes org) + audit
 *     'maintenance_item.updated' with a before/after diff in metadata.
 *
 * TWO CALLING FORMS:
 *   updateMaintenanceItem(session, input)        — app code.
 *   updateMaintenanceItemWithDb(db, session, in) — tests.
 */
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { maintenanceItem, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { toMaintenanceItemView } from './internal.js';
import type { UpdateMaintenanceItemResult } from './maintenance-item-types.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── Input schema ─────────────────────────────────────────────────────────────

const updateMaintenanceItemInputSchema = z
  .object({
    itemId:              z.string().regex(UUID_RE, { message: 'itemId must be a UUID' }),
    title:               z.string().trim().min(1, { message: 'title must not be empty' }).optional(),
    dueValueHours:       z.number().nonnegative().finite().optional(),
    dueDate:             z.string().regex(ISO_DATE_RE, { message: 'dueDate must be YYYY-MM-DD' }).optional(),
    warnThresholdHours:  z.number().nonnegative().finite().nullable().optional(),
    warnLeadDays:        z.number().int().nonnegative().nullable().optional(),
    notes:               z.string().nullable().optional(),
  })
  .refine(
    (val) =>
      val.title !== undefined ||
      val.dueValueHours !== undefined ||
      val.dueDate !== undefined ||
      val.warnThresholdHours !== undefined ||
      val.warnLeadDays !== undefined ||
      val.notes !== undefined,
    { message: 'at least one field must be provided' },
  );

export type UpdateMaintenanceItemInput = z.infer<typeof updateMaintenanceItemInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _updateMaintenanceItemImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<UpdateMaintenanceItemResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'maintenance:work_order');

  // 2. VALIDATE.
  const parsed = updateMaintenanceItemInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[maintenance] invalid updateMaintenanceItem input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { itemId, title, dueValueHours, dueDate, warnThresholdHours, warnLeadDays, notes } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3a. Load current row (RLS-scoped — cross-org is invisible → not_found).
    const currentRows = await tx
      .select()
      .from(maintenanceItem)
      .where(eq(maintenanceItem.id, itemId))
      .limit(1);
    const current = currentRows[0];
    if (!current) {
      return { ok: false, reason: 'not_found' } as const;
    }

    // 3b. Guard the trackBy shape invariant against caller intent: a
    // 'date'-tracked item cannot receive dueValueHours; an 'hours'-tracked
    // item cannot receive dueDate (the DB shape CHECK is the backstop).
    if (dueValueHours !== undefined && current.trackBy !== 'hours') {
      throw new ValidationError(
        `[maintenance] item ${itemId} is track_by='${current.trackBy}'; dueValueHours only applies to 'hours' items.`,
      );
    }
    if (dueDate !== undefined && current.trackBy !== 'date') {
      throw new ValidationError(
        `[maintenance] item ${itemId} is track_by='${current.trackBy}'; dueDate only applies to 'date' items.`,
      );
    }

    // 3c. Guarded UPDATE — only the provided fields change.
    const [updated] = await tx
      .update(maintenanceItem)
      .set({
        title:              title ?? current.title,
        dueValueHours:      dueValueHours !== undefined ? String(dueValueHours) : current.dueValueHours,
        dueDate:            dueDate ?? current.dueDate,
        warnThresholdHours:
          warnThresholdHours === undefined
            ? current.warnThresholdHours
            : warnThresholdHours === null
              ? null
              : String(warnThresholdHours),
        warnLeadDays: warnLeadDays === undefined ? current.warnLeadDays : warnLeadDays,
        notes:        notes === undefined ? current.notes : notes,
        updatedAt:    sql`NOW()`,
      })
      .where(eq(maintenanceItem.id, itemId))
      .returning();

    // 3d. Audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'maintenance_item.updated',
      entityType:  'maintenance_item',
      entityId:    itemId,
      metadata: {
        before: {
          title: current.title,
          dueValueHours: current.dueValueHours,
          dueDate: current.dueDate,
          warnThresholdHours: current.warnThresholdHours,
          warnLeadDays: current.warnLeadDays,
        },
        after: {
          title: updated!.title,
          dueValueHours: updated!.dueValueHours,
          dueDate: updated!.dueDate,
          warnThresholdHours: updated!.warnThresholdHours,
          warnLeadDays: updated!.warnLeadDays,
        },
      },
    });

    return { ok: true, item: toMaintenanceItemView(updated!) };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function updateMaintenanceItem(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<UpdateMaintenanceItemResult> {
  const db = await getDb();
  return _updateMaintenanceItemImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function updateMaintenanceItemWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<UpdateMaintenanceItemResult> {
  return _updateMaintenanceItemImpl(db, session, input);
}
