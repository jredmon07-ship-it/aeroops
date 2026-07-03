/**
 * logbook/export-my-pilot-log-csv.ts — Portal self-scoped CSV export
 * (Slice P2). Same self-scoping as getMyPilotLog; additionally writes ONE
 * audit row per export (records integrity for a data-egress event).
 *
 * TWO CALLING FORMS:
 *   exportMyPilotLogCsv(session, input?)          — app code.
 *   exportMyPilotLogCsvWithDb(db, session, input?) — tests.
 */
import { auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { serializeCsv } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import {
  dateBoundsSchema,
  readPilotLog,
  buildPilotLog,
  pilotLogToCsvRows,
  pilotLogCsvFilename,
} from './internal.js';
import type { PilotLogCsvResult } from './types.js';

export interface ExportMyPilotLogCsvInput {
  from?: string;
  to?: string;
}

async function _exportMyPilotLogCsvImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<PilotLogCsvResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'portal:access');

  // 2. VALIDATE input.
  const parsed = dateBoundsSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[logbook] invalid exportMyPilotLogCsv input: ${first?.message ?? 'unknown'}`);
  }
  const bounds = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // SELF-SCOPED: sess.userId only — never a caller-supplied id.
    const rowsDesc = await readPilotLog(tx, sess.userId, bounds);
    const log = buildPilotLog(rowsDesc);
    const csv = serializeCsv(pilotLogToCsvRows(log));

    // Audit row — the only write in this slice. No PII beyond ids/dates.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'pilot_log.exported',
      entityType: 'app_user',
      entityId: sess.userId,
      metadata: {
        entryCount: log.entries.length,
        from: bounds.from ?? null,
        to: bounds.to ?? null,
        self: true,
      },
    });

    return { filename: pilotLogCsvFilename(), csv };
  });
}

export async function exportMyPilotLogCsv(
  session: AppSession | null | undefined,
  input?: ExportMyPilotLogCsvInput,
): Promise<PilotLogCsvResult> {
  const db = await getDb();
  return _exportMyPilotLogCsvImpl(db, session, input);
}

export async function exportMyPilotLogCsvWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input?: ExportMyPilotLogCsvInput,
): Promise<PilotLogCsvResult> {
  return _exportMyPilotLogCsvImpl(db, session, input);
}
