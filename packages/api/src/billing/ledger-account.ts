/**
 * billing/ledger-account.ts — read the ledger for a member (Slice B2).
 *
 * getMemberBalance: DERIVED balance for one member, via computeBalance
 *   (@aeroops/core) over that member's ledger_entry rows. NO stored/cached
 *   balance column exists anywhere — this is always computed fresh.
 * listLedgerEntries: keyset-paginated, reverse-chronological ledger history
 *   for one member.
 *
 * GUARANTEES:
 *   - authz FIRST: billing:access before any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - memberUserId must be an app_user in this org (membership check);
 *     else { ok:false, reason:'not_found' } — no cross-org account can ever
 *     be looked up (RLS also backstops this).
 *   - READ-ONLY: zero writes, zero audit rows (reading a balance/ledger is
 *     not itself a money-relevant mutation).
 *   - NO Stripe, NO card/bank data.
 *
 * TWO CALLING FORMS per function:
 *   fn(session, input)          — app code.
 *   fnWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { membership } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { computeBalance } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { loadDispatchConfig } from '../dispatch-gate/internal.js';
import { findBillingAccountTx, loadLedgerEntryAmountsTx } from './ledger-internal.js';
import { extractRows } from '../db-rows.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── getMemberBalance ─────────────────────────────────────────────────────────

const memberIdSchema = z.object({
  memberUserId: z.string().regex(UUID_RE, { message: 'memberUserId must be a UUID' }),
});

export type GetMemberBalanceResult =
  | { ok: true; balanceCents: number; minimumBalanceCents: number }
  | { ok: false; reason: 'not_found' };

async function _getMemberBalanceImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<GetMemberBalanceResult> {
  requireCapability(session, 'billing:access');

  const parsed = memberIdSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[billing] invalid getMemberBalance input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { memberUserId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // memberUserId must be a member of THIS org — RLS also backstops this
    // (membership rows are org-scoped), this is a defense-in-depth explicit
    // check that gives a clean not_found instead of a silently-empty result.
    const memberRows = await tx
      .select({ userId: membership.userId })
      .from(membership)
      .where(and(eq(membership.userId, memberUserId), eq(membership.orgId, sess.orgId)))
      .limit(1);
    if (!memberRows[0]) {
      return { ok: false, reason: 'not_found' } as const;
    }

    const accountId = await findBillingAccountTx(tx, sess.orgId, memberUserId);
    const entries = accountId ? await loadLedgerEntryAmountsTx(tx, accountId) : [];
    const balanceCents = computeBalance(entries);

    const cfg = await loadDispatchConfig(tx, sess.orgId);

    return { ok: true, balanceCents, minimumBalanceCents: cfg.minimumBalanceCents } as const;
  });
}

export async function getMemberBalance(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GetMemberBalanceResult> {
  const db = await getDb();
  return _getMemberBalanceImpl(db, session, input);
}

export async function getMemberBalanceWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GetMemberBalanceResult> {
  return _getMemberBalanceImpl(db, session, input);
}

// ─── listLedgerEntries ────────────────────────────────────────────────────────

export interface LedgerEntryView {
  id: string;
  entryType: 'invoice_finalized' | 'payment' | 'credit_memo' | 'adjustment' | 'block_purchase';
  direction: 'debit' | 'credit';
  amountCents: number;
  invoiceId: string | null;
  paymentId: string | null;
  memo: string | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface LedgerEntryCursor {
  createdAt: Date;
  id: string;
}

export interface ListLedgerEntriesOptions {
  memberUserId: string;
  limit?: number;
  cursor?: LedgerEntryCursor;
}

export type ListLedgerEntriesResult =
  | { ok: true; entries: LedgerEntryView[]; nextCursor?: LedgerEntryCursor }
  | { ok: false; reason: 'not_found' };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

interface LedgerEntryRow {
  id: string;
  entryType: string;
  direction: string;
  amountCents: number;
  invoiceId: string | null;
  paymentId: string | null;
  memo: string | null;
  createdBy: string | null;
  createdAt: Date | string;
}

function toLedgerEntryView(row: LedgerEntryRow): LedgerEntryView {
  return {
    id: row.id,
    entryType: row.entryType as LedgerEntryView['entryType'],
    direction: row.direction as LedgerEntryView['direction'],
    amountCents: row.amountCents,
    invoiceId: row.invoiceId,
    paymentId: row.paymentId,
    memo: row.memo,
    createdBy: row.createdBy,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
  };
}

async function _listLedgerEntriesImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  options: ListLedgerEntriesOptions,
): Promise<ListLedgerEntriesResult> {
  requireCapability(session, 'billing:access');

  const parsed = memberIdSchema.safeParse({ memberUserId: options.memberUserId });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[billing] invalid listLedgerEntries input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { memberUserId } = parsed.data;
  const limit = Math.min(
    options.limit !== undefined && options.limit > 0 ? options.limit : DEFAULT_LIMIT,
    MAX_LIMIT,
  );
  const cursor = options.cursor;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const memberRows = await tx
      .select({ userId: membership.userId })
      .from(membership)
      .where(and(eq(membership.userId, memberUserId), eq(membership.orgId, sess.orgId)))
      .limit(1);
    if (!memberRows[0]) {
      return { ok: false, reason: 'not_found' } as const;
    }

    const accountId = await findBillingAccountTx(tx, sess.orgId, memberUserId);
    if (!accountId) {
      return { ok: true, entries: [] } as const;
    }

    // Keyset cursor: (created_at, id) < (cursor.createdAt, cursor.id).
    // ISO strings + ::timestamptz — never interpolate a JS Date into sql``
    // (postgres-js cannot serialize a raw Date at the wire encoder).
    let rows: LedgerEntryRow[];
    if (cursor) {
      const result = await tx.execute(sql`
        SELECT
          id                AS "id",
          entry_type        AS "entryType",
          direction         AS "direction",
          amount_cents      AS "amountCents",
          invoice_id        AS "invoiceId",
          payment_id        AS "paymentId",
          memo              AS "memo",
          created_by        AS "createdBy",
          created_at        AS "createdAt"
        FROM ledger_entry
        WHERE account_id = ${accountId}::uuid
          AND (created_at, id) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}
      `);
      rows = extractRows<LedgerEntryRow>(result);
    } else {
      const result = await tx.execute(sql`
        SELECT
          id                AS "id",
          entry_type        AS "entryType",
          direction         AS "direction",
          amount_cents      AS "amountCents",
          invoice_id        AS "invoiceId",
          payment_id        AS "paymentId",
          memo              AS "memo",
          created_by        AS "createdBy",
          created_at        AS "createdAt"
        FROM ledger_entry
        WHERE account_id = ${accountId}::uuid
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}
      `);
      rows = extractRows<LedgerEntryRow>(result);
    }

    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;
    const entries = pageRows.map(toLedgerEntryView);

    let nextCursor: LedgerEntryCursor | undefined;
    if (hasNextPage && entries.length > 0) {
      const last = entries[entries.length - 1]!;
      nextCursor = { createdAt: last.createdAt, id: last.id };
    }

    return { ok: true, entries, ...(nextCursor ? { nextCursor } : {}) } as const;
  });
}

export async function listLedgerEntries(
  session: AppSession | null | undefined,
  options: ListLedgerEntriesOptions,
): Promise<ListLedgerEntriesResult> {
  const db = await getDb();
  return _listLedgerEntriesImpl(db, session, options);
}

export async function listLedgerEntriesWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  options: ListLedgerEntriesOptions,
): Promise<ListLedgerEntriesResult> {
  return _listLedgerEntriesImpl(db, session, options);
}
