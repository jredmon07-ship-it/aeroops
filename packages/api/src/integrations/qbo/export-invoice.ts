/**
 * integrations/qbo/export-invoice.ts — exportInvoiceToQbo (Slice QB1).
 *
 * Pushes ONE finalized AeroOps invoice to the org's connected QuickBooks
 * Online company file as a QBO Invoice, with each line item mapped to its
 * own QBO Item by kind (see map-invoice.ts / account-mapping.ts). This is
 * the ONLY place in the app that calls the QBO client to push an invoice.
 *
 * FLOW:
 *   1. requireCapability('billing:manage') FIRST.
 *   2. Load the invoice (must be status='finalized' — draft/void refused).
 *   3. Idempotency: if an 'exported' qbo_export_log row already exists for
 *      this (org, 'invoice', invoiceId), return it verbatim — NO second push.
 *   4. Load line items + join rate_schedule for each line's kind.
 *   5. Load the org's account mapping; build the pure QBO payload via
 *      mapInvoiceToQboPayload — refuse (typed) on unmapped kinds, writing an
 *      'error' export_log row so the refusal is visible in the log.
 *   6. Ensure a QBO Customer exists for the invoice's member (reuse a prior
 *      'exported' customer export_log row, or create one + log it).
 *   7. Push the invoice via the client. On success: write an 'exported'
 *      export_log row + ONE audit row. On any client failure: write an
 *      'error' export_log row + ONE audit row — errors are NEVER silently
 *      swallowed.
 *   8. On an unconfigured/stub client → clean typed { ok:false,
 *      reason:'not_configured' } — never a crash, no export_log row (nothing
 *      was attempted against a real provider).
 *
 * GUARANTEES:
 *   - authz FIRST: billing:manage before any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Refuses draft/void invoices — only 'finalized' invoices export.
 *   - Idempotent: an already-exported invoice is never pushed twice (backed
 *     by the partial UNIQUE index in migration 0021, not just this check).
 *   - NO card/bank data, NO Stripe, NO payment — a bookkeeping export of an
 *     EXISTING invoice record only.
 *
 * TWO CALLING FORMS:
 *   exportInvoiceToQbo(session, input)          — app code.
 *   exportInvoiceToQboWithDb(db, session, input, client?) — tests (client is
 *   always injectable so tests never make a real HTTP call).
 */

import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import {
  invoice,
  invoiceLineItem,
  rateSchedule,
  appUser,
  qboConnection,
  qboExportLog,
  auditLog,
} from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../../auth/session.js';
import { getDb } from '../../db.js';
import type { AppSession } from '../../auth/types.js';
import { ValidationError } from '../../scheduling/internal.js';
import { getQboClient, QboNotConfiguredError } from './client.js';
import type { QboClient, QboRequestContext } from './client.js';
import { mapInvoiceToQboPayload } from './map-invoice.js';
import type { QboLineItemInput } from './map-invoice.js';
import { resolveLineKind } from './line-kind.js';
import { loadQboAccountMap } from './account-mapping.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const exportInvoiceInputSchema = z.object({
  invoiceId: z.string().regex(UUID_RE, { message: 'invoiceId must be a UUID' }),
});

export type ExportInvoiceToQboInput = z.infer<typeof exportInvoiceInputSchema>;

export type ExportInvoiceToQboResult =
  | { ok: true; qboInvoiceId: string; alreadyExported: boolean }
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'not_connected' }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_finalized' }
  | { ok: false; reason: 'unmapped_kinds'; kinds: string[] }
  | { ok: false; reason: 'provider_error'; message: string };

/** Truncate provider error text before it is ever persisted — belt-and-suspenders. */
function truncateErrorDetail(message: string): string {
  return message.slice(0, 500);
}

async function _exportInvoiceToQboImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
  client: QboClient = getQboClient(),
): Promise<ExportInvoiceToQboResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'billing:manage');

  // 2. VALIDATE input.
  const parsed = exportInvoiceInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[qbo] invalid exportInvoiceToQbo input: ${first?.message ?? 'unknown'}`);
  }
  const { invoiceId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Load the invoice — must exist and be finalized.
    const invoiceRows = await tx.select().from(invoice).where(eq(invoice.id, invoiceId)).limit(1);
    const invoiceRow = invoiceRows[0];
    if (!invoiceRow) {
      return { ok: false, reason: 'not_found' } as const;
    }
    if (invoiceRow.status !== 'finalized') {
      return { ok: false, reason: 'not_finalized' } as const;
    }

    // 4. Idempotency check — an 'exported' row already exists → return it, no re-push.
    const existingExport = await tx
      .select()
      .from(qboExportLog)
      .where(
        and(
          eq(qboExportLog.orgId, sess.orgId),
          eq(qboExportLog.entityType, 'invoice'),
          eq(qboExportLog.entityId, invoiceId),
          eq(qboExportLog.status, 'exported'),
        ),
      )
      .limit(1);
    const alreadyExported = existingExport[0];
    if (alreadyExported && alreadyExported.qboId) {
      return { ok: true, qboInvoiceId: alreadyExported.qboId, alreadyExported: true } as const;
    }

    // 5. Load line items + join rate_schedule (for lineKind resolution).
    const lineRows = await tx
      .select({
        description: invoiceLineItem.description,
        quantityHours: invoiceLineItem.quantityHours,
        unitAmountCents: invoiceLineItem.unitAmountCents,
        lineTotalCents: invoiceLineItem.lineTotalCents,
        rateKind: rateSchedule.rateKind,
      })
      .from(invoiceLineItem)
      .leftJoin(rateSchedule, eq(invoiceLineItem.rateScheduleId, rateSchedule.id))
      .where(eq(invoiceLineItem.invoiceId, invoiceId));

    const lines: QboLineItemInput[] = lineRows.map((row) => ({
      description: row.description,
      quantityHours:
        typeof row.quantityHours === 'string' ? parseFloat(row.quantityHours) : (row.quantityHours as number),
      unitAmountCents: row.unitAmountCents,
      lineTotalCents: row.lineTotalCents,
      lineKind: resolveLineKind(row.rateKind ?? null),
    }));

    // 6. Load the member (QBO customer identity source).
    const memberRows = await tx
      .select({ id: appUser.id, email: appUser.email, fullName: appUser.fullName })
      .from(appUser)
      .where(eq(appUser.id, invoiceRow.memberUserId))
      .limit(1);
    const member = memberRows[0];
    const memberDisplayName = member?.fullName?.trim() || member?.email || 'AeroOps member';

    // 7. Load account mapping + build the pure QBO payload.
    const { map: accountMap } = await loadQboAccountMap(tx, sess.orgId);

    // 8. Load the connection — required before ANY provider call.
    const connectionRows = await tx.select().from(qboConnection).where(eq(qboConnection.orgId, sess.orgId)).limit(1);
    const connection = connectionRows[0];
    if (!connection || connection.status !== 'connected' || !connection.accessToken || !connection.realmId) {
      return { ok: false, reason: 'not_connected' } as const;
    }

    // Ensure a fresh access token BEFORE building the payload (fail fast on
    // provider outage before doing further work).
    let ctx: QboRequestContext;
    try {
      ctx = await ensureFreshAccessToken(tx, sess.orgId, connection, client);
    } catch (err) {
      if (err instanceof QboNotConfiguredError) {
        return { ok: false, reason: 'not_configured' } as const;
      }
      const message = err instanceof Error ? err.message : 'Unknown QuickBooks error';
      await tx.insert(qboExportLog).values({
        orgId: sess.orgId,
        entityType: 'invoice',
        entityId: invoiceId,
        status: 'error',
        errorDetail: truncateErrorDetail(message),
      });
      await tx.insert(auditLog).values({
        orgId: sess.orgId,
        actorUserId: sess.userId,
        action: 'billing.invoice_export_failed',
        entityType: 'invoice',
        entityId: invoiceId,
        metadata: { reason: 'token_refresh_failed' },
      });
      return { ok: false, reason: 'provider_error', message } as const;
    }

    // 9. Ensure the QBO Customer exists (reuse a prior export or create + log one).
    let customerRef: { value: string; name?: string };
    const existingCustomerExport = await tx
      .select()
      .from(qboExportLog)
      .where(
        and(
          eq(qboExportLog.orgId, sess.orgId),
          eq(qboExportLog.entityType, 'customer'),
          eq(qboExportLog.entityId, invoiceRow.memberUserId),
          eq(qboExportLog.status, 'exported'),
        ),
      )
      .limit(1);

    if (existingCustomerExport[0]?.qboId) {
      customerRef = { value: existingCustomerExport[0].qboId, name: memberDisplayName };
    } else {
      try {
        const created = await client.createCustomer({ displayName: memberDisplayName, email: member?.email }, ctx);
        customerRef = { value: created.qboCustomerId, name: memberDisplayName };
        await tx.insert(qboExportLog).values({
          orgId: sess.orgId,
          entityType: 'customer',
          entityId: invoiceRow.memberUserId,
          qboId: created.qboCustomerId,
          status: 'exported',
          exportedAt: new Date(),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown QuickBooks error';
        await tx.insert(qboExportLog).values({
          orgId: sess.orgId,
          entityType: 'customer',
          entityId: invoiceRow.memberUserId,
          status: 'error',
          errorDetail: truncateErrorDetail(message),
        });
        await tx.insert(auditLog).values({
          orgId: sess.orgId,
          actorUserId: sess.userId,
          action: 'billing.invoice_export_failed',
          entityType: 'invoice',
          entityId: invoiceId,
          metadata: { reason: 'customer_create_failed' },
        });
        return { ok: false, reason: 'provider_error', message } as const;
      }
    }

    // 10. Build the pure payload — refuse on unmapped kinds (never silently lump).
    const mapped = mapInvoiceToQboPayload({
      aeroopsInvoiceId: invoiceId,
      totalCents: invoiceRow.totalCents,
      customerRef,
      lines,
      accountMap,
    });

    if (!mapped.ok) {
      const detail =
        mapped.reason === 'unmapped_kinds'
          ? `Unmapped QuickBooks GL kinds: ${mapped.kinds.join(', ')}`
          : mapped.reason === 'no_lines'
            ? 'Invoice has no line items to export'
            : `Line total mismatch (expected ${mapped.expectedCents}, computed ${mapped.computedCents})`;
      await tx.insert(qboExportLog).values({
        orgId: sess.orgId,
        entityType: 'invoice',
        entityId: invoiceId,
        status: 'error',
        errorDetail: truncateErrorDetail(detail),
      });
      await tx.insert(auditLog).values({
        orgId: sess.orgId,
        actorUserId: sess.userId,
        action: 'billing.invoice_export_failed',
        entityType: 'invoice',
        entityId: invoiceId,
        metadata: { reason: mapped.reason },
      });
      if (mapped.reason === 'unmapped_kinds') {
        return { ok: false, reason: 'unmapped_kinds', kinds: mapped.kinds } as const;
      }
      return { ok: false, reason: 'provider_error', message: detail } as const;
    }

    // 11. Push the invoice.
    try {
      const created = await client.createInvoice(mapped.payload, ctx);

      await tx.insert(qboExportLog).values({
        orgId: sess.orgId,
        entityType: 'invoice',
        entityId: invoiceId,
        qboId: created.qboInvoiceId,
        status: 'exported',
        exportedAt: new Date(),
      });

      await tx.insert(auditLog).values({
        orgId: sess.orgId,
        actorUserId: sess.userId,
        action: 'billing.invoice_exported_to_qbo',
        entityType: 'invoice',
        entityId: invoiceId,
        metadata: { qboInvoiceId: created.qboInvoiceId, qboCustomerId: customerRef.value },
      });

      return { ok: true, qboInvoiceId: created.qboInvoiceId, alreadyExported: false } as const;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown QuickBooks error';
      await tx.insert(qboExportLog).values({
        orgId: sess.orgId,
        entityType: 'invoice',
        entityId: invoiceId,
        status: 'error',
        errorDetail: truncateErrorDetail(message),
      });
      await tx.insert(auditLog).values({
        orgId: sess.orgId,
        actorUserId: sess.userId,
        action: 'billing.invoice_export_failed',
        entityType: 'invoice',
        entityId: invoiceId,
        metadata: { reason: 'invoice_push_failed' },
      });
      return { ok: false, reason: 'provider_error', message } as const;
    }
  });
}

/**
 * ensureFreshAccessToken — refresh the connection's access token if it is
 * expired (or within a 60s safety margin), persisting the new tokens.
 * Throws QboNotConfiguredError (propagated from the stub client) or the
 * underlying provider error — callers handle both.
 */
async function ensureFreshAccessToken(
  tx: AnyDb,
  orgId: string,
  connection: { accessToken: string | null; refreshToken: string | null; accessTokenExpiresAt: Date | string | null; realmId: string | null },
  client: QboClient,
): Promise<QboRequestContext> {
  const realmId = connection.realmId as string;
  const expiresAt = connection.accessTokenExpiresAt
    ? connection.accessTokenExpiresAt instanceof Date
      ? connection.accessTokenExpiresAt
      : new Date(connection.accessTokenExpiresAt)
    : null;

  const isFresh = expiresAt !== null && expiresAt.getTime() - Date.now() > 60_000;
  if (isFresh && connection.accessToken) {
    return { realmId, accessToken: connection.accessToken };
  }

  if (!connection.refreshToken) {
    throw new Error('[qbo] ensureFreshAccessToken: no refresh_token on file — reconnect required');
  }

  const refreshed = await client.refreshTokens(connection.refreshToken);

  await tx
    .update(qboConnection)
    .set({
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      accessTokenExpiresAt: refreshed.expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(qboConnection.orgId, orgId));

  return { realmId, accessToken: refreshed.accessToken };
}

export async function exportInvoiceToQbo(
  session: AppSession | null | undefined,
  input: unknown,
  client?: QboClient,
): Promise<ExportInvoiceToQboResult> {
  const db = await getDb();
  return _exportInvoiceToQboImpl(db, session, input, client);
}

export async function exportInvoiceToQboWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  client?: QboClient,
): Promise<ExportInvoiceToQboResult> {
  return _exportInvoiceToQboImpl(db, session, input, client);
}
