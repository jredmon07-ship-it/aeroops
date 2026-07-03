/**
 * deactivate-maintenance-item.ts — deactivateMaintenanceItem write path
 * (Slice P1.5).
 *
 * Soft-delete only (active=false) — mirrors squawk/work_order: no hard-delete
 * command exists on this table. Idempotent: deactivating an already-inactive
 * item is a no-op (ok:true alreadyInactive:true, NO audit row) — mirrors
 * unGroundAircraft's alreadyReleased idempotency posture.
 *
 * GUARANTEES:
 *   - authz first: requireCapability('maintenance:work_order').
 *   - org_id from session only; cross-org id → not_found.
 *   - guarded UPDATE + audit 'maintenance_item.deactivated' (only on the
 *     true→false transition).
 *
 * TWO CALLING FORMS:
 *   deactivateMaintenanceItem(session, input)        — app code.
 *   deactivateMaintenanceItemWithDb(db, session, in) — tests.
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
import type { DeactivateMaintenanceItemResult } from './maintenance-item-types.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const deactivateMaintenanceItemInputSchema = z.object({
  itemId: z.string().regex(UUID_RE, { message: 'itemId must be a UUID' }),
});

export type DeactivateMaintenanceItemInput = z.infer<typeof deactivateMaintenanceItemInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _deactivateMaintenanceItemImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<DeactivateMaintenanceItemResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'maintenance:work_order');

  // 2. VALIDATE.
  const parsed = deactivateMaintenanceItemInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[maintenance] invalid deactivateMaintenanceItem input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { itemId } = parsed.data;

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

    if (!current.active) {
      // Idempotent no-op — NO audit row (mirrors unGroundAircraft alreadyReleased).
      return { ok: true, item: toMaintenanceItemView(current), alreadyInactive: true };
    }

    const [updated] = await tx
      .update(maintenanceItem)
      .set({ active: false, updatedAt: sql`NOW()` })
      .where(eq(maintenanceItem.id, itemId))
      .returning();

    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'maintenance_item.deactivated',
      entityType:  'maintenance_item',
      entityId:    itemId,
      metadata: { resourceId: current.resourceId, title: current.title },
    });

    return { ok: true, item: toMaintenanceItemView(updated!), alreadyInactive: false };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function deactivateMaintenanceItem(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<DeactivateMaintenanceItemResult> {
  const db = await getDb();
  return _deactivateMaintenanceItemImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function deactivateMaintenanceItemWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<DeactivateMaintenanceItemResult> {
  return _deactivateMaintenanceItemImpl(db, session, input);
}
