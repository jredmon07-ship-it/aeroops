/**
 * integrations/qbo/account-mapping.ts — per-org QBO GL-mapping CRUD (Slice QB1).
 *
 * setQboAccountMapping / deleteQboAccountMapping — org:manage_settings (a
 * settings-configuration write, same authority as booking retention config).
 * loadQboAccountMap — internal read helper (no cap check; called from
 * ALREADY-gated callers: getQboStatus (billing:access) + exportInvoiceToQbo
 * (billing:manage) — both requireCapability before calling this).
 *
 * GUARANTEES:
 *   - requireCapability FIRST on every exported *command* (loadQboAccountMap
 *     is an internal helper, not exported from the package barrel).
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - setQboAccountMapping: UPSERT via UNIQUE(org_id,line_kind) — ONE audit row.
 *   - deleteQboAccountMapping: hard-delete a mapping row — ONE audit row.
 *   - NO money, NO Stripe, NO card/bank data — this maps CHARGE KINDS to a
 *     QBO Item id/name string pair, nothing else.
 *
 * TWO CALLING FORMS per command:
 *   fn(session, input)          — app code.
 *   fnWithDb(db, session, input) — tests.
 */

import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { qboAccountMapping, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../../auth/session.js';
import { getDb } from '../../db.js';
import type { AppSession } from '../../auth/types.js';
import { ValidationError } from '../../scheduling/internal.js';
import { QBO_LINE_KINDS } from './line-kind.js';
import type { QboLineKind } from './line-kind.js';
import type { QboAccountMap } from './map-invoice.js';

// ─── View type ─────────────────────────────────────────────────────────────────

export interface QboAccountMappingView {
  lineKind: QboLineKind;
  qboItemId: string;
  qboItemName: string;
  updatedAt: Date;
}

function toView(row: typeof qboAccountMapping.$inferSelect): QboAccountMappingView {
  return {
    lineKind: row.lineKind as QboLineKind,
    qboItemId: row.qboItemId,
    qboItemName: row.qboItemName,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt as string),
  };
}

// ─── Internal read helper (no cap check — caller is already gated) ────────────

/**
 * loadQboAccountMap — reads the org's full mapping table (within an
 * already-org-scoped tx) and returns both the list view (for display) and a
 * dict keyed by line_kind (for the pure mapper in map-invoice.ts).
 *
 * NOT exported from the package barrel — internal to integrations/qbo/*.
 */
export async function loadQboAccountMap(
  tx: AnyDb,
  orgId: string,
): Promise<{ rows: QboAccountMappingView[]; map: QboAccountMap }> {
  const dbRows = await tx
    .select()
    .from(qboAccountMapping)
    .where(eq(qboAccountMapping.orgId, orgId))
    .orderBy(qboAccountMapping.lineKind);

  const rows = dbRows.map(toView);
  const map: QboAccountMap = {};
  for (const row of rows) {
    map[row.lineKind] = { qboItemId: row.qboItemId, qboItemName: row.qboItemName };
  }
  return { rows, map };
}

// ─── setQboAccountMapping ───────────────────────────────────────────────────────

const setQboAccountMappingInputSchema = z.object({
  lineKind: z.enum(QBO_LINE_KINDS),
  qboItemId: z.string().trim().min(1, { message: 'qboItemId must not be empty' }),
  qboItemName: z.string().trim().min(1, { message: 'qboItemName must not be empty' }),
});

export type SetQboAccountMappingInput = z.infer<typeof setQboAccountMappingInputSchema>;

export type SetQboAccountMappingResult = { ok: true; mapping: QboAccountMappingView };

async function _setQboAccountMappingImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SetQboAccountMappingResult> {
  requireCapability(session, 'org:manage_settings');

  const parsed = setQboAccountMappingInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[qbo] invalid setQboAccountMapping input: ${first?.message ?? 'unknown'}`);
  }
  const { lineKind, qboItemId, qboItemName } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const now = new Date();
    const [row] = await tx
      .insert(qboAccountMapping)
      .values({
        orgId: sess.orgId,
        lineKind,
        qboItemId,
        qboItemName,
        createdBy: sess.userId,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [qboAccountMapping.orgId, qboAccountMapping.lineKind],
        set: { qboItemId, qboItemName, updatedAt: now },
      })
      .returning();

    if (!row) throw new Error('[qbo] setQboAccountMapping: UPSERT returned no row');

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'qbo.account_mapping_set',
      entityType: 'qbo_account_mapping',
      entityId: row.id,
      metadata: { lineKind, qboItemId, qboItemName },
    });

    return { ok: true, mapping: toView(row) };
  });
}

export async function setQboAccountMapping(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SetQboAccountMappingResult> {
  const db = await getDb();
  return _setQboAccountMappingImpl(db, session, input);
}

export async function setQboAccountMappingWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SetQboAccountMappingResult> {
  return _setQboAccountMappingImpl(db, session, input);
}

// ─── deleteQboAccountMapping ─────────────────────────────────────────────────

const deleteQboAccountMappingInputSchema = z.object({
  lineKind: z.enum(QBO_LINE_KINDS),
});

export type DeleteQboAccountMappingInput = z.infer<typeof deleteQboAccountMappingInputSchema>;

export type DeleteQboAccountMappingResult = { ok: true } | { ok: false; reason: 'not_found' };

async function _deleteQboAccountMappingImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<DeleteQboAccountMappingResult> {
  requireCapability(session, 'org:manage_settings');

  const parsed = deleteQboAccountMappingInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[qbo] invalid deleteQboAccountMapping input: ${first?.message ?? 'unknown'}`);
  }
  const { lineKind } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const deleted = await tx
      .delete(qboAccountMapping)
      .where(and(eq(qboAccountMapping.orgId, sess.orgId), eq(qboAccountMapping.lineKind, lineKind)))
      .returning({ id: qboAccountMapping.id });

    if (!deleted[0]) {
      return { ok: false, reason: 'not_found' } as const;
    }

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'qbo.account_mapping_removed',
      entityType: 'qbo_account_mapping',
      entityId: deleted[0].id,
      metadata: { lineKind },
    });

    return { ok: true } as const;
  });
}

export async function deleteQboAccountMapping(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<DeleteQboAccountMappingResult> {
  const db = await getDb();
  return _deleteQboAccountMappingImpl(db, session, input);
}

export async function deleteQboAccountMappingWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<DeleteQboAccountMappingResult> {
  return _deleteQboAccountMappingImpl(db, session, input);
}
