/**
 * check-conflicts.ts — the advisory, READ-ONLY combined preview for
 * conflict + policy (SCHED-1 / SCHED-2a, ADR-0004 + ADR-0005).
 *
 * SCHED-1: Runs the same overlap probe the create path uses and returns the
 * colliding existing windows WITHOUT writing anything.
 *
 * SCHED-2a additive extension: also runs the policy probe (same pure-core
 * evaluateBookingPolicy via runPolicyProbe) so the UI makes ONE combined call
 * and gets both conflict + policy information in a single response. Authz,
 * validation, and write-nothing guarantees are unchanged.
 *
 * GUARANTEES:
 *   - authz first: requireCapability('schedule:create_reservation') BEFORE any
 *     data access — a preview gates the same as the create it previews.
 *   - org_id comes ONLY from the session (withSessionOrgContextWithDb); RLS
 *     scopes the probe rows to the caller's org.
 *   - PURE PREVIEW: no INSERT/UPDATE/DELETE, no audit row.
 *   - `now` injected via opts.now for deterministic tests; defaults Date.now().
 *
 * NOT A WRITE GATE. Advisory only — MUST NEVER be the sole guard against
 * double-booking or policy violations. The authoritative gates are inside
 * createReservation (conflict: EXCLUDE constraint + pre-check; policy: the
 * single choke-point probe per ADR-0005 invariant 1).
 *
 * TWO CALLING FORMS (mirrors create-reservation):
 *   checkConflicts(session, input)                    — app code.
 *   checkConflictsWithDb(db, session, input, opts?)   — tests; inject pglite.
 */
import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import type { ConflictHit, PolicyViolationView } from './types.js';
import { parseReservationWindow, runConflictProbe, runPolicyProbe } from './internal.js';

/**
 * Input to checkConflicts — the same window + resource shape as create, minus
 * notes (irrelevant to a preview; ignored if present).
 */
export interface CheckConflictsInput {
  startAt: Date;
  endAt: Date;
  resourceIds: string[];
}

/**
 * CheckConflictsResult — discriminated union (mirrors CreateReservationResult's
 * posture; SCHED-1 arms BYTE-IDENTICAL, SCHED-2a arms added additively).
 *
 *   ok:true                              → clear on all gates; all resources available.
 *   ok:false reason:'conflict'           → conflicts only (no policy issues). FROZEN arm.
 *   ok:false reason:'policy'             → policy violations only (no conflicts).
 *   ok:false reason:'conflict_and_policy' → both gates fired.
 *
 * Nothing is written in any arm.
 */
export type CheckConflictsResult =
  | { ok: true }
  | { ok: false; reason: 'conflict'; conflicts: ConflictHit[] }
  | { ok: false; reason: 'policy'; violations: PolicyViolationView[] }
  | { ok: false; reason: 'conflict_and_policy'; conflicts: ConflictHit[]; violations: PolicyViolationView[] };

// ─── Shared implementation ────────────────────────────────────────────────────

async function _checkConflictsImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: CheckConflictsInput,
  opts?: { now?: number },
): Promise<CheckConflictsResult> {
  // Capture `now` at impl top — same discipline as create-reservation.
  const now = opts?.now ?? Date.now();

  // 1. AUTHZ FIRST — before any data access. Throws Forbidden/Unauthenticated.
  requireCapability(session, 'schedule:create_reservation');

  // 2. VALIDATE — endAt>startAt, >=1 resource, de-dup. Throws ValidationError
  //    (distinct from a conflict result). Reuses the create schema; `notes` (if
  //    passed) is parsed and discarded.
  const { startAt, endAt, resourceIds } = parseReservationWindow(input);

  // 3. ONE transaction scoped to session.orgId. Pure SELECT — commits nothing.
  return withSessionOrgContextWithDb(db, session, async (_sess, tx) => {
    // Load resource displayNames for the policy probe (needed for enrichment).
    // RLS scopes to org. We only need the rows for the requested ids.
    const idList = sql.join(
      resourceIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const resourceRows = await tx.execute(sql`
      SELECT id, display_name AS display_name
      FROM resource
      WHERE id = ANY(ARRAY[${idList}])
    `);
    const rawResources = (resourceRows.rows ?? resourceRows) as unknown as Array<{
      id: string;
      display_name: string;
    }>;
    const resourceMeta = rawResources.map((r) => ({
      id: r.id,
      displayName: r.display_name,
    }));

    // Run both probes (reads only, no writes).
    const [hits, violations] = await Promise.all([
      runConflictProbe(tx, startAt, endAt, resourceIds),
      runPolicyProbe(tx, startAt, endAt, resourceMeta, now),
    ]);

    // Merge into the four-arm result.
    if (hits.length > 0 && violations.length > 0) {
      return { ok: false, reason: 'conflict_and_policy', conflicts: hits, violations };
    }
    if (violations.length > 0) {
      return { ok: false, reason: 'policy', violations };
    }
    if (hits.length > 0) {
      return { ok: false, reason: 'conflict', conflicts: hits };
    }
    return { ok: true };
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

/**
 * checkConflicts — advisory combined conflict + policy preview for the
 * authenticated org. Writes nothing; never the sole write guard.
 *
 * @param session - AppSession from auth(); null/undefined → UnauthenticatedError.
 * @param input   - window + resourceIds (notes ignored).
 * @returns CheckConflictsResult — four-arm union; ok:true when all gates clear.
 * @throws  UnauthenticatedError | ForbiddenError | ValidationError.
 */
export async function checkConflicts(
  session: AppSession | null | undefined,
  input: CheckConflictsInput,
): Promise<CheckConflictsResult> {
  const db = await getDb();
  return _checkConflictsImpl(db, session, input);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

/**
 * checkConflictsWithDb — test form; inject a pglite client.
 * `opts.now` accepts an injected epoch-ms clock for deterministic policy tests.
 */
export async function checkConflictsWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: CheckConflictsInput,
  opts?: { now?: number },
): Promise<CheckConflictsResult> {
  return _checkConflictsImpl(db, session, input, opts);
}
