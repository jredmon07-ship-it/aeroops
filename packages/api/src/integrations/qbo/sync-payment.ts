/**
 * integrations/qbo/sync-payment.ts — syncPaymentToQbo (QBO SYNC layer,
 * migration 0046).
 *
 * Pushes ONE QBO ReceivePayment against an already-exported QBO Invoice, from
 * an AeroOps 'payment' ledger_entry that is linked to that invoice. This is the
 * SYNC counterpart to export-invoice.ts: an invoice was exported, the member
 * paid it, and this records that payment in the operator's QBO company file so
 * their books stay reconciled — a bookkeeping SYNC, NEVER a charge.
 *
 * FLOW:
 *   1. requireCapability('billing:manage') FIRST.
 *   2. GRACEFUL ABSENCE: if migration 0046 is unapplied (qbo_export_log cannot
 *      hold entity_type='payment'), return { ok:false, reason:'not_available' }.
 *   3. Load the ledger_entry (must be entry_type='payment' with a non-null
 *      invoice_id — a manual balance payment with no invoice link cannot be
 *      matched to a QBO Invoice).
 *   4. Idempotency: if an 'exported' qbo_export_log row already exists for this
 *      (org,'payment',ledgerEntryId), return it verbatim — NO second push.
 *   5. Find the invoice's own 'exported' qbo_export_log row → the QBO Invoice
 *      id. If the invoice was never exported, refuse (invoice_not_exported).
 *   6. Ensure a fresh access token; on unconfigured stub → not_configured
 *      (no log row — nothing was attempted against a real provider).
 *   7. Resolve the member's exported QBO Customer id (the invoice export always
 *      exports the customer first, so an exported invoice implies one).
 *   8. Push the ReceivePayment. On success: write an 'exported' qbo_export_log
 *      row (entity_type='payment', entity_id=ledgerEntryId) + ONE audit row.
 *      On any provider failure: write an 'error' row + audit — never swallowed.
 *
 * GUARANTEES:
 *   - authz FIRST: billing:manage before any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - Idempotent: a payment is synced AT MOST ONCE per org (backed by the
 *     partial UNIQUE index (org,entity_type,entity_id) WHERE status='exported',
 *     now covering entity_type='payment' via migration 0046).
 *   - BEST-EFFORT: every provider/absence failure is a typed value, never a
 *     throw into a money path — this NEVER blocks payment recording.
 *   - NO card/bank data, NO Stripe, NO charge — a bookkeeping SYNC of an
 *     EXISTING payment record only.
 *
 * THREE CALLING FORMS:
 *   syncPaymentToQbo(session, input)          — app code (operator-initiated).
 *   syncPaymentToQboWithDb(db, session, input, client?) — tests (client injectable).
 *   autoSyncPaymentToQboOnStripeWebhook(db, orgId, ledgerEntryId, client?) —
 *     the SYSTEM path: called best-effort by the Stripe webhook handler AFTER
 *     the payment ledger credit has committed, gated on the org's
 *     auto_export_invoices toggle. No session exists on a webhook; org_id is
 *     the one the webhook already resolved from OUR OWN payment_intent_record
 *     table (never from the Stripe payload), and the audit actor is null —
 *     exactly the 'billing.stripe_payment_succeeded' convention. It NEVER
 *     throws: any unexpected failure degrades to a typed refusal value.
 */

import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { ledgerEntry, invoice, appUser, qboConnection, qboExportLog, auditLog, withOrgContext } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../../auth/session.js';
import { getDb } from '../../db.js';
import type { AppSession } from '../../auth/types.js';
import { ValidationError } from '../../scheduling/internal.js';
import { getQboClient, QboNotConfiguredError } from './client.js';
import type { QboClient, QboRequestContext } from './client.js';
import { centsToQboAmount } from './map-invoice.js';
import { ensureFreshAccessToken } from './token.js';
import { qboConnectionHasAutoExportColumn, loadQboAutoExportEnabled } from './qbo-sync-internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const syncPaymentInputSchema = z.object({
  ledgerEntryId: z.string().regex(UUID_RE, { message: 'ledgerEntryId must be a UUID' }),
});

export type SyncPaymentToQboInput = z.infer<typeof syncPaymentInputSchema>;

export type SyncPaymentToQboResult =
  | { ok: true; qboPaymentId: string; alreadySynced: boolean }
  | { ok: false; reason: 'not_available' }
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'not_connected' }
  | { ok: false; reason: 'entry_not_found' }
  | { ok: false; reason: 'not_a_payment' }
  | { ok: false; reason: 'invoice_not_exported' }
  | { ok: false; reason: 'provider_error'; message: string };

function truncateErrorDetail(message: string): string {
  return message.slice(0, 500);
}

async function _syncPaymentToQboImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
  client: QboClient = getQboClient(),
): Promise<SyncPaymentToQboResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'billing:manage');

  // 2. VALIDATE input.
  const parsed = syncPaymentInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[qbo] invalid syncPaymentToQbo input: ${first?.message ?? 'unknown'}`);
  }
  const { ledgerEntryId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) =>
    _syncPaymentCoreTx(tx, sess.orgId, sess.userId, ledgerEntryId, client),
  );
}

/**
 * _syncPaymentCoreTx — steps 3–11, shared by the session command (actor = the
 * operator) and the webhook system path (actor = null). Runs on an ALREADY
 * org-scoped tx (RLS GUC set by the caller); orgId is only ever the session's
 * or the webhook-resolved one.
 */
async function _syncPaymentCoreTx(
  tx: AnyDb,
  orgId: string,
  actorUserId: string | null,
  ledgerEntryId: string,
  client: QboClient,
): Promise<SyncPaymentToQboResult> {
  {
    // 3. GRACEFUL ABSENCE — payment sync needs migration 0046's widened
    //    entity_type domain; without it, an entity_type='payment' insert would
    //    violate the CHECK. Refuse cleanly instead.
    if (!(await qboConnectionHasAutoExportColumn(tx))) {
      return { ok: false, reason: 'not_available' } as const;
    }

    // 4. Load the payment ledger entry (RLS-scoped to this org).
    const entryRows = await tx
      .select({
        id: ledgerEntry.id,
        entryType: ledgerEntry.entryType,
        amountCents: ledgerEntry.amountCents,
        invoiceId: ledgerEntry.invoiceId,
      })
      .from(ledgerEntry)
      .where(eq(ledgerEntry.id, ledgerEntryId))
      .limit(1);
    const entry = entryRows[0];
    if (!entry) {
      return { ok: false, reason: 'entry_not_found' } as const;
    }
    if (entry.entryType !== 'payment' || !entry.invoiceId) {
      // Not a payment credit, or a balance payment not tied to any invoice —
      // there is no QBO Invoice to link a ReceivePayment to.
      return { ok: false, reason: 'not_a_payment' } as const;
    }
    const paymentInvoiceId = entry.invoiceId;

    // 5. Idempotency — this payment already synced → return it, no re-push.
    const existingPaymentExport = await tx
      .select()
      .from(qboExportLog)
      .where(
        and(
          eq(qboExportLog.orgId, orgId),
          eq(qboExportLog.entityType, 'payment'),
          eq(qboExportLog.entityId, ledgerEntryId),
          eq(qboExportLog.status, 'exported'),
        ),
      )
      .limit(1);
    if (existingPaymentExport[0]?.qboId) {
      return { ok: true, qboPaymentId: existingPaymentExport[0].qboId, alreadySynced: true } as const;
    }

    // 6. The invoice must have been exported to QBO (we link the payment to it).
    const invoiceExport = await tx
      .select()
      .from(qboExportLog)
      .where(
        and(
          eq(qboExportLog.orgId, orgId),
          eq(qboExportLog.entityType, 'invoice'),
          eq(qboExportLog.entityId, paymentInvoiceId),
          eq(qboExportLog.status, 'exported'),
        ),
      )
      .limit(1);
    const qboInvoiceId = invoiceExport[0]?.qboId;
    if (!qboInvoiceId) {
      return { ok: false, reason: 'invoice_not_exported' } as const;
    }

    // 7. Load the invoice's member (for the exported QBO Customer ref).
    const invoiceRows = await tx
      .select({ memberUserId: invoice.memberUserId })
      .from(invoice)
      .where(eq(invoice.id, paymentInvoiceId))
      .limit(1);
    const memberUserId = invoiceRows[0]?.memberUserId;
    if (!memberUserId) {
      // The invoice vanished (extraordinarily unlikely given the export row) —
      // nothing to link to.
      return { ok: false, reason: 'invoice_not_exported' } as const;
    }

    // 8. Load the connection — required before ANY provider call.
    const connectionRows = await tx
      .select()
      .from(qboConnection)
      .where(eq(qboConnection.orgId, orgId))
      .limit(1);
    const connection = connectionRows[0];
    if (!connection || connection.status !== 'connected' || !connection.accessToken || !connection.realmId) {
      return { ok: false, reason: 'not_connected' } as const;
    }

    // 9. Ensure a fresh access token.
    let ctx: QboRequestContext;
    try {
      ctx = await ensureFreshAccessToken(tx, orgId, connection, client);
    } catch (err) {
      if (err instanceof QboNotConfiguredError) {
        return { ok: false, reason: 'not_configured' } as const;
      }
      const message = err instanceof Error ? err.message : 'Unknown QuickBooks error';
      await recordPaymentError(tx, orgId, actorUserId, ledgerEntryId, message, 'token_refresh_failed');
      return { ok: false, reason: 'provider_error', message } as const;
    }

    // 10. Resolve the exported QBO Customer id (the invoice export always
    //     exports the customer first, so an exported invoice implies one).
    const customerExport = await tx
      .select()
      .from(qboExportLog)
      .where(
        and(
          eq(qboExportLog.orgId, orgId),
          eq(qboExportLog.entityType, 'customer'),
          eq(qboExportLog.entityId, memberUserId),
          eq(qboExportLog.status, 'exported'),
        ),
      )
      .limit(1);
    const qboCustomerId = customerExport[0]?.qboId;
    if (!qboCustomerId) {
      const message = 'QuickBooks customer for this invoice has not been exported';
      await recordPaymentError(tx, orgId, actorUserId, ledgerEntryId, message, 'customer_not_exported');
      return { ok: false, reason: 'provider_error', message } as const;
    }

    const memberRows = await tx
      .select({ fullName: appUser.fullName, email: appUser.email })
      .from(appUser)
      .where(eq(appUser.id, memberUserId))
      .limit(1);
    const memberDisplayName = memberRows[0]?.fullName?.trim() || memberRows[0]?.email || 'AeroOps member';

    // 11. Build + push the ReceivePayment.
    const amount = centsToQboAmount(entry.amountCents);
    try {
      const created = await client.createPayment(
        {
          TotalAmt: amount,
          CustomerRef: { value: qboCustomerId, name: memberDisplayName },
          Line: [{ Amount: amount, LinkedTxn: [{ TxnId: qboInvoiceId, TxnType: 'Invoice' }] }],
          PrivateNote: `AeroOps payment ${ledgerEntryId} for invoice ${paymentInvoiceId}`,
        },
        ctx,
      );

      await tx.insert(qboExportLog).values({
        orgId: orgId,
        entityType: 'payment',
        entityId: ledgerEntryId,
        qboId: created.qboPaymentId,
        status: 'exported',
        exportedAt: new Date(),
      });

      await tx.insert(auditLog).values({
        orgId: orgId,
        actorUserId: actorUserId,
        action: 'billing.payment_synced_to_qbo',
        entityType: 'ledger_entry',
        entityId: ledgerEntryId,
        metadata: { qboPaymentId: created.qboPaymentId, qboInvoiceId, invoiceId: paymentInvoiceId },
      });

      return { ok: true, qboPaymentId: created.qboPaymentId, alreadySynced: false } as const;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown QuickBooks error';
      await recordPaymentError(tx, orgId, actorUserId, ledgerEntryId, message, 'payment_push_failed');
      return { ok: false, reason: 'provider_error', message } as const;
    }
  }
}

/** Record a payment-sync failure: ONE 'error' export-log row + ONE audit row. */
async function recordPaymentError(
  tx: AnyDb,
  orgId: string,
  actorUserId: string | null,
  ledgerEntryId: string,
  message: string,
  reason: string,
): Promise<void> {
  await tx.insert(qboExportLog).values({
    orgId,
    entityType: 'payment',
    entityId: ledgerEntryId,
    status: 'error',
    errorDetail: truncateErrorDetail(message),
  });
  await tx.insert(auditLog).values({
    orgId,
    actorUserId,
    action: 'billing.payment_sync_failed',
    entityType: 'ledger_entry',
    entityId: ledgerEntryId,
    metadata: { reason },
  });
}

export async function syncPaymentToQbo(
  session: AppSession | null | undefined,
  input: unknown,
  client?: QboClient,
): Promise<SyncPaymentToQboResult> {
  const db = await getDb();
  return _syncPaymentToQboImpl(db, session, input, client);
}

export async function syncPaymentToQboWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  client?: QboClient,
): Promise<SyncPaymentToQboResult> {
  return _syncPaymentToQboImpl(db, session, input, client);
}

// ─── SYSTEM path: Stripe-webhook auto-sync ─────────────────────────────────────

export type AutoSyncPaymentResult =
  | { triggered: false }
  | { triggered: true; result: SyncPaymentToQboResult };

/**
 * autoSyncPaymentToQboOnStripeWebhook — the webhook's post-commit, best-effort
 * payment sync. NO session (a webhook has none): orgId MUST be the one the
 * webhook resolved from OUR OWN payment_intent_record table. Gated on the org's
 * auto_export_invoices toggle (graceful absence → OFF → { triggered:false },
 * byte-identical to the pre-0046 world). NEVER throws — an unexpected failure
 * degrades to a typed provider_error result so the webhook ack is untouchable.
 */
export async function autoSyncPaymentToQboOnStripeWebhook(
  db: AnyDb,
  orgId: string,
  ledgerEntryId: string,
  client: QboClient = getQboClient(),
): Promise<AutoSyncPaymentResult> {
  try {
    if (!UUID_RE.test(orgId) || !UUID_RE.test(ledgerEntryId)) {
      return { triggered: false };
    }
    return await withOrgContext(db, orgId, async (tx) => {
      const enabled = await loadQboAutoExportEnabled(tx, orgId);
      if (!enabled) {
        return { triggered: false } as const;
      }
      const result = await _syncPaymentCoreTx(tx, orgId, null, ledgerEntryId, client);
      return { triggered: true, result } as const;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown QuickBooks error';
    return { triggered: true, result: { ok: false, reason: 'provider_error', message } };
  }
}
