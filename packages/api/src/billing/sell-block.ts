/**
 * billing/sell-block.ts — sellBlockToMember (Slice B4).
 *
 * An operator sells a member a prepaid, discounted hour bundle ("block
 * time" — THE-BIBLE glossary) — either from an operator-defined
 * block_package, or an ad-hoc hours+amount sale. Records that the member
 * paid for the block (operator-recorded, like recordManualPayment) — NO
 * Stripe, NO card/bank data, NO real money movement.
 *
 * ATOMICALLY (one tx, rollback-on-any-failure):
 *   1. requireCapability('billing:manage') FIRST.
 *   2. memberUserId must be a member of this org (membership check).
 *   3. Resolve the sale's hours + amountCents:
 *        - packageId given  → look up the block_package (must exist in this
 *          org and be active) — hours/amountCents SNAPSHOT its hours/price_cents.
 *        - hours+amountCents given (ad-hoc) → used as-is.
 *   4. ensureBillingAccountTx — lazily creates the account if this is the
 *      member's first-ever ledger activity.
 *   5. INSERT ONE block_purchase row (APPEND-ONLY — see migration 0034).
 *   6. INSERT ONE ledger_entry (entry_type='block_purchase', direction=
 *      'credit', amount_cents=<resolved>) — the SAME B2 ledger
 *      recordManualPayment posts a 'payment' credit to. This RAISES the
 *      member's derived prepaid balance (computeBalance); the EXISTING
 *      invoice-finalize debit + computeBalance draw it down automatically.
 *   7. ONE audit row: 'billing.block_sold'.
 *
 * [DEFERRED — v1, see docs/specs/slice-b4-block-time.md]: this does NOT
 * build a per-flight hours-based discounted-rate DRAWDOWN — v1 tracks
 * remaining prepaid credit ONLY via the existing derived ledger balance
 * (getMemberBlockSummary / getMyBlockSummary read it the same way
 * getMemberBalance / getMyBilling already do).
 *
 * GUARANTEES:
 *   - authz FIRST: billing:manage before any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - hours/amountCents are validated: hours positive w/ <=1 decimal place;
 *     amountCents a positive integer — INTEGER CENTS, never a float.
 *   - APPEND-ONLY: block_purchase and ledger_entry both have no UPDATE/DELETE
 *     RLS policy — a mistaken sale is corrected with a NEW reversing
 *     credit_memo ledger_entry (forward seam), never edited.
 *   - Idempotency is NOT required (each sale is a distinct event) — but the
 *     whole operation is ATOMIC: the block_purchase row and its ledger
 *     credit either both persist or neither does.
 *   - NO Stripe, NO card/bank data.
 *
 * TWO CALLING FORMS:
 *   sellBlockToMember(session, input)          — app code.
 *   sellBlockToMemberWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { membership, blockPackage, blockPurchase, ledgerEntry, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { computeBalance } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { ensureBillingAccountTx, loadLedgerEntryAmountsTx } from './ledger-internal.js';
import { toBlockPackageView, toBlockPurchaseView } from './block-time-internal.js';
import type { BlockPurchaseView } from './block-time-internal.js';
import type { LedgerEntryView } from './ledger-account.js';

export type { BlockPurchaseView } from './block-time-internal.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const hoursSchema = z
  .number({ message: 'hours must be a number' })
  .finite({ message: 'hours must be finite' })
  .positive({ message: 'hours must be > 0' })
  .refine((v) => Math.round(v * 10) === v * 10, {
    message: 'hours must have at most 1 decimal place',
  });

// ─── Input schema ─────────────────────────────────────────────────────────────
//
// Either packageId (a catalog sale) OR both hours+amountCents (an ad-hoc
// sale) must be provided — never both, never neither.

const sellBlockToMemberInputSchema = z
  .object({
    memberId: z.string().regex(UUID_RE, { message: 'memberId must be a UUID' }),
    packageId: z.string().regex(UUID_RE, { message: 'packageId must be a UUID' }).optional(),
    hours: hoursSchema.optional(),
    amountCents: z
      .number()
      .int({ message: 'amountCents must be an integer' })
      .positive({ message: 'amountCents must be > 0' })
      .optional(),
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .superRefine((val, ctx) => {
    const hasPackage = val.packageId !== undefined;
    const hasAdhoc = val.hours !== undefined || val.amountCents !== undefined;
    if (hasPackage && hasAdhoc) {
      ctx.addIssue({
        code: 'custom',
        message: 'provide either packageId OR hours+amountCents, not both',
      });
      return;
    }
    if (!hasPackage && !hasAdhoc) {
      ctx.addIssue({
        code: 'custom',
        message: 'provide either packageId or hours+amountCents',
      });
      return;
    }
    if (!hasPackage) {
      if (val.hours === undefined) {
        ctx.addIssue({ code: 'custom', message: 'hours is required for an ad-hoc sale' });
      }
      if (val.amountCents === undefined) {
        ctx.addIssue({ code: 'custom', message: 'amountCents is required for an ad-hoc sale' });
      }
    }
  });

export type SellBlockToMemberInput = z.infer<typeof sellBlockToMemberInputSchema>;

// ─── Result type ──────────────────────────────────────────────────────────────

export type SellBlockToMemberResult =
  | {
      ok: true;
      purchase: BlockPurchaseView;
      entry: LedgerEntryView;
      balanceCentsAfter: number;
    }
  | { ok: false; reason: 'member_not_found' | 'package_not_found' | 'package_inactive' };

// ─── Shared implementation ────────────────────────────────────────────────────

async function _sellBlockToMemberImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SellBlockToMemberResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'billing:manage');

  // 2. VALIDATE input.
  const parsed = sellBlockToMemberInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[billing] invalid sellBlockToMember input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { memberId, packageId, hours: adhocHours, amountCents: adhocAmountCents, note } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. memberId must be a member of THIS org.
    const memberRows = await tx
      .select({ userId: membership.userId })
      .from(membership)
      .where(and(eq(membership.userId, memberId), eq(membership.orgId, sess.orgId)))
      .limit(1);
    if (!memberRows[0]) {
      return { ok: false, reason: 'member_not_found' } as const;
    }

    // 4. Resolve hours + amountCents (package sale vs ad-hoc).
    let hours: number;
    let amountCents: number;
    let resolvedPackageId: string | null;
    let packageName: string | null = null;

    if (packageId !== undefined) {
      const pkgRows = await tx
        .select()
        .from(blockPackage)
        .where(eq(blockPackage.id, packageId))
        .limit(1);
      const pkgRow = pkgRows[0];
      if (!pkgRow) {
        return { ok: false, reason: 'package_not_found' } as const;
      }
      if (!pkgRow.active) {
        return { ok: false, reason: 'package_inactive' } as const;
      }
      const pkgView = toBlockPackageView(pkgRow);
      hours = pkgView.hours;
      amountCents = pkgView.priceCents;
      resolvedPackageId = pkgView.id;
      packageName = pkgView.name;
    } else {
      hours = adhocHours!;
      amountCents = adhocAmountCents!;
      resolvedPackageId = null;
    }

    // 5. Lazily ensure the billing_account row.
    const accountId = await ensureBillingAccountTx(tx, sess.orgId, memberId);

    // 6. INSERT the block_purchase row (APPEND-ONLY).
    const purchaseRows = await tx
      .insert(blockPurchase)
      .values({
        orgId: sess.orgId,
        userId: memberId,
        packageId: resolvedPackageId,
        hours: String(hours),
        amountCents,
        note: note ?? null,
        createdBy: sess.userId,
      })
      .returning();
    const purchaseRow = purchaseRows[0];
    if (!purchaseRow) {
      throw new Error('[billing] sellBlockToMember: block_purchase INSERT returned no rows');
    }

    // 7. INSERT the 'block_purchase' credit ledger_entry (SAME B2 ledger).
    const memo = note ?? (packageName ? `Block time — ${packageName}` : 'Block time (ad-hoc)');
    const entryRows = await tx
      .insert(ledgerEntry)
      .values({
        orgId: sess.orgId,
        accountId,
        entryType: 'block_purchase',
        direction: 'credit',
        amountCents,
        invoiceId: null,
        paymentId: null,
        memo,
        createdBy: sess.userId,
      })
      .returning();
    const entryRow = entryRows[0];
    if (!entryRow) {
      throw new Error('[billing] sellBlockToMember: ledger_entry INSERT returned no rows');
    }

    // 8. ONE audit row.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'billing.block_sold',
      entityType: 'block_purchase',
      entityId: purchaseRow.id,
      metadata: {
        memberUserId: memberId,
        packageId: resolvedPackageId,
        hours,
        amountCents,
      },
    });

    // 9. Fresh derived balance for the caller's convenience.
    const entries = await loadLedgerEntryAmountsTx(tx, accountId);
    const balanceCentsAfter = computeBalance(entries);

    return {
      ok: true,
      purchase: toBlockPurchaseView(purchaseRow),
      entry: {
        id: entryRow.id,
        entryType: entryRow.entryType as LedgerEntryView['entryType'],
        direction: entryRow.direction as LedgerEntryView['direction'],
        amountCents: entryRow.amountCents,
        invoiceId: entryRow.invoiceId,
        paymentId: entryRow.paymentId,
        memo: entryRow.memo,
        createdBy: entryRow.createdBy,
        createdAt:
          entryRow.createdAt instanceof Date ? entryRow.createdAt : new Date(entryRow.createdAt as string),
      },
      balanceCentsAfter,
    } as const;
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function sellBlockToMember(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SellBlockToMemberResult> {
  const db = await getDb();
  return _sellBlockToMemberImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function sellBlockToMemberWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SellBlockToMemberResult> {
  return _sellBlockToMemberImpl(db, session, input);
}
