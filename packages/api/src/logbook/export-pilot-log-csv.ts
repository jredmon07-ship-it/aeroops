/**
 * logbook/export-pilot-log-csv.ts — Staff CSV export of a member's pilot
 * logbook (Slice P2). Same staff-scoping as getPilotLog (cross-org/non-member
 * → not_found); additionally writes ONE audit row per export.
 *
 * TWO CALLING FORMS:
 *   exportPilotLogCsv(session, input)          — app code.
 *   exportPilotLogCsvWithDb(db, session, input) — tests.
 */
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { serializeCsv } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { extractRows } from '../db-rows.js';
import {
  UUID_RE,
  readPilotLog,
  buildPilotLog,
  pilotLogToCsvRows,
  pilotLogCsvFilename,
} from './internal.js';
import type { DateBounds } from './internal.js';
import type { PilotLogCsvResult } from './types.js';

const inputSchema = z
  .object({
    userId: z.string().regex(UUID_RE, { message: 'userId must be a UUID' }),
    from: z.string().datetime().optional(),
    to:   z.string().datetime().optional(),
  })
  .refine((d) => !(d.from && d.to) || d.from <= d.to, {
    message: 'from must be <= to',
  });

export interface ExportPilotLogCsvInput {
  userId: string;
  from?: string;
  to?: string;
}

export type ExportPilotLogCsvResult =
  | ({ ok: true } & PilotLogCsvResult)
  | { ok: false; reason: 'not_found' };

async function memberExists(tx: AnyDb, userId: string): Promise<boolean> {
  const result = await tx.execute(sql`
    SELECT 1 AS present FROM membership WHERE user_id = ${userId}::uuid LIMIT 1
  `);
  return extractRows<{ present: number }>(result).length > 0;
}

async function _exportPilotLogCsvImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<ExportPilotLogCsvResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'people:access');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[logbook] invalid exportPilotLogCsv input: ${first?.message ?? 'unknown'}`);
  }
  const { userId, from, to } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Resolve membership in-org FIRST. Not visible → not_found.
    if (!(await memberExists(tx, userId))) {
      return { ok: false, reason: 'not_found' };
    }

    const bounds: DateBounds = { from, to };
    const rowsDesc = await readPilotLog(tx, userId, bounds);
    const log = buildPilotLog(rowsDesc);
    const csv = serializeCsv(pilotLogToCsvRows(log));

    // Audit row — the only write in this slice. No PII beyond ids/dates.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'pilot_log.exported',
      entityType: 'app_user',
      entityId: userId,
      metadata: {
        entryCount: log.entries.length,
        from: bounds.from ?? null,
        to: bounds.to ?? null,
        self: false,
      },
    });

    return { ok: true, filename: pilotLogCsvFilename(), csv };
  });
}

export async function exportPilotLogCsv(
  session: AppSession | null | undefined,
  input: ExportPilotLogCsvInput,
): Promise<ExportPilotLogCsvResult> {
  const db = await getDb();
  return _exportPilotLogCsvImpl(db, session, input);
}

export async function exportPilotLogCsvWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: ExportPilotLogCsvInput,
): Promise<ExportPilotLogCsvResult> {
  return _exportPilotLogCsvImpl(db, session, input);
}
