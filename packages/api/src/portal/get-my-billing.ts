/**
 * portal/get-my-billing.ts — getMyBilling (Slice P0-REV, C8).
 *
 * SELF-SCOPED (portal:access): the caller's OWN balance, OWN invoices
 * (finalized-or-open, self-scoped by member_user_id = session.userId), OWN
 * saved payment methods (display only), and OWN autopay setting. Resolves
 * [VERIFY-B2-PORTAL] — the first portal surface to expose billing data,
 * strictly self-scoped on top of RLS, mirroring the P1 portal pattern
 * EXACTLY (no row-identifying input; subject is always session.userId).
 *
 * GUARANTEES:
 *   - authz FIRST: portal:access before any data access.
 *   - org_id + subject from session only (withSessionOrgContextWithDb).
 *   - READ-ONLY: zero writes, zero audit rows.
 *   - NO PAN/CVV/account-number anywhere in the returned shape — saved PMs
 *     are DISPLAY fields only (type/last4/brand).
 *
 * TWO CALLING FORMS:
 *   getMyBilling(session)          — app code.
 *   getMyBillingWithDb(db, session) — tests.
 */
import { eq, and, or, desc } from 'drizzle-orm';
import { invoice, stripePaymentMethod, autopaySetting } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { computeBalance } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { findBillingAccountTx, loadLedgerEntryAmountsTx } from '../billing/ledger-internal.js';
import { loadFeePassingEnabled } from '../billing/fee-passing-internal.js';
import { toInvoiceView } from '../billing/list-invoices.js';
import type { InvoiceView } from '../billing/list-invoices.js';
import type { SavedPaymentMethodView } from './save-payment-method.js';
import type { AutopaySettingView } from './set-autopay.js';

export interface MyBillingView {
  balanceCents: number;
  invoices: InvoiceView[];
  paymentMethods: SavedPaymentMethodView[];
  autopay: AutopaySettingView;
  /**
   * Whether the operator passes the ACH processing fee (1%, max $15) through to
   * the member at checkout. When true, the portal shows a fee line and quotes
   * the grossed total. false when fee-passing is off OR migration 0045 is not
   * yet applied (loadFeePassingEnabled degrades to false gracefully).
   */
  feePassingEnabled: boolean;
}

async function _getMyBillingImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<MyBillingView> {
  requireCapability(session, 'portal:access');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const accountId = await findBillingAccountTx(tx, sess.orgId, sess.userId);
    const entries = accountId ? await loadLedgerEntryAmountsTx(tx, accountId) : [];
    const balanceCents = computeBalance(entries);
    const feePassingEnabled = await loadFeePassingEnabled(tx, sess.orgId);

    const invoiceRows = await tx
      .select()
      .from(invoice)
      .where(
        and(
          eq(invoice.memberUserId, sess.userId),
          or(eq(invoice.status, 'finalized'), eq(invoice.status, 'draft'))!,
        ),
      )
      .orderBy(desc(invoice.createdAt));

    const pmRows = await tx
      .select()
      .from(stripePaymentMethod)
      .where(eq(stripePaymentMethod.userId, sess.userId))
      .orderBy(desc(stripePaymentMethod.createdAt));

    const autopayRows = await tx
      .select()
      .from(autopaySetting)
      .where(eq(autopaySetting.userId, sess.userId))
      .limit(1);
    const autopayRow = autopayRows[0];

    return {
      balanceCents,
      invoices: invoiceRows.map(toInvoiceView),
      paymentMethods: pmRows.map((r) => ({
        id: r.id,
        stripePaymentMethodId: r.stripePaymentMethodId,
        type: r.type as SavedPaymentMethodView['type'],
        last4: r.last4,
        brand: r.brand,
      })),
      autopay: {
        enabled: autopayRow?.enabled ?? false,
        defaultPaymentMethodId: autopayRow?.defaultPaymentMethodId ?? null,
      },
      feePassingEnabled,
    };
  });
}

export async function getMyBilling(session: AppSession | null | undefined): Promise<MyBillingView> {
  const db = await getDb();
  return _getMyBillingImpl(db, session);
}

export async function getMyBillingWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<MyBillingView> {
  return _getMyBillingImpl(db, session);
}
