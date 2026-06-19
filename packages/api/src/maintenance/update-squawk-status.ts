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
import { eq, and, sql } from 'drizzle-orm';
import { squawk, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { toSquawkView } from './report-squawk.js';
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
    // 3. Guarded UPDATE: WHERE id=$ AND status='open'.
    //    Sets status, resolution_notes, resolved_by, resolved_at, updated_at.
    //    RLS (org_id GUC) scopes the update to the session org automatically.
    const updated = await tx
      .update(squawk)
      .set({
        status,
        resolutionNotes: resolutionNotes ?? null,
        resolvedBy:      sess.userId,
        resolvedAt:      sql`NOW()`,
        updatedAt:       sql`NOW()`,
      })
      .where(
        and(
          eq(squawk.id, squawkId),
          eq(squawk.status, 'open'),
        ),
      )
      .returning();

    // 4. 0 rows updated → probe for not_found vs not_open.
    if (updated.length === 0) {
      // Probe whether the squawk is visible in-org (status not checked → any status).
      const probe = await tx
        .select({ id: squawk.id, status: squawk.status })
        .from(squawk)
        .where(eq(squawk.id, squawkId))
        .limit(1);

      if (!probe[0]) {
        // Not visible in this org (RLS-blocked or does not exist).
        return { ok: false, reason: 'not_found' } as const;
      }
      // Visible but not open (resolved/deferred, or concurrent write).
      return { ok: false, reason: 'not_open' } as const;
    }

    const row = updated[0]!;

    // 5. Audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'squawk.status_changed',
      entityType:  'squawk',
      entityId:    row.id,
      metadata: {
        squawkId,
        newStatus:       status,
        resolutionNotes: resolutionNotes ?? null,
      },
    });

    return { ok: true, squawk: toSquawkView(row) };
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
