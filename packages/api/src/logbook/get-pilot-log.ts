/**
 * logbook/get-pilot-log.ts — Staff read of a member's pilot logbook (Slice P2).
 *
 * getPilotLog — full closed-dispatch history for a given org member, newest
 * first, with derived flight time + running total. Cross-org / non-member
 * userId → not_found. A member with zero closed tickets → ok:true with an
 * empty log (empty is NOT not_found).
 *
 * GUARANTEES:
 *   - requireCapability('people:access') FIRST.
 *   - org_id from session only; cross-org userId → not_found (RLS + check).
 *
 * COMPLIANCE HARD LINE: a convenience view of dispatch history — NOT the
 * pilot's official §61.51 logbook of record. See logbook/types.ts.
 *
 * TWO CALLING FORMS:
 *   getPilotLog(session, input)          — app code.
 *   getPilotLogWithDb(db, session, input) — tests.
 */
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { extractRows } from '../db-rows.js';
import { UUID_RE, readPilotLog, buildPilotLog } from './internal.js';
import type { DateBounds } from './internal.js';
import type { PilotLog } from './types.js';

const inputSchema = z
  .object({
    userId: z.string().regex(UUID_RE, { message: 'userId must be a UUID' }),
    from: z.string().datetime().optional(),
    to:   z.string().datetime().optional(),
  })
  .refine((d) => !(d.from && d.to) || d.from <= d.to, {
    message: 'from must be <= to',
  });

export interface GetPilotLogInput {
  userId: string;
  from?: string;
  to?: string;
}

export type GetPilotLogResult =
  | { ok: true; log: PilotLog }
  | { ok: false; reason: 'not_found' };

async function memberExists(tx: AnyDb, userId: string): Promise<boolean> {
  const result = await tx.execute(sql`
    SELECT 1 AS present FROM membership WHERE user_id = ${userId}::uuid LIMIT 1
  `);
  return extractRows<{ present: number }>(result).length > 0;
}

async function _getPilotLogImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<GetPilotLogResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'people:access');

  // 2. VALIDATE input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[logbook] invalid getPilotLog input: ${first?.message ?? 'unknown'}`);
  }
  const { userId, from, to } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // 3. Resolve membership in-org FIRST (RLS scopes to org). Not visible → not_found.
    if (!(await memberExists(tx, userId))) {
      return { ok: false, reason: 'not_found' };
    }

    const bounds: DateBounds = { from, to };
    const rowsDesc = await readPilotLog(tx, userId, bounds);
    return { ok: true, log: buildPilotLog(rowsDesc) };
  });
}

export async function getPilotLog(
  session: AppSession | null | undefined,
  input: GetPilotLogInput,
): Promise<GetPilotLogResult> {
  const db = await getDb();
  return _getPilotLogImpl(db, session, input);
}

export async function getPilotLogWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: GetPilotLogInput,
): Promise<GetPilotLogResult> {
  return _getPilotLogImpl(db, session, input);
}
