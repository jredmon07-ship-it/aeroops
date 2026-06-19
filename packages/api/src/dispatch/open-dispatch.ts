/**
 * open-dispatch.ts — the single sanctioned CHECK-OUT (OPEN) write path.
 * (DISPATCH-3a-1, ADR-0007 §1,2,6)
 *
 * GUARANTEES:
 *   - authz first: requireCapability('dispatch:create') BEFORE any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - validates input with Zod → ValidationError on malformed data.
 *   - reservation must be visible in org AND status='booked'; else not_found.
 *   - resourceId must be among the reservation's reservation_resource rows
 *     AND be an active aircraft resource; else ValidationError.
 *   - pilot must be an org member (pre-check + composite FK backstop).
 *   - INSERT ticket status='open' + audit 'dispatch.opened'.
 *   - 23505 (one-open partial-UNIQUE) caught via isUniqueViolation, re-queries
 *     the existing open ticket in a FRESH withOrgContext (tx is poisoned after
 *     the 23505) → {ok:false,reason:'already_open',openTicketId}.
 *   - One audit row per successful open; refused writes none.
 *
 * RACE HANDLING (ADR-0007 §2 / mirrors ADR-0004 catch-and-requery):
 *   When the INSERT raises 23505 (partial-UNIQUE backstop), the tx is poisoned
 *   and the catch block is inside the withSessionOrgContextWithDb callback.
 *   We throw an internal DispatchAlreadyOpenError to the outer caller level,
 *   where `db` is still available, and re-query the open ticket in a FRESH
 *   withOrgContext transaction (same pattern as reProbeInFreshTx in scheduling).
 *
 * TWO CALLING FORMS:
 *   openDispatch(session, input)        — app code; uses getDb() internally.
 *   openDispatchWithDb(db, session, in) — tests; inject pglite client.
 */
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import {
  dispatchTicket,
  reservation,
  reservationResource,
  resource,
  membership,
  auditLog,
} from '@aeroops/db';
import { withOrgContext } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { isUniqueViolation, toDispatchTicketView } from './internal.js';
import { loadGroundingProbe } from '../maintenance/internal.js';
import { evaluateEligibilityGate, stubBalanceSeam } from '@aeroops/core';
import type { BalanceSeam } from '@aeroops/core';
import { loadRequiredTags, loadPilotTags, loadDispatchConfig } from '../dispatch-gate/internal.js';
import type { OpenDispatchResult } from './types.js';

// ─── UUID validation ──────────────────────────────────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Internal race signal ─────────────────────────────────────────────────────

/**
 * DispatchAlreadyOpenError — thrown from inside withSessionOrgContextWithDb
 * when a 23505 fires on the partial-UNIQUE backstop.
 *
 * The tx is poisoned after the 23505; we cannot re-query the open ticket on
 * it. We throw this error to the outer caller (where `db` is available) so it
 * can re-query in a FRESH withOrgContext transaction.
 *
 * Carries the resourceId needed for the re-query.
 */
class DispatchAlreadyOpenError extends Error {
  readonly code = 'DISPATCH_ALREADY_OPEN' as const;
  constructor(
    public readonly resourceId: string,
    public readonly orgId: string,
    cause?: unknown,
  ) {
    super('[dispatch] 23505 partial-UNIQUE: aircraft already has an open ticket');
    this.name = 'DispatchAlreadyOpenError';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

// ─── Input schema ─────────────────────────────────────────────────────────────

const meterSchema = z
  .number({ message: 'Meter reading must be a number' })
  .finite({ message: 'Meter reading must be finite' })
  .min(0, { message: 'Meter reading must be >= 0' })
  .refine(
    (v) => Math.round(v * 10) === v * 10,
    { message: 'Meter reading must have at most 1 decimal place' },
  );

const openDispatchInputSchema = z.object({
  reservationId: z.string().regex(UUID_RE, { message: 'reservationId must be a UUID' }),
  resourceId:    z.string().regex(UUID_RE, { message: 'resourceId must be a UUID' }),
  pilotUserId:   z.string().regex(UUID_RE, { message: 'pilotUserId must be a UUID' }),
  hobbsOut:      meterSchema,
  tachOut:       meterSchema,
  notes:         z.string().optional(),
});

export type OpenDispatchInput = z.infer<typeof openDispatchInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _openDispatchImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
  balanceSeam: BalanceSeam = stubBalanceSeam,
): Promise<OpenDispatchResult> {
  // 1. AUTHZ FIRST — before any data access.
  requireCapability(session, 'dispatch:create');

  // 2. VALIDATE — Zod parse.
  const parsed = openDispatchInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[dispatch] invalid openDispatch input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { reservationId, resourceId, pilotUserId, hobbsOut, tachOut, notes } = parsed.data;

  // 3. Transaction inside withSessionOrgContextWithDb (sets org GUC → RLS).
  //    If INSERT raises 23505, we throw DispatchAlreadyOpenError out of the tx
  //    (poisoned tx is rolled back) and re-query in a fresh context below.
  try {
    return await withSessionOrgContextWithDb(db, session, async (sess, tx) => {
      // 3a. Load reservation — RLS scopes to org; not visible OR not booked → not_found.
      const resvRows = await tx
        .select({ id: reservation.id, status: reservation.status })
        .from(reservation)
        .where(eq(reservation.id, reservationId))
        .limit(1);

      const resv = resvRows[0];
      if (!resv || resv.status !== 'booked') {
        return { ok: false, reason: 'not_found' } as const;
      }

      // 3b. Verify resourceId is among this reservation's reservation_resource rows.
      const rrRows = await tx
        .select({ resourceId: reservationResource.resourceId })
        .from(reservationResource)
        .where(
          and(
            eq(reservationResource.reservationId, reservationId),
            eq(reservationResource.resourceId, resourceId),
            eq(reservationResource.status, 'booked'),
          ),
        )
        .limit(1);

      if (!rrRows[0]) {
        throw new ValidationError(
          `[dispatch] resource ${resourceId} is not assigned to reservation ${reservationId}.`,
        );
      }

      // 3c. Verify active aircraft kind.
      const resRows = await tx
        .select({ id: resource.id, kind: resource.kind, active: resource.active })
        .from(resource)
        .where(eq(resource.id, resourceId))
        .limit(1);

      const res = resRows[0];
      if (!res) {
        throw new ValidationError(
          `[dispatch] resource ${resourceId} not found in this org.`,
        );
      }
      if (!res.active) {
        throw new ValidationError(
          `[dispatch] resource ${resourceId} is inactive and cannot be dispatched.`,
        );
      }
      if (res.kind !== 'aircraft') {
        throw new ValidationError(
          `[dispatch] resource ${resourceId} has kind '${res.kind}'; only 'aircraft' can be dispatched.`,
        );
      }

      // 3d. Grounding block — check current grounding state BEFORE INSERT.
      //     If the aircraft is grounded, RETURN the 'grounded' refusal arm.
      //     No write/audit occurs for a grounded block. ([VERIFY-3b-H])
      const groundingProbe = await loadGroundingProbe(tx, [resourceId]);
      const groundingState = groundingProbe.get(resourceId)!;
      if (groundingState.grounded) {
        return {
          ok: false,
          reason: 'grounded',
          grounding: { resourceId, reason: groundingState.reason },
        } as const;
      }

      // 3e. Verify pilot is an org member.
      const memberRows = await tx
        .select({ userId: membership.userId })
        .from(membership)
        .where(
          and(
            eq(membership.userId, pilotUserId),
            eq(membership.orgId, sess.orgId),
          ),
        )
        .limit(1);

      if (!memberRows[0]) {
        throw new ValidationError(
          `[dispatch] pilot user ${pilotUserId} is not a member of this org.`,
        );
      }

      // 3g. Eligibility gate — AFTER pilot-membership, BEFORE INSERT.
      //     Load requiredTags for this aircraft. If empty → skip (no gate, no
      //     pilot-tag query). [VERIFY-3c-A] tags are FREE-TEXT opaque labels.
      //
      //     Load config once; used by both eligibility and balance gates.
      const requiredTags = await loadRequiredTags(tx, resourceId);
      const gateCfg      = await loadDispatchConfig(tx, sess.orgId);
      let eligibilityWarnings: string[] | undefined;
      if (requiredTags.length > 0) {
        const pilotTags = await loadPilotTags(tx, pilotUserId);
        const gate = evaluateEligibilityGate(requiredTags, pilotTags, gateCfg.eligibilityMode);
        if (gate.blocked) {
          // block mode + missing tags → refuse dispatch; NO write/audit.
          return {
            ok: false,
            reason: 'ineligible',
            missingTags: gate.missingTags,
          } as const;
        }
        if (gate.warnings.length > 0) {
          // warn mode + missing tags → proceed but carry warnings onto ok:true.
          eligibilityWarnings = gate.warnings;
        }
      }

      // 3h. Balance gate — AFTER eligibility, BEFORE INSERT.
      //     [VERIFY-3c-MONEY]: stubBalanceSeam ALWAYS returns {ok:true} in Phase 1.
      //     Only a test-injected fake seam can trigger balance_block.
      if (gateCfg.balanceCheckEnabled) {
        const balanceResult = await balanceSeam.check({
          orgId: sess.orgId,
          pilotUserId,
        });
        if (!balanceResult.ok) {
          // Balance refused — NO write/audit.
          return { ok: false, reason: 'balance_block' } as const;
        }
      }

      // 3f. INSERT ticket + audit. On 23505, throw DispatchAlreadyOpenError
      //     to the outer try/catch so the re-query runs in a fresh tx.
      try {
        const [ticket] = await tx
          .insert(dispatchTicket)
          .values({
            orgId:        sess.orgId,
            reservationId,
            resourceId,
            pilotUserId,
            status:       'open',
            hobbsOut:     hobbsOut.toFixed(1),
            tachOut:      tachOut.toFixed(1),
            notes:        notes ?? null,
            openedBy:     sess.userId,
          })
          .returning();

        await tx.insert(auditLog).values({
          orgId:       sess.orgId,
          actorUserId: sess.userId,
          action:      'dispatch.opened',
          entityType:  'dispatch_ticket',
          entityId:    ticket!.id,
          metadata: {
            reservationId,
            resourceId,
            pilotUserId,
            hobbsOut,
            tachOut,
          },
        });

        return {
          ok: true,
          ticket: toDispatchTicketView(ticket!),
          ...(eligibilityWarnings !== undefined ? { eligibilityWarnings } : {}),
        };
      } catch (insertErr) {
        if (isUniqueViolation(insertErr)) {
          // The tx is now poisoned. Throw a signal to the outer level where
          // `db` is available for a fresh re-query.
          throw new DispatchAlreadyOpenError(resourceId, sess.orgId, insertErr);
        }
        throw insertErr;
      }
    });
  } catch (outerErr) {
    // Re-query the open ticket in a FRESH withOrgContext (poisoned tx is gone).
    if (outerErr instanceof DispatchAlreadyOpenError) {
      const { resourceId: rId, orgId } = outerErr;
      const existing = await withOrgContext(db, orgId, (freshTx) =>
        freshTx
          .select({ id: dispatchTicket.id })
          .from(dispatchTicket)
          .where(
            and(
              eq(dispatchTicket.resourceId, rId),
              eq(dispatchTicket.status, 'open'),
            ),
          )
          .limit(1),
      );

      const openTicketId = existing[0]?.id ?? 'unknown';
      return { ok: false, reason: 'already_open', openTicketId } as const;
    }
    throw outerErr;
  }
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function openDispatch(
  session: AppSession | null | undefined,
  input: unknown,
): Promise<OpenDispatchResult> {
  const db = await getDb();
  // Always uses stubBalanceSeam in app code (Phase 1 money boundary).
  return _openDispatchImpl(db, session, input, stubBalanceSeam);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function openDispatchWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  balanceSeam: BalanceSeam = stubBalanceSeam,
): Promise<OpenDispatchResult> {
  return _openDispatchImpl(db, session, input, balanceSeam);
}
