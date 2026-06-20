/**
 * update-work-order-status.ts — updateWorkOrderStatus write path (Slice M1.2).
 *
 * GUARANTEES:
 *   - authz first: requireCapability('maintenance:work_order').
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - validates input with Zod → ValidationError on malformed data.
 *   - Accepts status 'in_progress' ONLY (complete → completeWorkOrder; cancel → cancelWorkOrder).
 *   - Guarded UPDATE WHERE id=$ AND status='open'.
 *   - 0 rows → probe not_found vs invalid_transition.
 *   - audit 'work_order.status_changed'.
 *
 * TWO CALLING FORMS:
 *   updateWorkOrderStatus(session, input)        — app code.
 *   updateWorkOrderStatusWithDb(db, session, in) — tests.
 */
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { workOrder, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { toWorkOrderView } from './internal.js';
import { eq, and } from 'drizzle-orm';
import type { UpdateWorkOrderStatusResult } from './work-order-types.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Input schema ─────────────────────────────────────────────────────────────

const updateWorkOrderStatusInputSchema = z.object({
  workOrderId: z.string().regex(UUID_RE, { message: 'workOrderId must be a UUID' }),
  status:      z.literal('in_progress', { message: "status must be 'in_progress'" }),
});

export type UpdateWorkOrderStatusInput = z.infer<typeof updateWorkOrderStatusInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _updateWorkOrderStatusImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<UpdateWorkOrderStatusResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'maintenance:work_order');

  // 2. VALIDATE.
  const parsed = updateWorkOrderStatusInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[maintenance] invalid updateWorkOrderStatus input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { workOrderId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Guarded UPDATE WHERE id=$ AND status='open'.
    const updated = await tx
      .update(workOrder)
      .set({
        status:    'in_progress',
        updatedAt: sql`NOW()`,
      })
      .where(
        and(
          eq(workOrder.id, workOrderId),
          eq(workOrder.status, 'open'),
        ),
      )
      .returning();

    // 4. 0 rows → probe not_found vs invalid_transition.
    if (updated.length === 0) {
      const probe = await tx
        .select({ id: workOrder.id, status: workOrder.status })
        .from(workOrder)
        .where(eq(workOrder.id, workOrderId))
        .limit(1);

      if (!probe[0]) {
        return { ok: false, reason: 'not_found' } as const;
      }
      // Exists but not open (terminal or already in_progress).
      return { ok: false, reason: 'invalid_transition' } as const;
    }

    const row = updated[0]!;

    // 5. Audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'work_order.status_changed',
      entityType:  'work_order',
      entityId:    row.id,
      metadata: {
        workOrderId,
        newStatus: 'in_progress',
      },
    });

    return { ok: true, workOrder: toWorkOrderView(row) };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function updateWorkOrderStatus(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<UpdateWorkOrderStatusResult> {
  const db = await getDb();
  return _updateWorkOrderStatusImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function updateWorkOrderStatusWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<UpdateWorkOrderStatusResult> {
  return _updateWorkOrderStatusImpl(db, session, input);
}
