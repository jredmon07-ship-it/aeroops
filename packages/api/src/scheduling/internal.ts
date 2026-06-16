/**
 * scheduling/internal.ts — shared internals for the reservation write path.
 *
 * NOT exported from @aeroops/api. Holds:
 *   - ValidationError (distinct from conflict/policy — see types.ts)
 *   - the Zod input schema for create/check
 *   - toIso — Date → ISO-8601 string (the sanctioned clock boundary)
 *   - runConflictProbe — the core overlap query (powers preview + rich result)
 *   - isExclusionViolation — robust 23P01 detection across driver wrappings
 *   - loadBookingPolicy — load 0..1 booking_policy row as core BookingPolicy
 *   - loadBlackouts — load resource_blackout rows overlapping [start,end)
 *   - runPolicyProbe — per-resource policy+blackout load + evaluateBookingPolicy;
 *       returns PolicyViolationView[] (enriched with resourceDisplayName)
 *
 * ADR-0004: the EXCLUDE constraint is the authoritative no-double-book
 * guarantee; this probe is for UX/messaging and to avoid relying solely on the
 * constraint. Both use the identical half-open `[)` overlap definition so the
 * preview and the DB verdict cannot disagree.
 *
 * ADR-0005: the policy probe is the authoritative policy gate (single write
 * path). Pure-core evaluateBookingPolicy receives an injected `now` (epoch ms)
 * so it stays deterministic and testable.
 */
import { z } from 'zod';
import { sql, eq, and } from 'drizzle-orm';
import { bookingPolicy, resourceBlackout } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { evaluateBookingPolicy } from '@aeroops/core';
import type { BookingPolicy, BlackoutWindow } from '@aeroops/core';
import type { ConflictHit, PolicyViolationView } from './types.js';

// RFC-4122 UUID, version-agnostic (mirrors @aeroops/db's UUID_RE). zod v4's
// z.uuid() strictly validates version/variant nibbles and would reject some
// valid Postgres uuids; we match the db layer's relaxed acceptance instead.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── ValidationError ────────────────────────────────────────────────────────

/**
 * ValidationError — thrown for malformed input or an unbookable resource set
 * (end<=start, zero resources, inactive/wrong-kind/cross-org resource id).
 *
 * DISTINCT FROM A CONFLICT: a conflict is a returned value
 * (`{ ok:false, reason:'conflict' }`), never thrown. A ValidationError means
 * the request itself was invalid and NO write was attempted.
 *
 * apps/web route handlers map this to HTTP 400 (vs 409 for a conflict result).
 */
export class ValidationError extends Error {
  readonly code = 'VALIDATION' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ─── Input schema (create + check share the same window/resource shape) ───────

/**
 * createInputSchema — validates the window + resource list.
 *
 *   endAt > startAt          — distinct ValidationError, NOT a conflict.
 *   resourceIds length >= 1  — at least one resource.
 *   resourceIds de-duplicated — duplicates collapsed (a resource cannot
 *                               conflict with itself within one reservation).
 *
 * Dates must be valid Date instances (reject Invalid Date / NaN time).
 */
export const reservationWindowSchema = z
  .object({
    startAt: z
      .date({ message: 'startAt must be a Date' })
      .refine((d) => !Number.isNaN(d.getTime()), { message: 'startAt is an invalid Date' }),
    endAt: z
      .date({ message: 'endAt must be a Date' })
      .refine((d) => !Number.isNaN(d.getTime()), { message: 'endAt is an invalid Date' }),
    resourceIds: z
      .array(z.string().regex(UUID_RE, { message: 'resourceIds must be UUIDs' }))
      .min(1, { message: 'At least one resourceId is required' }),
    notes: z.string().optional(),
  })
  .refine((v) => v.endAt.getTime() > v.startAt.getTime(), {
    message: 'endAt must be strictly after startAt',
    path: ['endAt'],
  });

/** Parse + normalize input; throws ValidationError on any failure. */
export function parseReservationWindow(input: unknown): {
  startAt: Date;
  endAt: Date;
  resourceIds: string[];
  notes?: string;
} {
  const parsed = reservationWindowSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[scheduling] invalid reservation input: ${first?.message ?? 'unknown'}`,
    );
  }
  // De-duplicate resourceIds, preserving first-appearance order.
  const seen = new Set<string>();
  const resourceIds: string[] = [];
  for (const id of parsed.data.resourceIds) {
    if (!seen.has(id)) {
      seen.add(id);
      resourceIds.push(id);
    }
  }
  return {
    startAt: parsed.data.startAt,
    endAt: parsed.data.endAt,
    resourceIds,
    notes: parsed.data.notes,
  };
}

// ─── during: the single sanctioned tstzrange representation ───────────────────

/**
 * durationParams — returns the start/end ISO strings used to build a
 * half-open tstzrange in SQL via tstzrange($start::timestamptz,$end::timestamptz,'[)').
 *
 * We always pass ISO strings as bound parameters and let Postgres construct the
 * range with the '[)' bound flag, so the JS layer never hand-assembles a range
 * literal. This is the ONLY place the window crosses into SQL.
 */
export function toIso(d: Date): string {
  return d.toISOString();
}

// ─── Conflict probe (the core overlap query) ──────────────────────────────────

/**
 * runConflictProbe — find every booked join row that collides with the given
 * window on any of the given resources, joined to resource + reservation for a
 * rich ConflictHit.
 *
 * Query (ADR-0004 / schema-engineer shape):
 *   SELECT … FROM reservation_resource rr
 *     JOIN resource r        ON r.id  = rr.resource_id
 *     JOIN reservation res   ON res.id = rr.reservation_id
 *    WHERE rr.resource_id = ANY($ids::uuid[])
 *      AND rr.status = 'booked'
 *      AND rr.during && tstzrange($start::timestamptz, $end::timestamptz, '[)')
 *
 * Must run INSIDE withSessionOrgContext (RLS scopes rows to the session org).
 * The `during` overlap (&&) uses the GiST EXCLUDE index. We extract the
 * existing window bounds via lower()/upper() so the UI shows the booked slot.
 *
 * resource_id is globally unique and belongs to exactly one org (ADR-0004), so
 * org-scoping the probe rows is handled by RLS; no org_id predicate needed.
 */
export async function runConflictProbe(
  tx: AnyDb,
  startAt: Date,
  endAt: Date,
  resourceIds: string[],
): Promise<ConflictHit[]> {
  if (resourceIds.length === 0) return [];
  const startIso = toIso(startAt);
  const endIso = toIso(endAt);

  // Build a parameterized uuid[] for `= ANY(ARRAY[...])`: each id is a bound
  // parameter, never string-concatenated (injection-safe). resourceIds is
  // de-duplicated and uuid-validated by parseReservationWindow upstream.
  const idList = sql.join(
    resourceIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const result = await tx.execute(sql`
    SELECT
      rr.resource_id       AS resource_id,
      r.display_name       AS resource_display_name,
      rr.reservation_id    AS reservation_id,
      lower(rr.during)     AS existing_start,
      upper(rr.during)     AS existing_end
    FROM reservation_resource rr
    JOIN resource r ON r.id = rr.resource_id
    WHERE rr.resource_id = ANY(ARRAY[${idList}])
      AND rr.status = 'booked'
      AND rr.during && tstzrange(${startIso}::timestamptz, ${endIso}::timestamptz, '[)')
    ORDER BY rr.resource_id, existing_start
  `);

  const rows = (result.rows ?? result) as unknown as Array<{
    resource_id: string;
    resource_display_name: string;
    reservation_id: string;
    existing_start: string | Date;
    existing_end: string | Date;
  }>;

  return rows.map((row) => ({
    resourceId: row.resource_id,
    resourceDisplayName: row.resource_display_name,
    reservationId: row.reservation_id,
    start: row.existing_start instanceof Date ? row.existing_start : new Date(row.existing_start),
    end: row.existing_end instanceof Date ? row.existing_end : new Date(row.existing_end),
  }));
}

// ─── 23P01 detection (ADR-0004 catch-and-requery) ─────────────────────────────

/**
 * isExclusionViolation — does this thrown error carry Postgres SQLSTATE 23P01
 * (exclusion_violation)?
 *
 * The driver wraps the raw error: Drizzle throws a DrizzleQueryError whose
 * `.cause` is the postgres-js / pglite error carrying `.code === '23P01'`.
 * Some paths surface `.code` directly. We walk the cause chain to be robust
 * across both the pglite test driver and the postgres-js prod driver.
 */
export function isExclusionViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur != null; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (code === '23P01') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

// ─── Policy probe (ADR-0005 — the second gate beside conflict detection) ───────

/**
 * loadBookingPolicy — load the optional booking_policy row for a resource,
 * mapping it to the pure-core BookingPolicy shape (or null for open booking).
 *
 * Must run INSIDE withSessionOrgContext (RLS scopes rows to the session org).
 * Returns null when no policy row exists → open booking, Slice-1 behaviour.
 */
export async function loadBookingPolicy(
  tx: AnyDb,
  resourceId: string,
): Promise<BookingPolicy | null> {
  const rows = await tx
    .select({
      maxDurationMinutes: bookingPolicy.maxDurationMinutes,
      maxAdvanceDays: bookingPolicy.maxAdvanceDays,
      minAdvanceMinutes: bookingPolicy.minAdvanceMinutes,
    })
    .from(bookingPolicy)
    .where(eq(bookingPolicy.resourceId, resourceId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    maxDurationMinutes: row.maxDurationMinutes ?? null,
    maxAdvanceDays: row.maxAdvanceDays ?? null,
    minAdvanceMinutes: row.minAdvanceMinutes ?? null,
  };
}

/**
 * loadBlackouts — load resource_blackout rows whose `during` overlaps the
 * candidate window [startAt, endAt), returning them as BlackoutWindow[].
 *
 * Filter: `during && tstzrange($start, $end, '[)')` — same half-open semantics
 * as the conflict probe's reservation_resource query.
 *
 * Must run INSIDE withSessionOrgContext (RLS scopes rows to the session org).
 * ADR-0005 §4: blackouts are evaluated even when no policy row exists.
 */
export async function loadBlackouts(
  tx: AnyDb,
  resourceId: string,
  startAt: Date,
  endAt: Date,
): Promise<BlackoutWindow[]> {
  const startIso = toIso(startAt);
  const endIso = toIso(endAt);

  const result = await tx.execute(sql`
    SELECT
      lower(during) AS blackout_start,
      upper(during) AS blackout_end
    FROM resource_blackout
    WHERE resource_id = ${resourceId}::uuid
      AND during && tstzrange(${startIso}::timestamptz, ${endIso}::timestamptz, '[)')
    ORDER BY lower(during)
  `);

  const rows = (result.rows ?? result) as unknown as Array<{
    blackout_start: string | Date;
    blackout_end: string | Date;
  }>;

  return rows.map((row) => ({
    start:
      row.blackout_start instanceof Date
        ? row.blackout_start.getTime()
        : new Date(row.blackout_start).getTime(),
    end:
      row.blackout_end instanceof Date
        ? row.blackout_end.getTime()
        : new Date(row.blackout_end).getTime(),
  }));
}

/**
 * runPolicyProbe — for each of the candidate's resources, load policy +
 * blackouts (both RLS-scoped) and run evaluateBookingPolicy with the injected
 * `now`. Returns all violations as PolicyViolationView[] (enriched with
 * resourceDisplayName). Returns [] when all resources are policy-clean.
 *
 * @param tx           - Transaction (inside withSessionOrgContext).
 * @param startAt      - Candidate window start.
 * @param endAt        - Candidate window end.
 * @param resourceRows - Already-loaded resource rows (id + displayName), from
 *                       step 3a of create-reservation (avoids a second SELECT).
 * @param now          - Injected current time in epoch ms (never Date.now() here).
 */
export async function runPolicyProbe(
  tx: AnyDb,
  startAt: Date,
  endAt: Date,
  resourceRows: Array<{ id: string; displayName: string }>,
  now: number,
): Promise<PolicyViolationView[]> {
  const violations: PolicyViolationView[] = [];

  for (const res of resourceRows) {
    const [policy, blackouts] = await Promise.all([
      loadBookingPolicy(tx, res.id),
      loadBlackouts(tx, res.id, startAt, endAt),
    ]);

    const candidate = {
      resourceId: res.id,
      start: startAt.getTime(),
      end: endAt.getTime(),
    };

    const rawViolations = evaluateBookingPolicy(candidate, policy, blackouts, now);

    // Enrich each violation with the human-readable display name (ADR-0005 [DEFER-G]).
    for (const v of rawViolations) {
      violations.push({ ...v, resourceDisplayName: res.displayName });
    }
  }

  return violations;
}
