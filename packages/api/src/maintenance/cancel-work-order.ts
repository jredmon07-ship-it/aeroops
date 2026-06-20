/**
 * cancel-work-order.ts — cancelWorkOrder write path (Slice M1.2).
 *
 * GUARANTEES:
 *   - authz first: requireCapability('maintenance:work_order').
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - validates input with Zod → ValidationError on malformed data.
 *   - cancelledReason REQUIRED.
 *   - Guarded UPDATE WHERE status IN (open, in_progress).
 *   - 0 rows → probe not_found vs not_cancellable.
 *   - audit 'work_order.cancelled'.
 *   - Does NOT resolve squawk or unground aircraft.
 *
 * TWO CALLING FORMS:
 *   cancelWorkOrder(session, input)        — app code.
 *   cancelWorkOrderWithDb(db, session, in) — tests.
 */
import { z } from 'zod';
import { sql, eq, or, and } from 'drizzle-orm';
import { workOrder, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { toWorkOrderView } from './internal.js';
import type { CancelWorkOrderResult } from './work-order-types.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Input schema ─────────────────────────────────────────────────────────────

const cancelWorkOrderInputSchema = z.object({
  workOrderId:     z.string().regex(UUID_RE, { message: 'workOrderId must be a UUID' }),
  cancelledReason: z.string().min(1, { message: 'cancelledReason must not be empty' }),
});

export type CancelWorkOrderInput = z.infer<typeof cancelWorkOrderInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _cancelWorkOrderImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<CancelWorkOrderResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'maintenance:work_order');

  // 2. VALIDATE.
  const parsed = cancelWorkOrderInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[maintenance] invalid cancelWorkOrder input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { workOrderId, cancelledReason } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Guarded UPDATE WHERE id=$ AND status IN (open, in_progress).
    const updated = await tx
      .update(workOrder)
      .set({
        status:          'cancelled',
        cancelledReason,
        cancelledAt:     sql`NOW()`,
        updatedAt:       sql`NOW()`,
      })
      .where(
        or(
          and(eq(workOrder.id, workOrderId), eq(workOrder.status, 'open')),
          and(eq(workOrder.id, workOrderId), eq(workOrder.status, 'in_progress')),
        )!,
      )
      .returning();

    // 4. 0 rows → probe not_found vs not_cancellable.
    if (updated.length === 0) {
      const probe = await tx
        .select({ id: workOrder.id, status: workOrder.status })
        .from(workOrder)
        .where(eq(workOrder.id, workOrderId))
        .limit(1);

      if (!probe[0]) {
        return { ok: false, reason: 'not_found' } as const;
      }
      // Already completed or cancelled.
      return { ok: false, reason: 'not_cancellable' } as const;
    }

    const row = updated[0]!;

    // 5. Audit row (does NOT reference squawk/grounding — cancel is independent).
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'work_order.cancelled',
      entityType:  'work_order',
      entityId:    row.id,
      metadata: {
        workOrderId,
        cancelledReason,
      },
    });

    return { ok: true, workOrder: toWorkOrderView(row) };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function cancelWorkOrder(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CancelWorkOrderResult> {
  const db = await getDb();
  return _cancelWorkOrderImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function cancelWorkOrderWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CancelWorkOrderResult> {
  return _cancelWorkOrderImpl(db, session, input);
}
