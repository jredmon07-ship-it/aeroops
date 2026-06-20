/**
 * update-squawk-status.ts — updateSquawkStatus write path.
 * (DISPATCH-3b, ADR-0008 §2.4)
 *
 * GUARANTEES:
 *   - authz first: requireCapability('maintenance:squawk') BEFORE any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - validates input with Zod → ValidationError on malformed data.
 *   - Only open→resolved / open→deferred transitions valid; guarded
 *     UPDATE WHERE id=$ AND status='open'. 0 rows → probe for not_found vs not_open.
 *   - not visible in org → not_found (returned, not thrown).
 *   - exists but not open (already resolved/deferred or concurrent race) → not_open.
 *   - audit 'squawk.status_changed' on success.
 *   - No reopen path ([VERIFY-3b-D]).
 *   - One audit row per successful transition; refused writes none.
 *
 * TWO CALLING FORMS:
 *   updateSquawkStatus(session, input)        — app code; uses getDb() internally.
 *   updateSquawkStatusWithDb(db, session, in) — tests; inject pglite client.
 */
import { z } from 'zod';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { applySquawkStatusOnTx } from './internal.js';
import type { UpdateSquawkStatusResult } from './types.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Input schema ─────────────────────────────────────────────────────────────

const updateSquawkStatusInputSchema = z.object({
  squawkId:        z.string().regex(UUID_RE, { message: 'squawkId must be a UUID' }),
  status:          z.enum(['resolved', 'deferred']),
  resolutionNotes: z.string().optional(),
});

export type UpdateSquawkStatusInput = z.infer<typeof updateSquawkStatusInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _updateSquawkStatusImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<UpdateSquawkStatusResult> {
  // 1. AUTHZ FIRST — before any data access.
  requireCapability(session, 'maintenance:squawk');

  // 2. VALIDATE — Zod parse.
  const parsed = updateSquawkStatusInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[maintenance] invalid updateSquawkStatus input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { squawkId, status, resolutionNotes } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Delegate to applySquawkStatusOnTx (inner-core helper).
    //    It performs the guarded UPDATE + audit row; same behaviour as before.
    const result = await applySquawkStatusOnTx(sess, tx, { squawkId, status, resolutionNotes });
    if (!result.ok) {
      return { ok: false, reason: result.reason } as const;
    }
    return { ok: true, squawk: result.squawkRow };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function updateSquawkStatus(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<UpdateSquawkStatusResult> {
  const db = await getDb();
  return _updateSquawkStatusImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function updateSquawkStatusWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<UpdateSquawkStatusResult> {
  return _updateSquawkStatusImpl(db, session, input);
}
