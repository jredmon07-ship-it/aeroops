/**
 * open-work-order.ts — openWorkOrder write path (Slice M1.2).
 *
 * GUARANTEES:
 *   - authz first: requireCapability('maintenance:work_order') BEFORE any data.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - validates input with Zod → ValidationError on malformed data.
 *   - resource must be visible/active/kind='aircraft' (ValidationError else).
 *   - if squawkId provided: must be visible in org AND on same resourceId (LOCKED #6).
 *   - INSERT status='open', opened_by=session.userId; audit 'work_order.opened'.
 *   - NO FAA/Part-43 determination. [VERIFY-M1-A/B/C/D]
 *
 * TWO CALLING FORMS:
 *   openWorkOrder(session, input)        — app code; uses getDb() internally.
 *   openWorkOrderWithDb(db, session, in) — tests; inject pglite client.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { workOrder, auditLog, resource, squawk } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { toWorkOrderView } from './internal.js';
import type { OpenWorkOrderResult } from './work-order-types.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Input schema ─────────────────────────────────────────────────────────────

const openWorkOrderInputSchema = z.object({
  resourceId:    z.string().regex(UUID_RE, { message: 'resourceId must be a UUID' }),
  title:         z.string().trim().min(1, { message: 'title must not be empty' }),
  description:   z.string().optional(),
  squawkId:      z.string().regex(UUID_RE, { message: 'squawkId must be a UUID' }).optional(),
  workPerformed: z.string().optional(),
});

export type OpenWorkOrderInput = z.infer<typeof openWorkOrderInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _openWorkOrderImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<OpenWorkOrderResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'maintenance:work_order');

  // 2. VALIDATE.
  const parsed = openWorkOrderInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[maintenance] invalid openWorkOrder input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { resourceId, title, description, squawkId, workPerformed } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3a. Verify resource visible/active/kind=aircraft (ValidationError else).
    const resRows = await tx
      .select({ id: resource.id, kind: resource.kind, active: resource.active })
      .from(resource)
      .where(eq(resource.id, resourceId))
      .limit(1);

    const res = resRows[0];
    if (!res) {
      throw new ValidationError(
        `[maintenance] resource ${resourceId} not found in this org.`,
      );
    }
    if (!res.active) {
      throw new ValidationError(
        `[maintenance] resource ${resourceId} is inactive.`,
      );
    }
    if (res.kind !== 'aircraft') {
      throw new ValidationError(
        `[maintenance] resource ${resourceId} has kind '${res.kind}'; work orders are for aircraft only.`,
      );
    }

    // 3b. If squawkId provided: must be visible in-org AND on the SAME resource (LOCKED #6).
    if (squawkId !== undefined) {
      const sqRows = await tx
        .select({ id: squawk.id, resourceId: squawk.resourceId })
        .from(squawk)
        .where(eq(squawk.id, squawkId))
        .limit(1);

      const sq = sqRows[0];
      if (!sq) {
        throw new ValidationError(
          `[maintenance] squawk ${squawkId} not found in this org.`,
        );
      }
      if (sq.resourceId !== resourceId) {
        throw new ValidationError(
          `[maintenance] squawk ${squawkId} is on a different aircraft (resourceId mismatch).`,
        );
      }
    }

    // 3c. INSERT work order status='open'.
    const [inserted] = await tx
      .insert(workOrder)
      .values({
        orgId:         sess.orgId,
        resourceId,
        squawkId:      squawkId ?? null,
        title,
        description:   description ?? null,
        status:        'open',
        workPerformed: workPerformed ?? null,
        openedBy:      sess.userId,
      })
      .returning();

    // 3d. Audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'work_order.opened',
      entityType:  'work_order',
      entityId:    inserted!.id,
      metadata: {
        resourceId,
        squawkId:  squawkId ?? null,
        title,
      },
    });

    return { ok: true, workOrder: toWorkOrderView(inserted!) };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function openWorkOrder(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<OpenWorkOrderResult> {
  const db = await getDb();
  return _openWorkOrderImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function openWorkOrderWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<OpenWorkOrderResult> {
  return _openWorkOrderImpl(db, session, input);
}
