/**
 * scheduling/internal.ts — shared internals for the reservation write path.
 *
 * NOT exported from @aeroops/api. Holds:
 *   - ValidationError (distinct from conflict/policy — see types.ts)
 *   - OccurrenceRaceError — thrown by gatedCreateOccurrence on 23P01; the
 *       caller decides whether to re-probe in a fresh tx (single-create) or on
 *       the live outer tx after Drizzle rolls back the savepoint (series path).
 *   - the Zod input schema for create/check
 *   - toIso — Date → ISO-8601 string (the sanctioned clock boundary)
 *   - makeApiZonedToUtcResolver — Intl-based ZonedToUtc resolver (shared by
 *       create-series + preview-series so DST-critical logic has ONE copy).
 *   - isValidIanaTz — tz string validation helper (shared).
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
 *
 * ADR-0006 §3 race semantics:
 *   - Single-create: gatedCreateOccurrence throws OccurrenceRaceError on 23P01.
 *     The caller (createReservation) catches it and re-probes in a FRESH tx via
 *     reProbeInFreshTx — correct because the single outer tx is already poisoned
 *     and concluding.
 *   - Series path: gatedCreateOccurrence throws OccurrenceRaceError on 23P01.
 *     The throw propagates out of the tx.transaction() savepoint callback, which
 *     causes Drizzle to emit ROLLBACK TO SAVEPOINT (un-poisoning the outer tx
 *     back to the pre-savepoint state). The series loop catches OccurrenceRaceError
 *     and re-probes on the LIVE PARENT tx (now clean), then records the occurrence
 *     as skipped/conflict. The outer tx remains alive and commits other occurrences.
 */
import { z } from 'zod';
import { sql, eq } from 'drizzle-orm';
import { reservation, auditLog, bookingPolicy, resource } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { withOrgContext } from '@aeroops/db';
import {
  evaluateBookingPolicy,
  evaluateGroundingGate,
  computeSolarEvents,
  evaluateTwilightGate,
  resolveAvailabilityWindowsToUtc,
  evaluateAvailabilityGate,
} from '@aeroops/core';
import type {
  BookingPolicy,
  BlackoutWindow,
  ZonedToUtc,
  SolarEvents,
  TwilightHit,
  ResourceAvailabilityWindow,
  AvailabilityHit,
} from '@aeroops/core';
import type { ConflictHit, PolicyViolationView, CreateReservationResult } from './types.js';
import type { AppSession } from '../auth/types.js';
import { loadGroundingProbe } from '../maintenance/internal.js';
import { extractRows } from '../db-rows.js';

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

// ─── OccurrenceRaceError ─────────────────────────────────────────────────────

/**
 * OccurrenceRaceError — thrown by gatedCreateOccurrence when the INSERT raises
 * a 23P01 exclusion_violation (a concurrent commit won the race AFTER our
 * pre-check passed).
 *
 * This error signals a race to the CALLER so it can re-probe in the correct
 * context:
 *   - Single-create (createReservation): re-probe in a FRESH tx via
 *     reProbeInFreshTx (the outer tx is poisoned and concluding).
 *   - Series path (createSeries loop): let this propagate out of the savepoint
 *     callback; Drizzle emits ROLLBACK TO SAVEPOINT, then catch in the loop and
 *     re-probe on the LIVE PARENT tx (which is now clean back to the savepoint).
 *
 * Carries the window + resource ids needed for the re-probe.
 */
export class OccurrenceRaceError extends Error {
  readonly code = 'OCCURRENCE_RACE' as const;
  constructor(
    public readonly startAt: Date,
    public readonly endAt: Date,
    public readonly resourceIds: string[],
    cause?: unknown,
  ) {
    super('[scheduling] 23P01 exclusion_violation: concurrent booking won the race');
    this.name = 'OccurrenceRaceError';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
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

// ─── Shared tz helpers (L2: single canonical copy; imported by create-series + preview-series) ──

/**
 * makeApiZonedToUtcResolver — create a ZonedToUtc resolver backed by Intl APIs.
 *
 * Implements ZonedToUtc using platform Intl APIs only (no tz library dep).
 * DST handling (ADR-0006 §2):
 *   - spring-forward gap (local time skipped)  → status 'nonexistent'
 *   - fall-back (local time occurs twice)       → status 'ambiguous', utcMs = earlier instant
 *   - normal                                    → status 'valid'
 *
 * Cached per tz string so the Intl.DateTimeFormat object is reused across
 * the N occurrence resolutions within one createSeries/previewSeries call.
 *
 * THIS IS THE SINGLE AUTHORITATIVE COPY. Both create-series.ts and
 * preview-series.ts import it from here so DST-critical logic has one source.
 */
export function makeApiZonedToUtcResolver(): ZonedToUtc {
  const fmtCache = new Map<string, Intl.DateTimeFormat>();

  const getFmt = (tz: string): Intl.DateTimeFormat => {
    let f = fmtCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
      fmtCache.set(tz, f);
    }
    return f;
  };

  // Render a UTC instant into local civil parts in `tz`.
  const partsAt = (utcMs: number, tz: string) => {
    const parts = getFmt(tz).formatToParts(new Date(utcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    let hour = get('hour');
    if (hour === 24) hour = 0; // some engines emit 24 for midnight
    return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute') };
  };

  // Offset (minutes, UTC = local - offset) at a given UTC instant in `tz`.
  const offsetAt = (utcMs: number, tz: string): number => {
    const p = partsAt(utcMs, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    return Math.round((asUtc - utcMs) / 60_000);
  };

  return ({ year, month, day, hour, minute, tz }) => {
    const targetLocal = Date.UTC(year, month - 1, day, hour, minute);

    // Two probe offsets to find all UTC instants that render back to this local time.
    const off1 = offsetAt(targetLocal, tz);
    const cand1 = targetLocal - off1 * 60_000;
    const off2 = offsetAt(cand1, tz);
    const cand2 = targetLocal - off2 * 60_000;

    const matches = (utcMs: number): boolean => {
      const p = partsAt(utcMs, tz);
      return (
        p.year === year &&
        p.month === month &&
        p.day === day &&
        p.hour === hour &&
        p.minute === minute
      );
    };

    const valid: number[] = [];
    for (const c of [cand1, cand2]) {
      if (matches(c) && !valid.includes(c)) valid.push(c);
    }

    if (valid.length === 0) {
      // Spring-forward gap: this local time does not exist.
      return { utcMs: cand1, status: 'nonexistent' as const };
    }
    if (valid.length >= 2) {
      // Fall-back: ambiguous. Return the EARLIER instant (ADR-0006 §2).
      return { utcMs: Math.min(...valid), status: 'ambiguous' as const };
    }
    return { utcMs: valid[0]!, status: 'valid' as const };
  };
}

/**
 * isValidIanaTz — true iff the Intl subsystem accepts this tz string.
 * Uses Intl.DateTimeFormat constructor; throws on an invalid zone.
 *
 * THIS IS THE SINGLE AUTHORITATIVE COPY. Both create-series.ts and
 * preview-series.ts import it from here.
 */
export function isValidIanaTz(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
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

  const rows = extractRows<{
    resource_id: string;
    resource_display_name: string;
    reservation_id: string;
    existing_start: string | Date;
    existing_end: string | Date;
  }>(result);

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

  const rows = extractRows<{
    blackout_start: string | Date;
    blackout_end: string | Date;
  }>(result);

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

// ─── Twilight context (Slice 4a — additive gate, modeled on grounding) ────────

/**
 * TwilightConfigView — the org's dispatch_config twilight fields, with the
 * canonical absent-row defaults applied (per migration 0010 / dispatch_config.ts):
 *   { enabled: false, mode: 'warn', exemptTag: null } → gate INERT.
 */
export interface TwilightConfigView {
  enabled: boolean;
  mode: 'block' | 'warn';
  exemptTag: string | null;
}

/**
 * loadTwilightConfig — read the 0..1 dispatch_config twilight fields for the org.
 *
 * RLS-scoped by the caller's tx GUC. Absent row → canonical defaults (gate inert).
 * This reads the SAME table as dispatch-gate/internal.ts loadDispatchConfig but a
 * disjoint column set (twilight_*), so it is a sibling reader, not a divergence.
 *
 * [VERIFY-4a-A]: these are operator-config + astronomy inputs only — NOT an FAA
 * night-currency (§61.57/§1.1) determination.
 */
export async function loadTwilightConfig(
  tx: AnyDb,
  orgId: string,
): Promise<TwilightConfigView> {
  const result = await tx.execute(sql`
    SELECT
      twilight_constraint_enabled AS "enabled",
      twilight_mode               AS "mode",
      twilight_exempt_tag         AS "exemptTag"
    FROM dispatch_config
    WHERE org_id = ${orgId}::uuid
    LIMIT 1
  `);

  const rows = extractRows<{
    enabled: boolean;
    mode: string;
    exemptTag: string | null;
  }>(result);

  const row = rows[0];
  if (!row) {
    // Absent row → gate INERT (the Phase-1 default).
    return { enabled: false, mode: 'warn', exemptTag: null };
  }

  return {
    enabled: row.enabled,
    mode: row.mode === 'block' ? 'block' : 'warn',
    exemptTag: row.exemptTag ?? null,
  };
}

/**
 * TwilightResourceContext — per-aircraft twilight evaluation context.
 *
 *   resourceId — the aircraft resource id.
 *   events     — computeSolarEvents output for that aircraft's home-base coords on
 *                the candidate-start civil day, OR null when the resource is not an
 *                aircraft, has no home base, or its home base has no coordinates
 *                (gate INERT for that resource — evaluateTwilightGate returns empty).
 */
export interface TwilightResourceContext {
  resourceId: string;
  events: SolarEvents | null;
}

/**
 * TwilightContext — the loaded config + per-aircraft solar events, ready to feed
 * evaluateTwilightGate. Returned by loadTwilightContext.
 *
 * pilotIsExempt is DEFERRED in Slice 4a (always false). The reservation has no
 * first-class "pilot" field, so there is nothing to evaluate the exempt tag
 * against yet (conductor decision 2026-06-19). The dispatch_config.twilight_exempt_tag
 * column is a forward seam; wiring lands in a later slice with a pilot association.
 * SEAM: when a pilot association exists, resolve pilotIsExempt by checking whether
 * the pilot holds `config.exemptTag` (member_tag), then pass it per-resource here.
 */
export interface TwilightContext {
  config: TwilightConfigView;
  perResource: TwilightResourceContext[];
  /** DEFERRED in 4a: always false (see SEAM above). */
  pilotIsExempt: boolean;
}

/**
 * loadTwilightContext — load the org's twilight config + per-aircraft solar events.
 *
 * For each requested resource that is an AIRCRAFT with a home_base_location_id
 * pointing at a location carrying lat/long, computes computeSolarEvents on the
 * candidate-start civil day. Non-aircraft, missing home base, or missing coords →
 * `events: null` (the core gate is INERT there). RLS-scoped by the tx GUC.
 *
 * Returns the full context even when disabled — the CALLER decides to skip when
 * `config.enabled === false` (keeping the disabled path byte-identical by NOT
 * calling this at all; see gatedCreateOccurrence Step H).
 *
 * @param tx                   - Active tx with org GUC set (RLS-scoped).
 * @param orgId                - Session org id (for the config read).
 * @param resourceIds          - The reservation's resources.
 * @param candidateStartUtcMs  - Epoch ms of the candidate window start (anchors the civil day).
 */
export async function loadTwilightContext(
  tx: AnyDb,
  orgId: string,
  resourceIds: string[],
  candidateStartUtcMs: number,
  /** Pre-loaded config to avoid a second dispatch_config read (gated path). */
  preloadedConfig?: TwilightConfigView,
): Promise<TwilightContext> {
  const config = preloadedConfig ?? (await loadTwilightConfig(tx, orgId));

  // Load each requested resource's kind + home-base coordinates in one query.
  // resource is RLS-scoped by the tx GUC; location is joined on the composite
  // (home_base_location_id, org_id) candidate key, also RLS-scoped — org A's
  // coords can never leak into org B's events.
  const perResource: TwilightResourceContext[] = [];

  if (resourceIds.length === 0) {
    return { config, perResource, pilotIsExempt: false };
  }

  const idList = sql.join(
    resourceIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const result = await tx.execute(sql`
    SELECT
      r.id               AS "resourceId",
      r.kind             AS "kind",
      l.latitude         AS "latitude",
      l.longitude        AS "longitude"
    FROM resource r
    LEFT JOIN location l ON l.id = r.home_base_location_id
    WHERE r.id = ANY(ARRAY[${idList}])
  `);

  const rows = extractRows<{
    resourceId: string;
    kind: string;
    latitude: string | number | null;
    longitude: string | number | null;
  }>(result);

  const byId = new Map(rows.map((row) => [row.resourceId, row]));

  for (const id of resourceIds) {
    const row = byId.get(id);
    // Non-aircraft, missing home base, or missing coords → events null (inert).
    if (
      !row ||
      row.kind !== 'aircraft' ||
      row.latitude == null ||
      row.longitude == null
    ) {
      perResource.push({ resourceId: id, events: null });
      continue;
    }

    const latitude = typeof row.latitude === 'number' ? row.latitude : Number(row.latitude);
    const longitude = typeof row.longitude === 'number' ? row.longitude : Number(row.longitude);

    if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
      perResource.push({ resourceId: id, events: null });
      continue;
    }

    const events = computeSolarEvents({
      latitude,
      longitude,
      dateUtcMs: candidateStartUtcMs,
    });
    perResource.push({ resourceId: id, events });
  }

  return { config, perResource, pilotIsExempt: false };
}

/**
 * runTwilightGate — evaluate evaluateTwilightGate for every aircraft in `ctx`,
 * collecting all blocked + warning hits. Pure orchestration over the pure core
 * gate; INERT (empty arrays) when events=null or classification≠'normal'.
 *
 * pilotIsExempt is taken from ctx (DEFERRED → false in 4a).
 */
export function runTwilightGate(
  ctx: TwilightContext,
  candidateStartUtcMs: number,
  candidateEndUtcMs: number,
): { blocked: TwilightHit[]; warnings: TwilightHit[] } {
  const blocked: TwilightHit[] = [];
  const warnings: TwilightHit[] = [];

  for (const r of ctx.perResource) {
    const res = evaluateTwilightGate({
      candidateStartUtcMs,
      candidateEndUtcMs,
      events: r.events,
      pilotIsExempt: ctx.pilotIsExempt,
      mode: ctx.config.mode,
    });
    blocked.push(...res.blocked);
    warnings.push(...res.warnings);
  }

  return { blocked, warnings };
}

// ─── Availability context (Slice AV1.2 — additive gate, modeled on twilight) ──

/**
 * AvailabilityConfigView — the org's dispatch_config availability fields, with the
 * canonical absent-row defaults applied (migration 0014):
 *   { enabled: false, mode: 'warn' } → gate INERT.
 */
export interface AvailabilityConfigView {
  enabled: boolean;
  mode: 'block' | 'warn';
}

/**
 * loadAvailabilityConfig — read the 0..1 dispatch_config availability fields.
 *
 * RLS-scoped by the caller's tx GUC. Absent row → canonical defaults (gate inert).
 * Sibling reader of loadTwilightConfig / loadDispatchConfig (disjoint column set).
 *
 * [VERIFY-AV1-A]: operator scheduling / operating-hours config ONLY — NOT an FAA
 * duty-time / rest / Part-117/135/121 determination.
 */
export async function loadAvailabilityConfig(
  tx: AnyDb,
  orgId: string,
): Promise<AvailabilityConfigView> {
  const result = await tx.execute(sql`
    SELECT
      availability_constraint_enabled AS "enabled",
      availability_mode               AS "mode"
    FROM dispatch_config
    WHERE org_id = ${orgId}::uuid
    LIMIT 1
  `);

  const rows = extractRows<{
    enabled: boolean;
    mode: string;
  }>(result);

  const row = rows[0];
  if (!row) {
    return { enabled: false, mode: 'warn' };
  }
  return { enabled: row.enabled, mode: row.mode === 'block' ? 'block' : 'warn' };
}

/**
 * AvailabilityResourceContext — per-resource pre-resolved operating-hours windows.
 *
 *   resourceId — the resource id.
 *   resolved   — the resource's weekly operating-hours windows resolved to concrete
 *                UTC [open, close) intervals for the candidate's date span (DST
 *                handled in core), OR null when the resource has NO windows (gate
 *                INERT for that resource — evaluateAvailabilityGate returns ok).
 */
export interface AvailabilityResourceContext {
  resourceId: string;
  resolved: ResolvedAvailabilityWindowMs[] | null;
}

/** Local alias for the core ResolvedAvailabilityWindow (UTC [open, close)). */
interface ResolvedAvailabilityWindowMs {
  openUtcMs: number;
  closeUtcMs: number;
}

/**
 * AvailabilityContext — loaded config + per-resource resolved windows, ready to
 * feed evaluateAvailabilityGate. Returned by loadAvailabilityContext.
 */
export interface AvailabilityContext {
  config: AvailabilityConfigView;
  perResource: AvailabilityResourceContext[];
}

/**
 * loadAvailabilityContext — load the org's availability config + per-resource
 * resolved operating-hours windows for the candidate's span.
 *
 * For each requested resource, reads its resource_availability_window rows
 * (RLS-scoped) and pre-resolves each weekly window to UTC [open, close) for the
 * candidate's date span via resolveAvailabilityWindowsToUtc + the injected Intl
 * tz resolver (the SAME resolver recurrence/twilight use; the DST handling lives
 * in @aeroops/core). A resource with ZERO windows → resolved: null (gate INERT
 * for that resource), preserving the byte-identical create path.
 *
 * Returns the full context even when disabled — the CALLER decides to skip when
 * config.enabled === false (keeping the disabled path byte-identical by NOT
 * calling this at all; see gatedCreateOccurrence Step D3).
 *
 * @param tx                  - Active tx with org GUC set (RLS-scoped).
 * @param orgId               - Session org id (for the config read).
 * @param resourceIds         - The reservation's resources.
 * @param candidateStartUtcMs - Epoch ms of the candidate window start.
 * @param candidateEndUtcMs   - Epoch ms of the candidate window end.
 * @param tzResolver          - Injected Intl-based ZonedToUtc resolver.
 * @param preloadedConfig     - Pre-loaded config to avoid a second read (gated path).
 */
export async function loadAvailabilityContext(
  tx: AnyDb,
  orgId: string,
  resourceIds: string[],
  candidateStartUtcMs: number,
  candidateEndUtcMs: number,
  tzResolver: ZonedToUtc,
  preloadedConfig?: AvailabilityConfigView,
): Promise<AvailabilityContext> {
  const config = preloadedConfig ?? (await loadAvailabilityConfig(tx, orgId));

  const perResource: AvailabilityResourceContext[] = [];
  if (resourceIds.length === 0) {
    return { config, perResource };
  }

  const idList = sql.join(
    resourceIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  // Load every requested resource's operating-hours windows in one query.
  // resource_availability_window is RLS-scoped by the tx GUC — org A's windows can
  // never leak into org B's resolution.
  const result = await tx.execute(sql`
    SELECT
      resource_id  AS "resourceId",
      day_of_week  AS "dayOfWeek",
      start_minute AS "startMinute",
      end_minute   AS "endMinute",
      tz           AS "tz"
    FROM resource_availability_window
    WHERE resource_id = ANY(ARRAY[${idList}])
  `);

  const rows = extractRows<{
    resourceId: string;
    dayOfWeek: number;
    startMinute: number;
    endMinute: number;
    tz: string;
  }>(result);

  // Group raw windows by resource.
  const windowsByResource = new Map<string, ResourceAvailabilityWindow[]>();
  for (const row of rows) {
    const w: ResourceAvailabilityWindow = {
      dayOfWeek: Number(row.dayOfWeek),
      startMinute: Number(row.startMinute),
      endMinute: Number(row.endMinute),
      tz: row.tz,
    };
    const list = windowsByResource.get(row.resourceId);
    if (list) list.push(w);
    else windowsByResource.set(row.resourceId, [w]);
  }

  for (const id of resourceIds) {
    const windows = windowsByResource.get(id);
    if (!windows || windows.length === 0) {
      // No operating-hours rows → gate INERT for this resource.
      perResource.push({ resourceId: id, resolved: null });
      continue;
    }
    const resolved = resolveAvailabilityWindowsToUtc(
      windows,
      candidateStartUtcMs,
      candidateEndUtcMs,
      tzResolver,
    );
    perResource.push({ resourceId: id, resolved });
  }

  return { config, perResource };
}

/**
 * runAvailabilityGate — evaluate evaluateAvailabilityGate for every resource in
 * `ctx`, collecting all blocked + warning hits. Pure orchestration over the pure
 * core gate; INERT (empty arrays) when a resource has null/empty resolved windows.
 *
 * For a MULTI-resource reservation each resource that HAS windows is evaluated; a
 * block on ANY resource → blocked is non-empty (the caller turns that into a block).
 */
export function runAvailabilityGate(
  ctx: AvailabilityContext,
  candidateStartUtcMs: number,
  candidateEndUtcMs: number,
): { blocked: AvailabilityHit[]; warnings: AvailabilityHit[] } {
  const blocked: AvailabilityHit[] = [];
  const warnings: AvailabilityHit[] = [];

  for (const r of ctx.perResource) {
    const res = evaluateAvailabilityGate(
      { candidateStartUtcMs, candidateEndUtcMs },
      r.resolved,
      ctx.config.mode,
    );
    if (res.ok) {
      // warn-mode hit rides on the ok arm via `warns: true`.
      if ('warns' in res && res.warns) warnings.push(...res.hits);
    } else {
      blocked.push(...res.hits);
    }
  }

  return { blocked, warnings };
}

// ─── Bookable kinds (mirrors create-reservation.ts) ───────────────────────────

/** Resource kinds that are bookable in Slice 1/2a/2b. */
const BOOKABLE_KINDS = new Set<string>(['aircraft', 'instructor']);

// ─── gatedCreateOccurrence ────────────────────────────────────────────────────

/**
 * GatedCreateInput — input to gatedCreateOccurrence.
 * All fields come from the caller (createReservation or createSeries loop).
 */
export interface GatedCreateInput {
  startAt: Date;
  endAt: Date;
  resourceIds: string[];
  notes?: string;
  /** Set by createSeries for each occurrence (NULL for single-create). */
  seriesId?: string;
  /**
   * Slice 4b (additive): extra key/values merged INTO the reservation.created
   * audit row's metadata (e.g. { optimizationRunId } from runAutoSchedule). Absent
   * for single-create + series → the audit metadata stays BYTE-IDENTICAL. Cannot
   * override the base metadata keys (resourceIds/startAt/endAt/seriesId): those are
   * spread AFTER auditMetadata so the canonical fields always win.
   */
  auditMetadata?: Record<string, unknown>;
}

/**
 * gatedCreateOccurrence — the shared per-occurrence gated create body.
 *
 * RUNS INSIDE A PROVIDED TX OR SAVEPOINT — does NOT open its own transaction.
 * Shared by createReservation (1× in its own tx) and createSeries (N× in
 * per-occurrence savepoints inside a single outer tx).
 *
 * Gates:
 *   1. Resource validation: each resourceId must be visible, active, bookable kind.
 *   2. Conflict pre-check (runConflictProbe).
 *   3. Policy probe (runPolicyProbe).
 *   4. Refusal precedence: conflict_and_policy > policy > conflict > INSERT.
 *   5. INSERT reservation (with optional series_id) + join rows + audit_log.
 *   6. 23P01 detection: on exclusion_violation, throw OccurrenceRaceError so the
 *      CALLER can re-probe in the correct context (ADR-0006 §3):
 *        - Single-create: caller re-probes in a fresh tx (outer tx poisoned).
 *        - Series path: throw propagates out of the savepoint callback → Drizzle
 *          emits ROLLBACK TO SAVEPOINT → caller catches OccurrenceRaceError and
 *          re-probes on the LIVE parent tx (which is now clean).
 *      NOTE: `db` parameter is retained for API compatibility but is NOT used
 *      internally; the caller is responsible for re-probing.
 *
 * @param tx   - The current tx or savepoint (already has org GUC set).
 * @param sess - The authenticated session (org_id, user_id, role).
 * @param db   - The raw db handle (retained for caller compat; not used here).
 * @param input - Window + resourceIds + optional notes/seriesId.
 * @param now  - Injected epoch ms (never Date.now() inside this function).
 */
export async function gatedCreateOccurrence(
  tx: AnyDb,
  sess: AppSession,
  db: AnyDb,
  input: GatedCreateInput,
  now: number,
): Promise<CreateReservationResult> {
  const { startAt, endAt, resourceIds, notes, seriesId, auditMetadata } = input;

  // Step A — load requested resources (RLS scopes to org via tx GUC).
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

  const validResourceRows = resourceIds.map((id) => {
    const r = byId.get(id)!;
    return { id: r.id, displayName: r.displayName };
  });

  // Step B — conflict pre-check.
  const preHits = await runConflictProbe(tx, startAt, endAt, resourceIds);

  // Step C — policy probe.
  const violations = await runPolicyProbe(tx, startAt, endAt, validResourceRows, now);

  // Step D — refusal precedence (byte-identical to create-reservation.ts).
  // These four arms are FROZEN — twilight is NEVER combined with conflict/policy.
  if (preHits.length > 0 && violations.length > 0) {
    return { ok: false, reason: 'conflict_and_policy', conflicts: preHits, violations };
  }
  if (violations.length > 0) {
    return { ok: false, reason: 'policy', violations };
  }
  if (preHits.length > 0) {
    return { ok: false, reason: 'conflict', conflicts: preHits };
  }

  // Step D2 — twilight gate (Slice 4a, additive; modeled on grounding Step G).
  // Loaded + evaluated ONLY when the operator opted in (config.enabled). When
  // disabled (the Phase-1 default) we never touch dispatch_config/location and
  // the create path stays BYTE-IDENTICAL.
  //
  // Precedence: conflict_and_policy > policy > conflict > twilight > INSERT.
  // Twilight is evaluated LAST (after the four FROZEN refusal arms above), so it
  // can ONLY fire when there is no conflict and no policy violation. In BLOCK
  // mode a twilight hit is a STANDALONE refusal arm — never combined with the
  // others. NO write + NO audit on a twilight refusal (consistent with the
  // other refusal arms).
  //
  // INERT when: events=null (no coords / non-aircraft / no home base) OR
  // classification≠'normal' (polar / no-civil-twilight) OR pilotIsExempt
  // (DEFERRED → false). The pure core gate returns empty in all those cases.
  let twilightWarnings: TwilightHit[] | undefined;
  {
    const twilightCfg = await loadTwilightConfig(tx, sess.orgId);
    if (twilightCfg.enabled) {
      const twilightCtx = await loadTwilightContext(
        tx,
        sess.orgId,
        resourceIds,
        startAt.getTime(),
        twilightCfg,
      );
      const { blocked, warnings } = runTwilightGate(
        twilightCtx,
        startAt.getTime(),
        endAt.getTime(),
      );
      if (twilightCtx.config.mode === 'block' && blocked.length > 0) {
        // New standalone refusal arm — no write, no audit.
        return { ok: false, reason: 'twilight', twilight: blocked };
      }
      // warn mode: stash for the success arm (attached additively below).
      if (warnings.length > 0) {
        twilightWarnings = warnings;
      }
    }
  }

  // Step D3 — availability gate (Slice AV1.2, additive; modeled on twilight Step D2).
  // Loaded + evaluated ONLY when the operator opted in (config.enabled). When
  // disabled (the default) we never touch dispatch_config/resource_availability_window
  // and the create path stays BYTE-IDENTICAL.
  //
  // Precedence: conflict_and_policy > policy > conflict > twilight > availability > INSERT.
  // Availability is evaluated LAST (after twilight + the four FROZEN refusal arms),
  // so it can ONLY fire when there is no conflict, no policy violation, and no
  // twilight block. In BLOCK mode an availability hit is a STANDALONE refusal arm —
  // never combined with the others. NO write + NO audit on an availability refusal.
  //
  // INERT when: a resource has zero operating-hours windows (resolved=null) OR the
  // candidate is fully contained in the union. The pure core gate returns ok then.
  // For a MULTI-resource reservation EACH resource with windows is evaluated; a
  // block on ANY resource blocks the whole create.
  let availabilityWarnings: AvailabilityHit[] | undefined;
  {
    const availabilityCfg = await loadAvailabilityConfig(tx, sess.orgId);
    if (availabilityCfg.enabled) {
      const availabilityCtx = await loadAvailabilityContext(
        tx,
        sess.orgId,
        resourceIds,
        startAt.getTime(),
        endAt.getTime(),
        makeApiZonedToUtcResolver(),
        availabilityCfg,
      );
      const { blocked, warnings: avWarnings } = runAvailabilityGate(
        availabilityCtx,
        startAt.getTime(),
        endAt.getTime(),
      );
      if (availabilityCtx.config.mode === 'block' && blocked.length > 0) {
        // New standalone refusal arm — no write, no audit.
        return { ok: false, reason: 'availability', availability: blocked };
      }
      // warn mode: stash for the success arm (attached additively below).
      if (avWarnings.length > 0) {
        availabilityWarnings = avWarnings;
      }
    }
  }

  // Step E — INSERT.
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
        seriesId: seriesId ?? null,
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

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'reservation.created',
      entityType: 'reservation',
      entityId: reservationId,
      metadata: {
        // Slice 4b: optional extra metadata (e.g. optimizationRunId) is spread
        // FIRST so the canonical reservation fields below always win and the
        // common (absent auditMetadata) case is BYTE-IDENTICAL.
        ...(auditMetadata ?? {}),
        resourceIds,
        startAt: startIso,
        endAt: endIso,
        ...(seriesId ? { seriesId } : {}),
      },
    });

    // ── Step G — grounding gate (ADR-0008 §2.3 Integration A, Option A) ──────
    // WARN-ONLY at create in Slice 3b: this runs ONLY on the success path (the
    // create has already been decided + the INSERT/audit have committed in-tx),
    // AFTER refusal precedence (Step D), so it cannot alter any refusal arm or
    // the precedence. It is NOT a mutation (no rows written) and never blocks.
    //
    // Build the candidate set from the already-loaded resourceRows (kind comes
    // from byId) + the grounding probe map. Non-aircraft (e.g. instructors) have
    // no grounding events → grounded:false, and evaluateGroundingGate ignores
    // any kind !== 'aircraft' regardless. The probe is RLS-scoped by the tx GUC.
    const groundingMap = await loadGroundingProbe(tx, resourceIds);
    const groundingCandidates = resourceIds.map((id) => {
      const r = byId.get(id)!;
      const probe = groundingMap.get(id);
      return {
        resourceId: id,
        kind: r.kind,
        grounded: probe?.grounded ?? false,
        reason: probe?.reason ?? null,
      };
    });
    const { warnings } = evaluateGroundingGate(groundingCandidates, 'warn');

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
      // Only attach when non-empty so the ok:true shape stays byte-identical for
      // the common (nothing grounded) case — existing consumers see no new field.
      ...(warnings.length > 0 ? { groundingWarnings: warnings } : {}),
      // Slice 4a: twilight warnings (warn mode only) ride along additively, exactly
      // like grounding. Absent when no aircraft crosses civil dawn/dusk (or the gate
      // is disabled) → ok:true shape byte-identical for the common case.
      ...(twilightWarnings && twilightWarnings.length > 0
        ? { twilightWarnings }
        : {}),
      // Slice AV1.2: availability warnings (warn mode only) ride along additively,
      // exactly like twilightWarnings. Absent when every resource's booking is within
      // its operating-hours union (or the gate is disabled) → ok:true shape
      // byte-identical for the common case.
      ...(availabilityWarnings && availabilityWarnings.length > 0
        ? { availabilityWarnings }
        : {}),
    };
  } catch (err) {
    // Step F — 23P01 detection (ADR-0006 §3 race semantics).
    // The INSERT raised an exclusion_violation. Throw OccurrenceRaceError so the
    // CALLER can re-probe in the correct context:
    //   - Single-create (createReservation): re-probe in a fresh tx because the
    //     outer tx is poisoned and concluding.
    //   - Series path (createSeries loop): this throw propagates out of the
    //     tx.transaction() savepoint callback; Drizzle emits ROLLBACK TO
    //     SAVEPOINT (un-poisoning the outer tx back to the pre-savepoint state);
    //     the series loop catches OccurrenceRaceError and re-probes on the LIVE
    //     parent tx (which is now clean).
    // In either case we do NOT re-probe here — the tx/savepoint context is
    // wrong for a re-probe (poisoned for single-create; still-open savepoint for
    // series that Drizzle has not rolled back yet at this call stack frame).
    if (isExclusionViolation(err)) {
      throw new OccurrenceRaceError(startAt, endAt, resourceIds, err);
    }
    throw err;
  }
}

/**
 * reProbeInFreshTx — re-run the conflict probe in a FRESH transaction.
 * Used after a 23P01 exclusion violation poisons the current tx/savepoint.
 * Opens a new withOrgContext(db) transaction so the probe sees committed rows.
 */
export async function reProbeInFreshTx(
  db: AnyDb,
  sess: AppSession,
  startAt: Date,
  endAt: Date,
  resourceIds: string[],
): Promise<ConflictHit[]> {
  return withOrgContext(db, sess.orgId, (tx) =>
    runConflictProbe(tx, startAt, endAt, resourceIds),
  );
}
