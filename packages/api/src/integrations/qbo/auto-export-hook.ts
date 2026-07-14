/**
 * integrations/qbo/auto-export-hook.ts — autoExportInvoiceOnFinalize (QBO SYNC
 * layer, migration 0046).
 *
 * The auto-sync counterpart to the manual "Export to QuickBooks" button. Called
 * from the web action layer AFTER finalizeInvoice has already committed
 * (mirrors the post-commit best-effort notification hook in billing/actions.ts),
 * so it can NEVER block or roll back the money path. Behavior:
 *
 *   - Reads the org's auto_export_invoices toggle (graceful absence → OFF when
 *     migration 0046 is unapplied). If OFF → { triggered:false } — a byte-
 *     identical no-op vs. the pre-0046 world.
 *   - If ON → delegates to the FROZEN exportInvoiceToQbo (the same idempotent,
 *     RLS-scoped, billing:manage-gated path the manual button uses). Its typed
 *     refusals (not_connected / unmapped_kinds / provider_error / …) are
 *     returned for observability but are NEVER thrown.
 *
 * This function NEVER throws for a provider/absence failure. The one thing it
 * does NOT catch is an authz error (ForbiddenError/UnauthenticatedError) from
 * exportInvoiceToQbo — but the caller has already succeeded at billing:manage
 * (finalizeInvoice) so that path is unreachable in practice; the web action
 * additionally wraps this call in `.catch(() => {})` as defense-in-depth.
 *
 * TWO CALLING FORMS:
 *   autoExportInvoiceOnFinalize(session, input)          — app code.
 *   autoExportInvoiceOnFinalizeWithDb(db, session, input, client?) — tests.
 */

import { z } from 'zod';
import type { AnyDb } from '@aeroops/db';
import { withSessionOrgContextWithDb } from '../../auth/session.js';
import { getDb } from '../../db.js';
import type { AppSession } from '../../auth/types.js';
import { ValidationError } from '../../scheduling/internal.js';
import { loadQboAutoExportEnabled } from './qbo-sync-internal.js';
import { exportInvoiceToQboWithDb } from './export-invoice.js';
import type { ExportInvoiceToQboResult } from './export-invoice.js';
import { getQboClient } from './client.js';
import type { QboClient } from './client.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const autoExportInputSchema = z.object({
  invoiceId: z.string().regex(UUID_RE, { message: 'invoiceId must be a UUID' }),
});

export type AutoExportInvoiceResult =
  | { triggered: false }
  | { triggered: true; result: ExportInvoiceToQboResult };

async function _autoExportInvoiceOnFinalizeImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
  client: QboClient = getQboClient(),
): Promise<AutoExportInvoiceResult> {
  const parsed = autoExportInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[qbo] invalid autoExportInvoiceOnFinalize input: ${first?.message ?? 'unknown'}`);
  }
  const { invoiceId } = parsed.data;

  // Read the per-org toggle first (graceful absence → OFF). Requires no extra
  // capability — the caller already holds billing:manage; this is a read of the
  // org's own config within its own org context.
  const enabled = await withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    return loadQboAutoExportEnabled(tx, sess.orgId);
  });

  if (!enabled) {
    return { triggered: false };
  }

  const result = await exportInvoiceToQboWithDb(db, session, { invoiceId }, client);
  return { triggered: true, result };
}

export async function autoExportInvoiceOnFinalize(
  session: AppSession | null | undefined,
  input: unknown,
  client?: QboClient,
): Promise<AutoExportInvoiceResult> {
  const db = await getDb();
  return _autoExportInvoiceOnFinalizeImpl(db, session, input, client);
}

export async function autoExportInvoiceOnFinalizeWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  client?: QboClient,
): Promise<AutoExportInvoiceResult> {
  return _autoExportInvoiceOnFinalizeImpl(db, session, input, client);
}
