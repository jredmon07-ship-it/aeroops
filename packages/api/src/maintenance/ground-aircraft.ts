/**
 * ground-aircraft.ts — groundAircraft / unGroundAircraft write paths.
 * (DISPATCH-3b, ADR-0008 §2.2)
 *
 * GUARANTEES:
 *   - authz first: requireCapability('maintenance:ground') BEFORE any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - validates input with Zod → ValidationError on malformed data.
 *   - resource must be visible/active/kind='aircraft' in org; else ValidationError.
 *   - optional squawkId / dispatchTicketId must be visible in-org; else ValidationError.
 *   - IDEMPOTENT: re-ground already-grounded → {ok:true, alreadyGrounded:true},
 *     no new row, no audit. re-release already-released/never-grounded →
 *     {ok:true, alreadyReleased:true}, no new row, no audit.
 *   - Else INSERT new event + one audit row (grounding.grounded / grounding.released).
 *   - loadGroundingProbe is used for current-state check.
 *
 * TWO CALLING FORMS:
 *   groundAircraft(session, input)        — app code; uses getDb() internally.
 *   groundAircraftWithDb(db, session, in) — tests; inject pglite client.
 *   (same for unGroundAircraft / unGroundAircraftWithDb)
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { aircraftGrounding, auditLog, resource, squawk, dispatchTicket } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { loadGroundingProbe, applyUngroundOnTx } from './internal.js';
import type { GroundAircraftResult, UnGroundResult, GroundingEventView } from './types.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Input schemas ─────────────────────────────────────────────────────────────

const groundAircraftInputSchema = z.object({
  resourceId:        z.string().regex(UUID_RE, { message: 'resourceId must be a UUID' }),
  reason:            z.string().min(1, { message: 'reason must not be empty' }),
  squawkId:          z.string().regex(UUID_RE, { message: 'squawkId must be a UUID' }).optional(),
  dispatchTicketId:  z.string().regex(UUID_RE, { message: 'dispatchTicketId must be a UUID' }).optional(),
});

export type GroundAircraftInput = z.infer<typeof groundAircraftInputSchema>;

const unGroundAircraftInputSchema = z.object({
  resourceId: z.string().regex(UUID_RE, { message: 'resourceId must be a UUID' }),
  reason:     z.string().optional(),
});

export type UnGroundAircraftInput = z.infer<typeof unGroundAircraftInputSchema>;

// ─── toGroundingEventView mapper ──────────────────────────────────────────────

function toGroundingEventView(row: {
  id: string;
  resourceId: string;
  state: string;
  reason: string;
  squawkId: string | null;
  dispatchTicketId: string | null;
  createdBy: string;
  createdAt: Date | string;
}): GroundingEventView {
  return {
    id: row.id,
    resourceId: row.resourceId,
    state: row.state as GroundingEventView['state'],
    reason: row.reason,
    squawkId: row.squawkId,
    dispatchTicketId: row.dispatchTicketId,
    createdBy: row.createdBy,
    createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
  };
}

// ─── Shared groundAircraft implementation ─────────────────────────────────────

async function _groundAircraftImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<GroundAircraftResult> {
  // 1. AUTHZ FIRST — before any data access.
  requireCapability(session, 'maintenance:ground');

  // 2. VALIDATE — Zod parse.
  const parsed = groundAircraftInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[maintenance] invalid groundAircraft input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { resourceId, reason, squawkId, dispatchTicketId } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3a. Verify resource is visible, active, and kind='aircraft'.
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
        `[maintenance] resource ${resourceId} has kind '${res.kind}'; only 'aircraft' can be grounded.`,
      );
    }

    // 3b. Validate optional squawkId (must be visible in-org via RLS).
    if (squawkId !== undefined) {
      const sqRows = await tx
        .select({ id: squawk.id })
        .from(squawk)
        .where(eq(squawk.id, squawkId))
        .limit(1);
      if (!sqRows[0]) {
        throw new ValidationError(
          `[maintenance] squawk ${squawkId} not found in this org.`,
        );
      }
    }

    // 3c. Validate optional dispatchTicketId (must be visible in-org via RLS).
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

    // 3d. Load current grounding state via probe.
    const probe = await loadGroundingProbe(tx, [resourceId]);
    const current = probe.get(resourceId)!;

    // 3e. Idempotent: already grounded → return without write/audit.
    if (current.grounded) {
      // Re-use the existing event data from the probe to build a view.
      // We need to reload the actual event row for a complete GroundingEventView.
      const existingRows = await tx
        .select({
          id: aircraftGrounding.id,
          resourceId: aircraftGrounding.resourceId,
          state: aircraftGrounding.state,
          reason: aircraftGrounding.reason,
          squawkId: aircraftGrounding.squawkId,
          dispatchTicketId: aircraftGrounding.dispatchTicketId,
          createdBy: aircraftGrounding.createdBy,
          createdAt: aircraftGrounding.createdAt,
        })
        .from(aircraftGrounding)
        .where(eq(aircraftGrounding.id, current.eventId!))
        .limit(1);

      const existingRow = existingRows[0]!;
      return {
        ok: true,
        alreadyGrounded: true,
        grounding: toGroundingEventView(existingRow),
      };
    }

    // 3f. INSERT new 'grounded' event.
    const [inserted] = await tx
      .insert(aircraftGrounding)
      .values({
        orgId:           sess.orgId,
        resourceId,
        state:           'grounded',
        reason,
        squawkId:        squawkId ?? null,
        dispatchTicketId: dispatchTicketId ?? null,
        createdBy:       sess.userId,
      })
      .returning();

    // 3g. Audit row.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'grounding.grounded',
      entityType:  'aircraft_grounding',
      entityId:    inserted!.id,
      metadata: {
        resourceId,
        reason,
        squawkId:        squawkId ?? null,
        dispatchTicketId: dispatchTicketId ?? null,
      },
    });

    return {
      ok: true,
      alreadyGrounded: false,
      grounding: toGroundingEventView(inserted!),
    };
  });
}

// ─── Shared unGroundAircraft implementation ────────────────────────────────────

async function _unGroundAircraftImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<UnGroundResult> {
  // 1. AUTHZ FIRST — before any data access.
  requireCapability(session, 'maintenance:ground');

  // 2. VALIDATE — Zod parse.
  const parsed = unGroundAircraftInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[maintenance] invalid unGroundAircraft input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { resourceId, reason } = parsed.data;

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
        `[maintenance] resource ${resourceId} has kind '${res.kind}'; only 'aircraft' can be released.`,
      );
    }

    // 3b. Delegate to applyUngroundOnTx (inner-core helper).
    //    It loads the current grounding state, inserts the 'released' event
    //    (if grounded), and writes the audit row. Same behaviour as before.
    const inner = await applyUngroundOnTx(sess, tx, { resourceId, reason });

    if (inner.alreadyReleased) {
      return { ok: true, alreadyReleased: true, grounding: null };
    }

    return {
      ok: true,
      alreadyReleased: false,
      grounding: toGroundingEventView(inner.groundingRow!),
    };
  });
}

// ─── App-code forms ───────────────────────────────────────────────────────────

export async function groundAircraft(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GroundAircraftResult> {
  const db = await getDb();
  return _groundAircraftImpl(db, session, input);
}

export async function unGroundAircraft(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<UnGroundResult> {
  const db = await getDb();
  return _unGroundAircraftImpl(db, session, input);
}

// ─── Test/injectable forms ────────────────────────────────────────────────────

export async function groundAircraftWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<GroundAircraftResult> {
  return _groundAircraftImpl(db, session, input);
}

export async function unGroundAircraftWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
): Promise<UnGroundResult> {
  return _unGroundAircraftImpl(db, session, input);
}
