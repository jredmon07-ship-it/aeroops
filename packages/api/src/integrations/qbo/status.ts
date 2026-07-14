/**
 * integrations/qbo/status.ts — getQboStatus (Slice QB1).
 *
 * Read-only status surface for the settings card: connection state, the
 * last 20 export-log rows, the current per-kind account mapping, and
 * whether the QBO provider is configured at all on this deployment
 * (env-only check — no I/O).
 *
 * GUARANTEES:
 *   - requireCapability(session, 'billing:access') FIRST.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - NEVER returns access_token/refresh_token — connection view is
 *     status/realm/expiry only.
 */

import { desc, eq } from 'drizzle-orm';
import { qboConnection, qboExportLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../../auth/session.js';
import { getDb } from '../../db.js';
import type { AppSession } from '../../auth/types.js';
import { loadQboAccountMap } from './account-mapping.js';
import type { QboAccountMappingView } from './account-mapping.js';

const EXPORT_LOG_LIMIT = 20;

// ─── View types ───────────────────────────────────────────────────────────────

export type QboConnectionStatus = 'connected' | 'disconnected' | 'error';

export interface QboConnectionView {
  status: QboConnectionStatus;
  realmId: string | null;
  accessTokenExpiresAt: Date | null;
  updatedAt: Date;
}

export interface QboExportLogView {
  id: string;
  entityType: 'invoice' | 'customer' | 'payment';
  entityId: string;
  qboId: string | null;
  status: 'pending' | 'exported' | 'error';
  errorDetail: string | null;
  exportedAt: Date | null;
  createdAt: Date;
}

export interface GetQboStatusResult {
  /** true when QBO_CLIENT_ID + QBO_CLIENT_SECRET are both set on this deployment. */
  providerConfigured: boolean;
  connection: QboConnectionView | null;
  recentExports: QboExportLogView[];
  accountMapping: QboAccountMappingView[];
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

function toConnectionView(row: typeof qboConnection.$inferSelect): QboConnectionView {
  return {
    status: row.status as QboConnectionStatus,
    realmId: row.realmId ?? null,
    accessTokenExpiresAt: row.accessTokenExpiresAt ? toDate(row.accessTokenExpiresAt) : null,
    updatedAt: toDate(row.updatedAt),
  };
}

function toExportLogView(row: typeof qboExportLog.$inferSelect): QboExportLogView {
  return {
    id: row.id,
    entityType: row.entityType as 'invoice' | 'customer' | 'payment',
    entityId: row.entityId,
    qboId: row.qboId ?? null,
    status: row.status as 'pending' | 'exported' | 'error',
    errorDetail: row.errorDetail ?? null,
    exportedAt: row.exportedAt ? toDate(row.exportedAt) : null,
    createdAt: toDate(row.createdAt),
  };
}

/** isQboProviderConfigured — pure env check, no I/O. Internal to getQboStatus. */
function isQboProviderConfigured(): boolean {
  return Boolean(process.env['QBO_CLIENT_ID'] && process.env['QBO_CLIENT_SECRET']);
}

// ─── getQboStatus ───────────────────────────────────────────────────────────────

async function _getQboStatusImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<GetQboStatusResult> {
  requireCapability(session, 'billing:access');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const connectionRows = await tx
      .select()
      .from(qboConnection)
      .where(eq(qboConnection.orgId, sess.orgId))
      .limit(1);

    const exportRows = await tx
      .select()
      .from(qboExportLog)
      .where(eq(qboExportLog.orgId, sess.orgId))
      .orderBy(desc(qboExportLog.createdAt))
      .limit(EXPORT_LOG_LIMIT);

    const { rows: accountMapping } = await loadQboAccountMap(tx, sess.orgId);

    return {
      providerConfigured: isQboProviderConfigured(),
      connection: connectionRows[0] ? toConnectionView(connectionRows[0]) : null,
      recentExports: exportRows.map(toExportLogView),
      accountMapping,
    };
  });
}

export async function getQboStatus(
  session: AppSession | null | undefined,
): Promise<GetQboStatusResult> {
  const db = await getDb();
  return _getQboStatusImpl(db, session);
}

export async function getQboStatusWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<GetQboStatusResult> {
  return _getQboStatusImpl(db, session);
}
