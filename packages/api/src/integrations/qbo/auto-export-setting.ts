/**
 * integrations/qbo/auto-export-setting.ts — per-org "auto-export finalized
 * invoices to QuickBooks" setting (SYNC layer, migration 0046). Stored as a
 * boolean column on the existing qbo_connection row (reusing the per-org
 * integration row — no new config table). Absent row / absent column → default
 * false (auto-sync OFF).
 *
 * FUNCTIONS:
 *   getQboAutoExport — billing:access → { autoExportInvoices, available }.
 *   setQboAutoExport — org:manage_settings → upsert qbo_connection flag + audit.
 *
 * GRACEFUL ABSENCE: migration 0046 is STAGED, NOT APPLIED to prod. Until a
 * human applies it, `qbo_connection.auto_export_invoices` does not exist.
 *   - getQboAutoExport returns { autoExportInvoices:false, available:false }.
 *   - setQboAutoExport returns { ok:false, reason:'not_available' }.
 *
 * GUARANTEES:
 *   - requireCapability FIRST (read: billing:access, write: org:manage_settings).
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - No-op writes nothing (no audit row, no updated_at bump).
 *   - ONE audit row 'qbo.auto_export_config_changed' { autoExportInvoices,
 *     previous } on a real change. This is a BOOKKEEPING EXPORT toggle — NO
 *     money moves; a QBO invoice is a copy of an existing record.
 *   - The auto-export toggle only has effect once the org is CONNECTED; toggling
 *     it on while disconnected is allowed (it simply arms the behavior for when
 *     a connection is later established) — the export path itself is the gate
 *     (exportInvoiceToQbo returns not_connected when there is no connection).
 *
 * TWO CALLING FORMS per function:
 *   fn(session[, input])       — app code.
 *   fnWithDb(db, session[, in]) — tests.
 */

import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../../auth/session.js';
import { getDb } from '../../db.js';
import type { AppSession } from '../../auth/types.js';
import { ValidationError } from '../../scheduling/internal.js';
import { qboConnectionHasAutoExportColumn, loadQboAutoExportEnabled } from './qbo-sync-internal.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QboAutoExportView {
  /** Whether the org auto-exports finalized invoices to QuickBooks on finalize. */
  autoExportInvoices: boolean;
  /**
   * false when migration 0046 has not been applied yet — the feature cannot be
   * toggled and the setting is forced OFF. The UI renders an "available in an
   * upcoming update" state in that case.
   */
  available: boolean;
}

export type GetQboAutoExportResult = QboAutoExportView;

export type SetQboAutoExportResult =
  | { ok: true; autoExportInvoices: boolean }
  | { ok: false; reason: 'not_available' };

// ─── Input schema ─────────────────────────────────────────────────────────────

const setQboAutoExportInputSchema = z.object({
  autoExportInvoices: z.boolean(),
});

export interface SetQboAutoExportInput {
  autoExportInvoices: boolean;
}

// ─── getQboAutoExport ─────────────────────────────────────────────────────────

async function _getQboAutoExportImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<GetQboAutoExportResult> {
  requireCapability(session, 'billing:access');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const available = await qboConnectionHasAutoExportColumn(tx);
    if (!available) {
      return { autoExportInvoices: false, available: false };
    }
    const autoExportInvoices = await loadQboAutoExportEnabled(tx, sess.orgId);
    return { autoExportInvoices, available: true };
  });
}

export async function getQboAutoExport(
  session: AppSession | null | undefined,
): Promise<GetQboAutoExportResult> {
  const db = await getDb();
  return _getQboAutoExportImpl(db, session);
}

export async function getQboAutoExportWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<GetQboAutoExportResult> {
  return _getQboAutoExportImpl(db, session);
}

// ─── setQboAutoExport ─────────────────────────────────────────────────────────

async function _setQboAutoExportImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SetQboAutoExportResult> {
  requireCapability(session, 'org:manage_settings');

  const parsed = setQboAutoExportInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[qbo] invalid setQboAutoExport input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { autoExportInvoices } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // GRACEFUL ABSENCE: cannot toggle until 0046 is applied.
    if (!(await qboConnectionHasAutoExportColumn(tx))) {
      return { ok: false, reason: 'not_available' } as const;
    }

    const before = await loadQboAutoExportEnabled(tx, sess.orgId);
    if (before === autoExportInvoices) {
      // No-op — write nothing.
      return { ok: true, autoExportInvoices } as const;
    }

    // Upsert qbo_connection. A brand-new row (org never connected) is created
    // with status='disconnected' (the column DEFAULT) + the flag set; ON
    // CONFLICT updates ONLY the flag + updated_at, preserving tokens/realm/status.
    await tx.execute(sql`
      INSERT INTO "qbo_connection" ("org_id", "auto_export_invoices", "created_at", "updated_at")
      VALUES (${sess.orgId}::uuid, ${autoExportInvoices}, NOW(), NOW())
      ON CONFLICT ("org_id") DO UPDATE SET
        "auto_export_invoices" = EXCLUDED."auto_export_invoices",
        "updated_at"           = NOW()
    `);

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'qbo.auto_export_config_changed',
      entityType: 'qbo_connection',
      entityId: sess.orgId,
      metadata: { autoExportInvoices, previous: before },
    });

    return { ok: true, autoExportInvoices } as const;
  });
}

export async function setQboAutoExport(
  session: AppSession | null | undefined,
  input: SetQboAutoExportInput,
): Promise<SetQboAutoExportResult> {
  const db = await getDb();
  return _setQboAutoExportImpl(db, session, input);
}

export async function setQboAutoExportWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<SetQboAutoExportResult> {
  return _setQboAutoExportImpl(db, session, input);
}
