/**
 * mark-maintenance-item-serviced.ts — markMaintenanceItemServiced write path
 * (Slice P1.5).
 *
 * "Mark serviced" = the operator's explicit action recording that the item
 * was addressed, ADVANCING the due threshold to a new value the operator
 * supplies (the next due point). Distinct from updateMaintenanceItem
 * (general correction) — this command carries its own audit action label
 * ('maintenance_item.serviced') so a maintenance history is reconstructable
 * from audit_log without a dedicated completion table (see maintenance-
 * item.ts schema-file header for the documented "no completion table"
 * rationale).
 *
 * newDueValueHours is required + valid iff the item is track_by='hours';
 * newDueDate is required + valid iff track_by='date' — mirrors the item's
 * own shape invariant; the wrong field for the item's basis is a
 * ValidationError.
 *
 * GUARANTEES:
 *   - authz first: requireCapability('maintenance:work_order').
 *   - org_id from session only; cross-org id → not_found.
 *   - guarded UPDATE (advances due_value_hours OR due_date, never both) +
 *     audit 'maintenance_item.serviced' (metadata carries old + new threshold
 *     + optional note).
 *   - NO computed FAA/Part-43/91.409 determination; this is an operator
 *     data-entry action, not a return-to-service or airworthiness call.
 *     [VERIFY-P1.5-A]
 *
 * TWO CALLING FORMS:
 *   markMaintenanceItemServiced(session, input)        — app code.
 *   markMaintenanceItemServicedWithDb(db, session, in) — tests.
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
import type { MarkMaintenanceItemServicedResult } from './maintenance-item-types.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const markMaintenanceItemServicedInputSchema = z.object({
  itemId:           z.string().regex(UUID_RE, { message: 'itemId must be a UUID' }),
  newDueValueHours: z.number().nonnegative().finite().optional(),
  newDueDate:       z.string().regex(ISO_DATE_RE, { message: 'newDueDate must be YYYY-MM-DD' }).optional(),
  note:             z.string().optional(),
});

export type MarkMaintenanceItemServicedInput = z.infer<typeof markMaintenanceItemServicedInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _markMaintenanceItemServicedImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<MarkMaintenanceItemServicedResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'maintenance:work_order');

  // 2. VALIDATE.
  const parsed = markMaintenanceItemServicedInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[maintenance] invalid markMaintenanceItemServiced input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { itemId, newDueValueHours, newDueDate, note } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const currentRows = await tx
      .select()
      .from(maintenanceItem)
      .where(eq(maintenanceItem.id, itemId))
      .limit(1);
    const current = currentRows[0];
    if (!current) {
      return { ok: false, reason: 'not_found' } as const;
    }

    // 3. Basis-matched threshold required.
    if (current.trackBy === 'hours') {
      if (newDueValueHours === undefined) {
        throw new ValidationError(
          `[maintenance] item ${itemId} is track_by='hours'; newDueValueHours is required to mark it serviced.`,
        );
      }
      if (newDueDate !== undefined) {
        throw new ValidationError(
          `[maintenance] item ${itemId} is track_by='hours'; newDueDate must not be set.`,
        );
      }
    } else {
      if (newDueDate === undefined) {
        throw new ValidationError(
          `[maintenance] item ${itemId} is track_by='date'; newDueDate is required to mark it serviced.`,
        );
      }
      if (newDueValueHours !== undefined) {
        throw new ValidationError(
          `[maintenance] item ${itemId} is track_by='date'; newDueValueHours must not be set.`,
        );
      }
    }

    const [updated] = await tx
      .update(maintenanceItem)
      .set({
        dueValueHours: newDueValueHours !== undefined ? String(newDueValueHours) : current.dueValueHours,
        dueDate:       newDueDate ?? current.dueDate,
        updatedAt:     sql`NOW()`,
      })
      .where(eq(maintenanceItem.id, itemId))
      .returning();

    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'maintenance_item.serviced',
      entityType:  'maintenance_item',
      entityId:    itemId,
      metadata: {
        resourceId: current.resourceId,
        title: current.title,
        oldDueValueHours: current.dueValueHours,
        oldDueDate: current.dueDate,
        newDueValueHours: newDueValueHours ?? null,
        newDueDate: newDueDate ?? null,
        note: note ?? null,
      },
    });

    return { ok: true, item: toMaintenanceItemView(updated!) };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function markMaintenanceItemServiced(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<MarkMaintenanceItemServicedResult> {
  const db = await getDb();
  return _markMaintenanceItemServicedImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function markMaintenanceItemServicedWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<MarkMaintenanceItemServicedResult> {
  return _markMaintenanceItemServicedImpl(db, session, input);
}
