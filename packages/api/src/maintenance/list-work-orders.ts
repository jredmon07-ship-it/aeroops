/**
 * list-work-orders.ts — listWorkOrders + getWorkOrderDetail read paths (Slice M1.2).
 *
 * GUARANTEES:
 *   - authz first: requireCapability('maintenance:access') BEFORE any data.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - listWorkOrders: optional resourceId/status filters; ORDER BY created_at DESC LIMIT 50.
 *   - getWorkOrderDetail: joins linked squawk via toSquawkView; cross-org → not_found.
 *
 * TWO CALLING FORMS each:
 *   listWorkOrders(session, input)           — app code.
 *   listWorkOrdersWithDb(db, session, input) — tests.
 *   getWorkOrderDetail(session, input)           — app code.
 *   getWorkOrderDetailWithDb(db, session, input) — tests.
 */
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { toWorkOrderView, toSquawkView } from './internal.js';
import type {
  ListWorkOrdersResult,
  GetWorkOrderDetailResult,
} from './work-order-types.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── listWorkOrders ───────────────────────────────────────────────────────────

const listWorkOrdersInputSchema = z.object({
  resourceId: z.string().regex(UUID_RE, { message: 'resourceId must be a UUID' }).optional(),
  status: z.enum(['open', 'in_progress', 'completed', 'cancelled']).optional(),
});

export type ListWorkOrdersInput = z.infer<typeof listWorkOrdersInputSchema>;

async function _listWorkOrdersImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<ListWorkOrdersResult> {
  requireCapability(session, 'maintenance:access');

  const parsed = listWorkOrdersInputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[maintenance] invalid listWorkOrders input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { resourceId, status } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // Build WHERE conditions additively.
    const resourceFilter = resourceId
      ? sql`AND wo.resource_id = ${resourceId}::uuid`
      : sql``;
    const statusFilter = status
      ? sql`AND wo.status = ${status}::work_order_status`
      : sql``;

    const result = await tx.execute(sql`
      SELECT
        wo.id,
        wo.org_id            AS "orgId",
        wo.resource_id       AS "resourceId",
        wo.squawk_id         AS "squawkId",
        wo.title,
        wo.description,
        wo.status,
        wo.work_performed    AS "workPerformed",
        wo.opened_by         AS "openedBy",
        wo.opened_at         AS "openedAt",
        wo.signed_off_by     AS "signedOffBy",
        wo.signed_off_at     AS "signedOffAt",
        wo.sign_off_notes    AS "signOffNotes",
        wo.cancelled_reason  AS "cancelledReason",
        wo.cancelled_at      AS "cancelledAt",
        wo.created_at        AS "createdAt",
        wo.updated_at        AS "updatedAt"
      FROM work_order wo
      WHERE 1=1
        ${resourceFilter}
        ${statusFilter}
      ORDER BY wo.created_at DESC
      LIMIT 50
    `);

    const rows = (result.rows ?? result) as Array<{
      id: string;
      orgId: string;
      resourceId: string;
      squawkId: string | null;
      title: string;
      description: string | null;
      status: string;
      workPerformed: string | null;
      openedBy: string;
      openedAt: Date | string;
      signedOffBy: string | null;
      signedOffAt: Date | string | null;
      signOffNotes: string | null;
      cancelledReason: string | null;
      cancelledAt: Date | string | null;
      createdAt: Date | string;
      updatedAt: Date | string;
    }>;

    return { ok: true, workOrders: rows.map(toWorkOrderView) };
  });
}

export async function listWorkOrders(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<ListWorkOrdersResult> {
  const db = await getDb();
  return _listWorkOrdersImpl(db, session, input);
}

export async function listWorkOrdersWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<ListWorkOrdersResult> {
  return _listWorkOrdersImpl(db, session, input);
}

// ─── getWorkOrderDetail ───────────────────────────────────────────────────────

const getWorkOrderDetailInputSchema = z.object({
  workOrderId: z.string().regex(UUID_RE, { message: 'workOrderId must be a UUID' }),
});

export type GetWorkOrderDetailInput = z.infer<typeof getWorkOrderDetailInputSchema>;

async function _getWorkOrderDetailImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<GetWorkOrderDetailResult> {
  requireCapability(session, 'maintenance:access');

  const parsed = getWorkOrderDetailInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[maintenance] invalid getWorkOrderDetail input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { workOrderId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // Fetch the work order (RLS-scoped; cross-org → 0 rows).
    const woResult = await tx.execute(sql`
      SELECT
        id,
        org_id            AS "orgId",
        resource_id       AS "resourceId",
        squawk_id         AS "squawkId",
        title,
        description,
        status,
        work_performed    AS "workPerformed",
        opened_by         AS "openedBy",
        opened_at         AS "openedAt",
        signed_off_by     AS "signedOffBy",
        signed_off_at     AS "signedOffAt",
        sign_off_notes    AS "signOffNotes",
        cancelled_reason  AS "cancelledReason",
        cancelled_at      AS "cancelledAt",
        created_at        AS "createdAt",
        updated_at        AS "updatedAt"
      FROM work_order
      WHERE id = ${workOrderId}::uuid
      LIMIT 1
    `);

    const woRows = (woResult.rows ?? woResult) as Array<{
      id: string;
      orgId: string;
      resourceId: string;
      squawkId: string | null;
      title: string;
      description: string | null;
      status: string;
      workPerformed: string | null;
      openedBy: string;
      openedAt: Date | string;
      signedOffBy: string | null;
      signedOffAt: Date | string | null;
      signOffNotes: string | null;
      cancelledReason: string | null;
      cancelledAt: Date | string | null;
      createdAt: Date | string;
      updatedAt: Date | string;
    }>;

    const woRow = woRows[0];
    if (!woRow) {
      return { ok: false, reason: 'not_found' };
    }

    const workOrderView = toWorkOrderView(woRow);

    // If squawk is linked, fetch it (RLS-scoped; squawk deleted → SET NULL, so squawkId will already be null).
    let squawkView = null;
    if (woRow.squawkId) {
      const sqResult = await tx.execute(sql`
        SELECT
          id,
          resource_id        AS "resourceId",
          dispatch_ticket_id AS "dispatchTicketId",
          title,
          description,
          severity,
          status,
          reported_by        AS "reportedBy",
          reported_at        AS "reportedAt",
          resolution_notes   AS "resolutionNotes",
          resolved_by        AS "resolvedBy",
          resolved_at        AS "resolvedAt"
        FROM squawk
        WHERE id = ${woRow.squawkId}::uuid
        LIMIT 1
      `);

      const sqRows = (sqResult.rows ?? sqResult) as Array<{
        id: string;
        resourceId: string;
        dispatchTicketId: string | null;
        title: string;
        description: string | null;
        severity: string;
        status: string;
        reportedBy: string;
        reportedAt: Date | string;
        resolutionNotes: string | null;
        resolvedBy: string | null;
        resolvedAt: Date | string | null;
      }>;

      if (sqRows[0]) {
        squawkView = toSquawkView(sqRows[0]);
      }
    }

    return { ok: true, workOrder: workOrderView, squawk: squawkView };
  });
}

export async function getWorkOrderDetail(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GetWorkOrderDetailResult> {
  const db = await getDb();
  return _getWorkOrderDetailImpl(db, session, input);
}

export async function getWorkOrderDetailWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GetWorkOrderDetailResult> {
  return _getWorkOrderDetailImpl(db, session, input);
}
