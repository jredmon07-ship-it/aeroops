/**
 * report-squawk.ts — reportSquawk write path.
 * (DISPATCH-3b, ADR-0008 §2.4)
 *
 * GUARANTEES:
 *   - authz first: requireCapability('maintenance:squawk') BEFORE any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - validates input with Zod → ValidationError on malformed data.
 *   - resource must be visible/active/kind='aircraft' in org; else ValidationError.
 *   - optional dispatchTicketId must be visible in-org; else ValidationError.
 *   - INSERT status='open', reported_by=session.userId + audit 'squawk.reported'.
 *   - Does NOT auto-ground even when severity='grounding' ([VERIFY-3b-E]).
 *   - One audit row per successful report; refused writes none.
 *
 * TWO CALLING FORMS:
 *   reportSquawk(session, input)        — app code; uses getDb() internally.
 *   reportSquawkWithDb(db, session, in) — tests; inject pglite client.
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { squawk, auditLog, resource, dispatchTicket } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { SQUAWK_SEVERITIES } from '@aeroops/core';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import type { ReportSquawkResult } from './types.js';
import { toSquawkView } from './internal.js';

// Re-export so existing callers (update-squawk-status.ts, list-squawks.ts) keep working.
export { toSquawkView } from './internal.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Input schema ─────────────────────────────────────────────────────────────

const reportSquawkInputSchema = z.object({
  resourceId:       z.string().regex(UUID_RE, { message: 'resourceId must be a UUID' }),
  title:            z.string().trim().min(1, { message: 'title must not be empty' }),
  description:      z.string().optional(),
  severity:         z.enum(SQUAWK_SEVERITIES),
  dispatchTicketId: z.string().regex(UUID_RE, { message: 'dispatchTicketId must be a UUID' }).optional(),
});

export type ReportSquawkInput = z.infer<typeof reportSquawkInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _reportSquawkImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<ReportSquawkResult> {
  // 1. AUTHZ FIRST — before any data access.
  requireCapability(session, 'maintenance:squawk');

  // 2. VALIDATE — Zod parse.
  const parsed = reportSquawkInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[maintenance] invalid reportSquawk input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { resourceId, title, description, severity, dispatchTicketId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3a. Verify resource visible/active/aircraft.
    const resRows = await tx
      .select({ id: resource.id, kind: resource.kind, active: resource.active })
      .from(resource)
      .where(eq(resource.id, resourceId))
      .limit(1);

    const res = resRows[0];
    if (!res) {
      throw new ValidationError(
        `[maintenance] resource ${resourceId} not found in this org.`,
      );
    }
    if (!res.active) {
      throw new ValidationError(
        `[maintenance] resource ${resourceId} is inactive.`,
      );
    }
    if (res.kind !== 'aircraft') {
      throw new ValidationError(
        `[maintenance] resource ${resourceId} has kind '${res.kind}'; squawks are for aircraft only.`,
      );
    }

    // 3b. Validate optional dispatchTicketId (must be visible in-org via RLS).
    if (dispatchTicketId !== undefined) {
      const dtRows = await tx
        .select({ id: dispatchTicket.id })
        .from(dispatchTicket)
        .where(eq(dispatchTicket.id, dispatchTicketId))
        .limit(1);
      if (!dtRows[0]) {
        throw new ValidationError(
          `[maintenance] dispatch ticket ${dispatchTicketId} not found in this org.`,
        );
      }
    }

    // 3c. INSERT squawk status='open'. Does NOT auto-ground even if severity='grounding'.
    const [inserted] = await tx
      .insert(squawk)
      .values({
        orgId:            sess.orgId,
        resourceId,
        dispatchTicketId: dispatchTicketId ?? null,
        title,
        description:      description ?? null,
        severity,
        status:           'open',
        reportedBy:       sess.userId,
      })
      .returning();

    // 3d. Audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'squawk.reported',
      entityType:  'squawk',
      entityId:    inserted!.id,
      metadata: {
        resourceId,
        title,
        severity,
        dispatchTicketId: dispatchTicketId ?? null,
      },
    });

    return { ok: true, squawk: toSquawkView(inserted!) };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function reportSquawk(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<ReportSquawkResult> {
  const db = await getDb();
  return _reportSquawkImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function reportSquawkWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<ReportSquawkResult> {
  return _reportSquawkImpl(db, session, input);
}
