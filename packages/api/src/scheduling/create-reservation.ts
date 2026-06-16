/**
 * create-reservation.ts — the single sanctioned write path for reservations
 * (SCHED-1, ADR-0004 invariant 2). NOTHING else inserts reservation /
 * reservation_resource rows.
 *
 * GUARANTEES:
 *   - authz first: requireCapability('schedule:create_reservation') BEFORE any
 *     data access.
 *   - org_id comes ONLY from the session (withSessionOrgContext).
 *   - all-or-nothing: a reservation with N resources inserts N join rows in ONE
 *     transaction; if ANY resource collides, the whole thing is rejected and
 *     NO row is written (the free resources are NOT booked).
 *   - the EXCLUDE constraint is the authoritative race backstop: we pre-check
 *     with the overlap probe for a rich message, but if a concurrent commit
 *     wins the race the INSERT raises 23P01 — we catch it, re-probe, and return
 *     the same rich conflict result (ADR-0004 catch-and-requery).
 *   - every successful create writes ONE audit_log row (reservations are
 *     records — no silent mutation).
 *
 * TWO CALLING FORMS (mirrors get-dashboard-summary):
 *   createReservation(session, input)        — app code; uses getDb() internally.
 *   createReservationWithDb(db, session, in)  — tests; inject pglite client.
 */
import { sql } from 'drizzle-orm';
import { reservation, resource, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import type { CreateReservationResult, ConflictHit } from './types.js';
import {
  ValidationError,
  parseReservationWindow,
  runConflictProbe,
  runPolicyProbe,
  isExclusionViolation,
  toIso,
} from './internal.js';

/** Input to createReservation. */
export interface CreateReservationInput {
  startAt: Date;
  endAt: Date;
  resourceIds: string[];
  notes?: string;
}

/**
 * CreateReservationOptions — internal options bag.
 * `now` is injected (epoch ms) for deterministic tests; defaults to Date.now()
 * in the app-code form. See ADR-0005 invariant 2 (pure core, injected clock).
 */
interface CreateReservationOptions {
  now?: number;
}

// Kinds that are bookable in Slice 1. sim/room/vehicle are forward-compat data
// but are rejected here until their slice ships (ADR-0004 §Forward-compat).
const BOOKABLE_KINDS = new Set<string>(['aircraft', 'instructor']);

// ─── Shared implementation ────────────────────────────────────────────────────

async function _createReservationImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: CreateReservationInput,
  opts?: CreateReservationOptions,
): Promise<CreateReservationResult> {
  // Capture `now` once at impl top. Default to Date.now(); injectable for tests
  // (ADR-0005 invariant 2 — core stays pure, clock injected at this boundary).
  const now = opts?.now ?? Date.now();

  // 1. AUTHZ FIRST — before any data access. Throws Forbidden/Unauthenticated.
  requireCapability(session, 'schedule:create_reservation');

  // 2. VALIDATE — endAt>startAt, >=1 resource, de-dup. Throws ValidationError
  //    (distinct from a conflict result).
  const { startAt, endAt, resourceIds, notes } = parseReservationWindow(input);

  // 3. ONE transaction scoped to session.orgId (READ COMMITTED; EXCLUDE is the
  //    race backstop per ADR-0004 — no SERIALIZABLE retry loop needed).
  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3a. Load the requested resources (RLS scopes to org). Assert each exists,
    //     is active, and is a bookable kind. Any failure → ValidationError,
    //     NO write.
    const resourceRows = await tx
      .select({
        id: resource.id,
        kind: resource.kind,
        displayName: resource.displayName,
        active: resource.active,
      })
      .from(resource);

    const byId = new Map(resourceRows.map((r) => [r.id, r]));
    for (const id of resourceIds) {
      const r = byId.get(id);
      if (!r) {
        // Not visible in-org → cross-org / unknown / deleted. No write.
        throw new ValidationError(
          `[scheduling] resource ${id} not found in this org (or not visible).`,
        );
      }
      if (!r.active) {
        throw new ValidationError(`[scheduling] resource ${id} is inactive and cannot be booked.`);
      }
      if (!BOOKABLE_KINDS.has(r.kind)) {
        throw new ValidationError(
          `[scheduling] resource ${id} has kind '${r.kind}' which is not bookable in this slice ` +
            `(only aircraft + instructor).`,
        );
      }
    }

    // The ordered list of valid resource rows (id + displayName) for the probe.
    const validResourceRows = resourceIds.map((id) => {
      const r = byId.get(id)!;
      return { id: r.id, displayName: r.displayName };
    });

    // 3b. PRE-CHECK conflicts via the overlap probe (for a rich message + to not
    //     rely solely on the constraint). If any hit → roll back / no write.
    const preHits = await runConflictProbe(tx, startAt, endAt, resourceIds);

    // 3a.5 POLICY PROBE — runs alongside the conflict pre-check (ADR-0005).
    //     Per resource: load booking_policy (0..1) + resource_blackout rows
    //     overlapping [start, end); call evaluateBookingPolicy with injected now.
    //     Returns all violations enriched with resourceDisplayName.
    //     NO actor-tag load (required_tags DEFERRED — Scope Amendment 2026-06-16).
    const violations = await runPolicyProbe(tx, startAt, endAt, validResourceRows, now);

    // Refusal precedence: if EITHER gate fires, refuse before any INSERT.
    //   conflict only     → existing Slice-1 arm (BYTE-IDENTICAL, FROZEN).
    //   policy only       → new Slice-2a arm.
    //   conflict + policy → new Slice-2a arm reporting both arrays.
    //   both clean        → fall through to INSERT (step 3c).
    if (preHits.length > 0 && violations.length > 0) {
      return { ok: false, reason: 'conflict_and_policy', conflicts: preHits, violations };
    }
    if (violations.length > 0) {
      return { ok: false, reason: 'policy', violations };
    }
    if (preHits.length > 0) {
      return { ok: false, reason: 'conflict', conflicts: preHits };
    }

    // 3c. INSERT reservation + N join rows + 1 audit_log row.
    //     The EXCLUDE constraint is the truth: if a concurrent commit raced in
    //     between 3b and here, the join INSERT raises 23P01 → caught below.
    try {
      const [resv] = await tx
        .insert(reservation)
        .values({
          orgId: sess.orgId,
          startAt,
          endAt,
          status: 'booked',
          notes: notes ?? null,
          createdBy: sess.userId,
        })
        .returning({
          id: reservation.id,
          orgId: reservation.orgId,
          startAt: reservation.startAt,
          endAt: reservation.endAt,
          notes: reservation.notes,
          createdBy: reservation.createdBy,
        });

      const reservationId = resv!.id;
      const startIso = toIso(startAt);
      const endIso = toIso(endAt);

      // Insert one join row per resource, building `during` as the single
      // sanctioned half-open tstzrange. Done in the SAME transaction so any
      // collision rolls back the reservation row too (all-or-nothing).
      for (const resourceId of resourceIds) {
        await tx.execute(sql`
          INSERT INTO reservation_resource (org_id, reservation_id, resource_id, during, status)
          VALUES (
            ${sess.orgId}::uuid,
            ${reservationId}::uuid,
            ${resourceId}::uuid,
            tstzrange(${startIso}::timestamptz, ${endIso}::timestamptz, '[)'),
            'booked'
          )
        `);
      }

      // Audit row — reservations are records (no silent mutation).
      await tx.insert(auditLog).values({
        orgId: sess.orgId,
        actorUserId: sess.userId,
        action: 'reservation.created',
        entityType: 'reservation',
        entityId: reservationId,
        metadata: {
          resourceIds,
          startAt: startIso,
          endAt: endIso,
        },
      });

      return {
        ok: true,
        reservation: {
          id: reservationId,
          orgId: resv!.orgId,
          startAt: resv!.startAt,
          endAt: resv!.endAt,
          status: 'booked',
          notes: resv!.notes,
          createdBy: resv!.createdBy,
          resourceIds,
        },
      };
    } catch (err) {
      // 3d. ADR-0004 catch-and-requery: a genuine race lost to a concurrent
      //     commit raises 23P01 (exclusion_violation). The constraint is the
      //     truth; re-run the probe to build the rich conflict result.
      //
      //     NOTE: in pglite (single-threaded WASM) this path is reached only by
      //     a same-tx collision; true OS-thread concurrency is not reproducible
      //     here — see the [DEFERRED to real-PG CI] note in the test suite.
      if (isExclusionViolation(err)) {
        // The probe must run in a context that can see the committed colliding
        // row. The failed INSERT has poisoned this transaction, so re-probe in
        // a fresh transaction scoped to the same org.
        const hits = await reProbeAfterRace(db, sess, startAt, endAt, resourceIds);
        return { ok: false, reason: 'conflict', conflicts: hits };
      }
      throw err;
    }
  });
}

/**
 * reProbeAfterRace — re-run the conflict probe in a FRESH transaction after a
 * 23P01. The original transaction is aborted (poisoned by the failed INSERT),
 * so we cannot query inside it; we open a new withSessionOrgContext to read the
 * now-committed colliding rows.
 */
async function reProbeAfterRace(
  db: AnyDb,
  sess: AppSession,
  startAt: Date,
  endAt: Date,
  resourceIds: string[],
): Promise<ConflictHit[]> {
  return withSessionOrgContextWithDb(db, sess, (_sess, tx) =>
    runConflictProbe(tx, startAt, endAt, resourceIds),
  );
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * createReservation — race-safe reservation create for the authenticated org.
 *
 * @param session - AppSession from auth(); null/undefined → UnauthenticatedError.
 * @param input   - window + resourceIds (+ optional notes).
 * @returns CreateReservationResult — ok:true with the reservation, or
 *          ok:false reason:'conflict'|'policy'|'conflict_and_policy'.
 * @throws  UnauthenticatedError | ForbiddenError | ValidationError.
 */
export async function createReservation(
  session: AppSession | null | undefined,
  input: CreateReservationInput,
): Promise<CreateReservationResult> {
  const db = await getDb();
  return _createReservationImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/**
 * createReservationWithDb — test form; inject a pglite client.
 * `opts.now` accepts an injected epoch-ms clock for deterministic policy tests.
 */
export async function createReservationWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: CreateReservationInput,
  opts?: { now?: number },
): Promise<CreateReservationResult> {
  return _createReservationImpl(db, session, input, opts);
}
