/**
 * integrations/qbo/invoice-export-status.ts — getInvoiceQboStatuses (QBO SYNC
 * layer). Read-only per-invoice QBO export state for the billing invoice list +
 * detail badges. Derived entirely from qbo_export_log:
 *
 *   'exported'     — an 'exported' row exists for the invoice (carries qboId).
 *   'failed'       — no 'exported' row, but at least one 'error' row exists.
 *   'not_exported' — no qbo_export_log rows for the invoice at all.
 *
 * GUARANTEES:
 *   - requireCapability(session, 'billing:access') FIRST.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - NEVER touches migration-0046 objects (reads only the base qbo_export_log
 *     table from migration 0021) — so it is prod-safe with OR without 0046.
 *   - Bounded input (<=200 ids) to keep the IN () list sane.
 *
 * TWO CALLING FORMS:
 *   getInvoiceQboStatuses(session, input)          — app code.
 *   getInvoiceQboStatusesWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { qboExportLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../../auth/session.js';
import { getDb } from '../../db.js';
import type { AppSession } from '../../auth/types.js';
import { ValidationError } from '../../scheduling/internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const getInvoiceQboStatusesInputSchema = z.object({
  invoiceIds: z.array(z.string().regex(UUID_RE, { message: 'invoiceId must be a UUID' })).max(200),
});

export type GetInvoiceQboStatusesInput = z.infer<typeof getInvoiceQboStatusesInputSchema>;

export type QboInvoiceExportStatus = 'not_exported' | 'exported' | 'failed';

export interface QboInvoiceStatusView {
  invoiceId: string;
  status: QboInvoiceExportStatus;
  qboId: string | null;
}

export type GetInvoiceQboStatusesResult = { statuses: QboInvoiceStatusView[] };

async function _getInvoiceQboStatusesImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<GetInvoiceQboStatusesResult> {
  requireCapability(session, 'billing:access');

  const parsed = getInvoiceQboStatusesInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[qbo] invalid getInvoiceQboStatuses input: ${first?.message ?? 'unknown'}`);
  }
  const { invoiceIds } = parsed.data;

  if (invoiceIds.length === 0) {
    return { statuses: [] };
  }

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const rows = await tx
      .select({
        entityId: qboExportLog.entityId,
        status: qboExportLog.status,
        qboId: qboExportLog.qboId,
      })
      .from(qboExportLog)
      .where(
        and(
          eq(qboExportLog.orgId, sess.orgId),
          eq(qboExportLog.entityType, 'invoice'),
          inArray(qboExportLog.entityId, invoiceIds),
        ),
      );

    // Aggregate per invoice: 'exported' wins over 'error' wins over nothing.
    const exportedId = new Map<string, string | null>();
    const hasError = new Set<string>();
    for (const row of rows) {
      if (row.status === 'exported') {
        exportedId.set(row.entityId, row.qboId ?? null);
      } else if (row.status === 'error') {
        hasError.add(row.entityId);
      }
    }

    const statuses: QboInvoiceStatusView[] = invoiceIds.map((invoiceId) => {
      if (exportedId.has(invoiceId)) {
        return { invoiceId, status: 'exported', qboId: exportedId.get(invoiceId) ?? null };
      }
      if (hasError.has(invoiceId)) {
        return { invoiceId, status: 'failed', qboId: null };
      }
      return { invoiceId, status: 'not_exported', qboId: null };
    });

    return { statuses };
  });
}

export async function getInvoiceQboStatuses(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GetInvoiceQboStatusesResult> {
  const db = await getDb();
  return _getInvoiceQboStatusesImpl(db, session, input);
}

export async function getInvoiceQboStatusesWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GetInvoiceQboStatusesResult> {
  return _getInvoiceQboStatusesImpl(db, session, input);
}
