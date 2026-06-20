/**
 * complete-work-order.ts — completeWorkOrder orchestration (Slice M1.2).
 *
 * GUARANTEES:
 *   - authz FIRST: maintenance:work_order required; ALSO maintenance:squawk when
 *     resolveSquawk=true; ALSO maintenance:ground when unground=true.
 *     ALL caps checked UP FRONT before any write (no back door).
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - validates input with Zod → ValidationError on malformed data.
 *   - ONE withSessionOrgContextWithDb tx:
 *       1. Guarded UPDATE WO → completed (sign-off fields + work_performed).
 *       2. if resolveSquawk & WO.squawkId → applySquawkStatusOnTx.
 *       3. if unground → shouldUngroundForWorkOrder → applyUngroundOnTx or skip.
 *   - Up to 3 audit rows (one per real mutation); idempotent no-ops write none.
 *   - Sub-action ids come from the WO row read IN-CONTEXT, never caller input.
 *   - Crash / throw anywhere → whole tx rolls back (atomicity).
 *
 * COMPLIANCE (HARD COMPLIANCE LINE §M1):
 *   'completed' ≠ FAA return-to-service. sign-off = operator data entry.
 *   Unground = explicit operator action (affirmative checkbox), not a computed
 *   clearance. [VERIFY-M1-A/B/C/D]
 *
 * TWO CALLING FORMS:
 *   completeWorkOrder(session, input)        — app code.
 *   completeWorkOrderWithDb(db, session, in) — tests.
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
import {
  toWorkOrderView,
  applySquawkStatusOnTx,
  applyUngroundOnTx,
  loadGroundingProbe,
} from './internal.js';
import { shouldUngroundForWorkOrder } from '@aeroops/core';
import type { CompleteWorkOrderResult } from './work-order-types.js';
import type { GroundingEventView } from './types.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Input schema ─────────────────────────────────────────────────────────────

const completeWorkOrderInputSchema = z.object({
  workOrderId:           z.string().regex(UUID_RE, { message: 'workOrderId must be a UUID' }),
  workPerformed:         z.string().optional(),
  signOffNotes:          z.string().optional(),
  resolveSquawk:         z.boolean().optional().default(false),
  squawkResolutionNotes: z.string().optional(),
  unground:              z.boolean().optional().default(false),
});

export type CompleteWorkOrderInput = z.infer<typeof completeWorkOrderInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _completeWorkOrderImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<CompleteWorkOrderResult> {
  // 1. AUTHZ FIRST — check ALL required caps up front, before any write.
  requireCapability(session, 'maintenance:work_order');

  // Validate input before checking conditional caps (so we know resolveSquawk/unground).
  const parsed = completeWorkOrderInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[maintenance] invalid completeWorkOrder input: ${first?.message ?? 'unknown'}`,
    );
  }
  const {
    workOrderId,
    workPerformed,
    signOffNotes,
    resolveSquawk,
    squawkResolutionNotes,
    unground,
  } = parsed.data;

  // Conditional sub-caps checked UP FRONT (before any tx opens).
  if (resolveSquawk) {
    requireCapability(session, 'maintenance:squawk');
  }
  if (unground) {
    requireCapability(session, 'maintenance:ground');
  }

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 2. Guarded UPDATE WO → completed (WHERE status IN (open, in_progress)).
    const updated = await tx
      .update(workOrder)
      .set({
        status:        'completed',
        workPerformed: workPerformed ?? null,
        signedOffBy:   sess.userId,
        signedOffAt:   sql`NOW()`,
        signOffNotes:  signOffNotes ?? null,
        updatedAt:     sql`NOW()`,
      })
      .where(
        or(
          and(eq(workOrder.id, workOrderId), eq(workOrder.status, 'open')),
          and(eq(workOrder.id, workOrderId), eq(workOrder.status, 'in_progress')),
        )!,
      )
      .returning();

    // 3. 0 rows → probe not_found vs not_completable.
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
      return { ok: false, reason: 'not_completable' } as const;
    }

    const woRow = updated[0]!;

    // 4. Audit row for the WO completion itself.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'work_order.completed',
      entityType:  'work_order',
      entityId:    woRow.id,
      metadata: {
        workOrderId,
        squawkId:     woRow.squawkId ?? null,
        resourceId:   woRow.resourceId,
        signOffNotes: signOffNotes ?? null,
      },
    });

    const workOrderView = toWorkOrderView(woRow);

    // 5. Optional: resolve the linked squawk.
    let squawkView = null;
    let squawkSkipReason: 'no_linked_squawk' | 'already_resolved_or_deferred' | undefined;

    if (resolveSquawk) {
      if (!woRow.squawkId) {
        squawkSkipReason = 'no_linked_squawk';
      } else {
        const sqResult = await applySquawkStatusOnTx(sess, tx, {
          squawkId:        woRow.squawkId,
          status:          'resolved',
          resolutionNotes: squawkResolutionNotes ?? null,
        });

        if (sqResult.ok) {
          squawkView = sqResult.squawkRow;
        } else {
          // not_open means it was already resolved or deferred.
          squawkSkipReason = 'already_resolved_or_deferred';
        }
      }
    }

    // 6. Optional: unground (if the aircraft is grounded for this squawk).
    let groundingView: GroundingEventView | null = null;
    let ungrounded = false;
    let ungroundSkipped: 'not_grounded' | 'grounded_for_other_reason' | 'no_matching_grounding_basis' | undefined;

    if (unground) {
      // Load the current grounding state (with squawkId — extended in M1.2).
      const groundingMap = await loadGroundingProbe(tx, [woRow.resourceId]);
      const groundingEntry = groundingMap.get(woRow.resourceId) ?? {
        grounded: false, reason: null, since: null, groundedBy: null, eventId: null, squawkId: null,
      };

      // Apply the conservative rule (pure, no I/O).
      const rule = shouldUngroundForWorkOrder(groundingEntry, woRow.squawkId ?? null);

      if (!rule.ok) {
        ungroundSkipped = rule.reason;
      } else {
        // Proceed to unground.
        const ugResult = await applyUngroundOnTx(sess, tx, {
          resourceId: woRow.resourceId,
          reason:     `Work order ${woRow.id} completed`,
        });

        if (!ugResult.alreadyReleased && ugResult.groundingRow) {
          const gr = ugResult.groundingRow;
          groundingView = {
            id:               gr.id,
            resourceId:       gr.resourceId,
            state:            gr.state as 'grounded' | 'released',
            reason:           gr.reason,
            squawkId:         gr.squawkId,
            dispatchTicketId: gr.dispatchTicketId,
            createdBy:        gr.createdBy,
            createdAt:        gr.createdAt instanceof Date ? gr.createdAt : new Date(gr.createdAt),
          };
          ungrounded = true;
        }
        // alreadyReleased shouldn't happen here (rule.ok requires grounded), but
        // handle gracefully: leave ungrounded:false, no skip reason.
      }
    }

    const result: Extract<CompleteWorkOrderResult, { ok: true }> = {
      ok: true,
      workOrder: workOrderView,
      squawk: squawkView,
      grounding: groundingView,
      ungrounded,
    };

    if (squawkSkipReason !== undefined) {
      result.squawkResolveSkipped = squawkSkipReason;
    }
    if (ungroundSkipped !== undefined) {
      result.ungroundSkipped = ungroundSkipped;
    }

    return result;
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function completeWorkOrder(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CompleteWorkOrderResult> {
  const db = await getDb();
  return _completeWorkOrderImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function completeWorkOrderWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<CompleteWorkOrderResult> {
  return _completeWorkOrderImpl(db, session, input);
}
