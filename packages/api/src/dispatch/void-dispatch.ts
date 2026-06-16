/**
 * void-dispatch.ts — the single sanctioned VOID write path.
 * (DISPATCH-3a, ADR-0007 §1,6)
 *
 * VOID escapes a mistaken check-out: open → voided (audited tombstone).
 * The voided ticket keeps its meters (immutable) but is excluded from the
 * one-open partial-UNIQUE index (WHERE status='open'), so the aircraft is
 * immediately free for a new dispatch.
 *
 * GUARANTEES:
 *   - authz first: requireCapability('dispatch:create').
 *   - validates input with Zod → ValidationError on bad UUID/reason.
 *   - ticket not visible in org → not_found.
 *   - ticket status !== 'open' → not_open (returned).
 *   - UPDATE WHERE id=$id AND status='open' (concurrent race guard).
 *   - writes audit 'dispatch.voided' with metadata {reason}.
 *   - NO meter mutation — status only (ADR-0007 invariant 1).
 *
 * TWO CALLING FORMS:
 *   voidDispatch(session, input)          — app code.
 *   voidDispatchWithDb(db, session, in)   — tests.
 */
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { dispatchTicket, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type { VoidDispatchResult } from './types.js';

// ─── Input schema ─────────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const voidDispatchInputSchema = z.object({
  ticketId: z.string().regex(UUID_RE, { message: 'ticketId must be a UUID' }),
  reason:   z.string().min(1, { message: 'reason must be a non-empty string' }),
});

export type VoidDispatchInput = z.infer<typeof voidDispatchInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _voidDispatchImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<VoidDispatchResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'dispatch:create');

  // 2. VALIDATE input.
  const parsed = voidDispatchInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[dispatch] invalid voidDispatch input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { ticketId, reason } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Load ticket — RLS scopes to org; not visible → not_found.
    const rows = await tx
      .select({ id: dispatchTicket.id, status: dispatchTicket.status })
      .from(dispatchTicket)
      .where(eq(dispatchTicket.id, ticketId))
      .limit(1);

    const row = rows[0];
    if (!row) {
      return { ok: false, reason: 'not_found' } as const;
    }

    // 4. Status check.
    if (row.status !== 'open') {
      return { ok: false, reason: 'not_open' } as const;
    }

    // 5. UPDATE WHERE id=$id AND status='open' (race guard).
    // Only status and updated_at change — meters are NOT touched (ADR-0007 §1).
    const updated = await tx
      .update(dispatchTicket)
      .set({
        status:    'voided',
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(dispatchTicket.id, ticketId),
          eq(dispatchTicket.status, 'open'),
        ),
      )
      .returning({ id: dispatchTicket.id });

    // 0 rows = lost the race.
    if (!updated[0]) {
      return { ok: false, reason: 'not_open' } as const;
    }

    // 6. Audit — exactly one per void (ADR-0007 invariant 2).
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'dispatch.voided',
      entityType:  'dispatch_ticket',
      entityId:    ticketId,
      metadata:    { reason },
    });

    return { ok: true };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * voidDispatch — void an open dispatch ticket (OPEN → VOIDED).
 *
 * @param session - AppSession from auth(); null/undefined → UnauthenticatedError.
 * @param input   - { ticketId, reason }.
 * @returns VoidDispatchResult — ok:true (aircraft freed), or ok:false
 *          reason:'not_found'|'not_open'.
 * @throws  UnauthenticatedError | ForbiddenError | ValidationError.
 */
export async function voidDispatch(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<VoidDispatchResult> {
  const db = await getDb();
  return _voidDispatchImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/** voidDispatchWithDb — test form; inject a pglite client. */
export async function voidDispatchWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<VoidDispatchResult> {
  return _voidDispatchImpl(db, session, input);
}
