/**
 * auto-schedule-internal.ts — shared internals for the Slice 4b auto-scheduler
 * (runAutoSchedule + previewAutoSchedule).
 *
 * NOT exported from @aeroops/api. Holds the two read builders both the commit and
 * the preview paths share, so the proposer sees IDENTICAL inputs in both:
 *
 *   - buildAvailability(tx, resourceIds, base, blocked?) — per-resource bookable
 *     windows = the operator business-hours BASE span MINUS existing booked
 *     reservation_resource rows MINUS resource_blackout rows MINUS (for grounded
 *     aircraft) the whole base span. All reads RLS-scoped by the caller's tx GUC.
 *   - buildTwilightBoundaries(tx, orgId, aircraftIds, anchorMs) — per-aircraft
 *     { civilDawnUtcMs, civilDuskUtcMs } derived from loadTwilightContext, ONLY
 *     when the org's twilight constraint is ENABLED + mode='block' (so warn/
 *     disabled never hard-excludes a window — the proposer just proposes, and the
 *     authoritative warn/inert behaviour still happens inside gatedCreateOccurrence).
 *   - subtractIntervals — pure half-open interval subtraction (busy ⊖ base).
 *   - validateAutoScheduleInput — input parse → { demands, base, objective }.
 *   - deriveSeed — stable, deterministic default seed from the input (no
 *     Date.now / Math.random); overridable via opts for tests.
 *
 * INVARIANT: org_id is NEVER read from input — the caller passes the session org.
 */

import { sql } from 'drizzle-orm';
import type { AnyDb } from '@aeroops/db';
import type {
  AvailabilityWindow,
  PerResourceTwilight,
  DemandRequest,
} from '@aeroops/core';
import { ValidationError, loadTwilightContext, loadAvailabilityContext } from './internal.js';
import type { TwilightConfigView, AvailabilityConfigView } from './internal.js';
import { makeApiZonedToUtcResolver } from './internal.js';
import { extractRows } from '../db-rows.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Pure half-open interval subtraction ──────────────────────────────────────

/** One half-open interval [start, end), epoch ms. */
export interface Interval {
  start: number;
  end: number;
}

/**
 * subtractIntervals — base ⊖ busy. Returns the parts of `base` not covered by any
 * interval in `busy`, as a sorted list of half-open [start, end) intervals.
 * Degenerate (start>=end) results are dropped. Pure.
 */
export function subtractIntervals(base: Interval, busy: Interval[]): Interval[] {
  if (base.start >= base.end) return [];
  // Clip + sort busy intervals to the base span; merge overlaps.
  const clipped = busy
    .map((b) => ({ start: Math.max(b.start, base.start), end: Math.min(b.end, base.end) }))
    .filter((b) => b.start < b.end)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Interval[] = [];
  for (const b of clipped) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last.end) {
      if (b.end > last.end) last.end = b.end;
    } else {
      merged.push({ ...b });
    }
  }

  const out: Interval[] = [];
  let cursor = base.start;
  for (const m of merged) {
    if (m.start > cursor) out.push({ start: cursor, end: m.start });
    cursor = Math.max(cursor, m.end);
  }
  if (cursor < base.end) out.push({ start: cursor, end: base.end });
  return out;
}

// ─── Availability builder ─────────────────────────────────────────────────────

/**
 * buildAvailability — for each requested resource, compute its bookable windows
 * within [base.start, base.end): the base span MINUS existing booked
 * reservation_resource windows MINUS resource_blackout windows MINUS (for any
 * grounded aircraft) the entire base span.
 *
 * RLS-scoped by the caller's tx GUC. One query for booked rows, one for blackouts,
 * one grounding probe (the same DISTINCT-ON probe gatedCreateOccurrence uses).
 *
 * Grounded aircraft: we subtract the WHOLE base span so the proposer will not
 * place a session on a grounded tail. (Grounding is warn-only inside
 * gatedCreateOccurrence; here it is a planning input, not a hard gate — the
 * proposer simply avoids it, and a tail un-grounded between preview and commit
 * would still create successfully.)
 */
export async function buildAvailability(
  tx: AnyDb,
  resourceIds: string[],
  base: Interval,
): Promise<AvailabilityWindow[]> {
  if (resourceIds.length === 0 || base.start >= base.end) return [];

  const idList = sql.join(resourceIds.map((id) => sql`${id}::uuid`), sql`, `);
  const baseStartIso = new Date(base.start).toISOString();
  const baseEndIso = new Date(base.end).toISOString();

  // Which requested resources are actually BOOKABLE in the session org: visible
  // (RLS-scoped), active, and of a bookable kind (aircraft|instructor). A resource
  // id that is out-of-org / inactive / non-bookable yields NO availability, so the
  // pure proposer reports it `unschedulable` (no_feasible_window) — a RETURNED
  // outcome — instead of the commit throwing a ValidationError on a phantom
  // proposal. This keeps cross-tenant + bad ids a soft, accounted-for result.
  const bookableRes = await tx.execute(sql`
    SELECT id AS "id"
    FROM resource
    WHERE id = ANY(ARRAY[${idList}])
      AND active = true
      AND kind IN ('aircraft', 'instructor')
  `);
  const bookableRows = extractRows<{ id: string }>(bookableRes);
  const bookable = new Set(bookableRows.map((r) => r.id));

  // Existing booked windows overlapping the base span (per resource).
  const bookedRes = await tx.execute(sql`
    SELECT
      rr.resource_id   AS "resourceId",
      lower(rr.during) AS "start",
      upper(rr.during) AS "end"
    FROM reservation_resource rr
    WHERE rr.resource_id = ANY(ARRAY[${idList}])
      AND rr.status = 'booked'
      AND rr.during && tstzrange(${baseStartIso}::timestamptz, ${baseEndIso}::timestamptz, '[)')
  `);
  const bookedRows = extractRows<{
    resourceId: string;
    start: string | Date;
    end: string | Date;
  }>(bookedRes);

  // Blackout windows overlapping the base span (per resource).
  const blackoutRes = await tx.execute(sql`
    SELECT
      resource_id   AS "resourceId",
      lower(during) AS "start",
      upper(during) AS "end"
    FROM resource_blackout
    WHERE resource_id = ANY(ARRAY[${idList}])
      AND during && tstzrange(${baseStartIso}::timestamptz, ${baseEndIso}::timestamptz, '[)')
  `);
  const blackoutRows = extractRows<{
    resourceId: string;
    start: string | Date;
    end: string | Date;
  }>(blackoutRes);

  // Latest grounding state per resource (DISTINCT ON). Grounded → block whole span.
  const groundingRes = await tx.execute(sql`
    SELECT DISTINCT ON (resource_id)
      resource_id AS "resourceId",
      state       AS "state"
    FROM aircraft_grounding
    WHERE resource_id = ANY(ARRAY[${idList}])
    ORDER BY resource_id, created_at DESC, id DESC
  `);
  const groundingRows = extractRows<{
    resourceId: string;
    state: string;
  }>(groundingRes);
  const grounded = new Set(
    groundingRows.filter((r) => r.state === 'grounded').map((r) => r.resourceId),
  );

  const toMs = (v: string | Date): number => (v instanceof Date ? v.getTime() : new Date(v).getTime());

  const busyByResource = new Map<string, Interval[]>();
  const push = (rid: string, start: number, end: number): void => {
    const list = busyByResource.get(rid);
    if (list) list.push({ start, end });
    else busyByResource.set(rid, [{ start, end }]);
  };
  for (const r of bookedRows) push(r.resourceId, toMs(r.start), toMs(r.end));
  for (const r of blackoutRows) push(r.resourceId, toMs(r.start), toMs(r.end));

  const windows: AvailabilityWindow[] = [];
  for (const rid of resourceIds) {
    if (!bookable.has(rid)) continue; // out-of-org / inactive / non-bookable → no windows.
    if (grounded.has(rid)) continue; // whole span blocked → no windows.
    const busy = busyByResource.get(rid) ?? [];
    for (const free of subtractIntervals(base, busy)) {
      windows.push({ resourceId: rid, startUtcMs: free.start, endUtcMs: free.end });
    }
  }
  return windows;
}

// ─── Twilight boundary builder ────────────────────────────────────────────────

/**
 * buildTwilightBoundaries — per-aircraft { civilDawnUtcMs, civilDuskUtcMs } from
 * loadTwilightContext, ONLY when the org twilight constraint is ENABLED + mode
 * 'block'. In warn / disabled we pass NO boundary, so the proposer does not
 * hard-exclude windows — the authoritative warn/inert behaviour still lives in
 * gatedCreateOccurrence (a warn-mode crossing creates with a warning, not a skip).
 *
 * INERT per resource when events=null (no coords / non-aircraft / no home base)
 * or classification≠'normal' (polar / no-civil-twilight): no entry is emitted, so
 * the proposer leaves that resource unconstrained (NEVER hard-block an undefined
 * boundary — matches evaluateTwilightGate's inert contract).
 *
 * The civil day is anchored at `anchorMs` (the availability base start), so all
 * proposals for a single planning window share one day's dawn/dusk. RLS-scoped.
 */
export async function buildTwilightBoundaries(
  tx: AnyDb,
  orgId: string,
  resourceIds: string[],
  anchorMs: number,
  preloadedConfig?: TwilightConfigView,
): Promise<{ boundaries: PerResourceTwilight[]; config: TwilightConfigView }> {
  const ctx = await loadTwilightContext(tx, orgId, resourceIds, anchorMs, preloadedConfig);

  // Only constrain the proposer in BLOCK mode. In warn / disabled the boundaries
  // are empty so the proposer proposes freely.
  if (!ctx.config.enabled || ctx.config.mode !== 'block') {
    return { boundaries: [], config: ctx.config };
  }

  const boundaries: PerResourceTwilight[] = [];
  for (const r of ctx.perResource) {
    // Inert resource → no boundary (proposer leaves it unconstrained).
    if (!r.events || r.events.classification !== 'normal') continue;
    boundaries.push({
      resourceId: r.resourceId,
      civilDawnUtcMs: r.events.civilDawnUtcMs,
      civilDuskUtcMs: r.events.civilDuskUtcMs,
    });
  }
  return { boundaries, config: ctx.config };
}

// ─── Availability (operating-hours) planning intersection (AV1.2, block-only) ──

/**
 * intersectIntervalLists — pure half-open intersection of two interval lists.
 * Returns every [start, end) shared by SOME interval in `a` and SOME in `b`.
 * Degenerate results are dropped. Inputs need not be sorted/disjoint.
 */
function intersectIntervalLists(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) {
    for (const y of b) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (start < end) out.push({ start, end });
    }
  }
  return out;
}

/**
 * applyAvailabilityWindows — block-mode-only planning intersection (decision 9;
 * mirrors buildTwilightBoundaries' block-only posture).
 *
 * When the org availability constraint is ENABLED + mode='block', this intersects
 * the already-computed bookable windows (base ⊖ booked ⊖ blackout ⊖ grounded) with
 * each resource's resolved operating-hours windows, so the proposer NEVER proposes a
 * session outside operating hours. A resource with NO operating-hours windows is
 * left UNCONSTRAINED (its windows pass through unchanged) — byte-identical to the
 * core gate's INERT-no-windows contract.
 *
 * In warn / disabled mode this is a NO-OP (returns the input windows unchanged) —
 * the authoritative warn/inert behaviour still lives in gatedCreateOccurrence (a
 * warn-mode out-of-hours window creates with a warning, not a skip).
 *
 * The candidate span used for DST resolution is the whole base window. RLS-scoped.
 */
export async function applyAvailabilityWindows(
  tx: AnyDb,
  orgId: string,
  resourceIds: string[],
  base: Interval,
  windows: AvailabilityWindow[],
  preloadedConfig?: AvailabilityConfigView,
): Promise<{ windows: AvailabilityWindow[]; config: AvailabilityConfigView }> {
  const ctx = await loadAvailabilityContext(
    tx,
    orgId,
    resourceIds,
    base.start,
    base.end,
    makeApiZonedToUtcResolver(),
    preloadedConfig,
  );

  // Only constrain the proposer in BLOCK mode. In warn / disabled, pass through.
  if (!ctx.config.enabled || ctx.config.mode !== 'block') {
    return { windows, config: ctx.config };
  }

  // Per-resource resolved operating-hours intervals (null = no windows → inert).
  const opHoursByResource = new Map<string, Interval[] | null>();
  for (const r of ctx.perResource) {
    opHoursByResource.set(
      r.resourceId,
      r.resolved === null
        ? null
        : r.resolved.map((w) => ({ start: w.openUtcMs, end: w.closeUtcMs })),
    );
  }

  const constrained: AvailabilityWindow[] = [];
  for (const w of windows) {
    const opHours = opHoursByResource.get(w.resourceId);
    if (opHours === null || opHours === undefined) {
      // No operating-hours windows for this resource → unconstrained (inert).
      constrained.push(w);
      continue;
    }
    const free: Interval[] = [{ start: w.startUtcMs, end: w.endUtcMs }];
    for (const piece of intersectIntervalLists(free, opHours)) {
      constrained.push({ resourceId: w.resourceId, startUtcMs: piece.start, endUtcMs: piece.end });
    }
  }

  return { windows: constrained, config: ctx.config };
}

// ─── Input validation ─────────────────────────────────────────────────────────

/** The validated + normalized auto-schedule request. */
export interface NormalizedAutoSchedule {
  demands: DemandRequest[];
  base: Interval;
  objective: 'maximize_utilization' | 'maximize_sessions_scheduled';
  /** Union of every demand's resource ids (de-duped) — drives the reads. */
  allResourceIds: string[];
}

/**
 * validateAutoScheduleInput — parse + normalize raw input. Throws ValidationError
 * on any malformed field (auth/validation are thrown; refusals are returned).
 */
export function validateAutoScheduleInput(raw: unknown): NormalizedAutoSchedule {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('[scheduling] invalid auto-schedule input');
  }
  const r = raw as Record<string, unknown>;

  const windowStart = r['windowStartUtcMs'];
  const windowEnd = r['windowEndUtcMs'];
  if (typeof windowStart !== 'number' || !Number.isFinite(windowStart)) {
    throw new ValidationError('[scheduling] windowStartUtcMs must be a finite epoch-ms number');
  }
  if (typeof windowEnd !== 'number' || !Number.isFinite(windowEnd)) {
    throw new ValidationError('[scheduling] windowEndUtcMs must be a finite epoch-ms number');
  }
  if (windowEnd <= windowStart) {
    throw new ValidationError('[scheduling] windowEndUtcMs must be strictly after windowStartUtcMs');
  }

  const rawObjective = r['objective'];
  let objective: NormalizedAutoSchedule['objective'] = 'maximize_sessions_scheduled';
  if (rawObjective !== undefined) {
    if (rawObjective !== 'maximize_utilization' && rawObjective !== 'maximize_sessions_scheduled') {
      throw new ValidationError('[scheduling] objective must be maximize_utilization or maximize_sessions_scheduled');
    }
    objective = rawObjective;
  }

  const rawDemands = r['demands'];
  if (!Array.isArray(rawDemands) || rawDemands.length === 0) {
    throw new ValidationError('[scheduling] demands must be a non-empty array');
  }

  const seenIds = new Set<string>();
  const demands: DemandRequest[] = [];
  const allResources = new Set<string>();

  for (const rawD of rawDemands) {
    if (!rawD || typeof rawD !== 'object') {
      throw new ValidationError('[scheduling] each demand must be an object');
    }
    const d = rawD as Record<string, unknown>;

    const id = d['id'];
    if (typeof id !== 'string' || id.length === 0) {
      throw new ValidationError('[scheduling] each demand.id must be a non-empty string');
    }
    if (seenIds.has(id)) {
      throw new ValidationError(`[scheduling] duplicate demand.id '${id}'`);
    }
    seenIds.add(id);

    const rawIds = d['requiredResourceIds'];
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      throw new ValidationError(`[scheduling] demand '${id}': requiredResourceIds must be a non-empty array of UUIDs`);
    }
    const seenRes = new Set<string>();
    const requiredResourceIds: string[] = [];
    for (const rid of rawIds) {
      if (typeof rid !== 'string' || !UUID_RE.test(rid)) {
        throw new ValidationError(`[scheduling] demand '${id}': each requiredResourceId must be a UUID`);
      }
      if (!seenRes.has(rid)) {
        seenRes.add(rid);
        requiredResourceIds.push(rid);
        allResources.add(rid);
      }
    }

    const durationMinutes = d['durationMinutes'];
    if (typeof durationMinutes !== 'number' || !Number.isInteger(durationMinutes) || durationMinutes <= 0) {
      throw new ValidationError(`[scheduling] demand '${id}': durationMinutes must be an integer > 0`);
    }

    const earliest = d['earliestStartUtcMs'];
    if (earliest !== undefined && (typeof earliest !== 'number' || !Number.isFinite(earliest))) {
      throw new ValidationError(`[scheduling] demand '${id}': earliestStartUtcMs must be a finite epoch-ms number`);
    }
    const latest = d['latestEndUtcMs'];
    if (latest !== undefined && (typeof latest !== 'number' || !Number.isFinite(latest))) {
      throw new ValidationError(`[scheduling] demand '${id}': latestEndUtcMs must be a finite epoch-ms number`);
    }
    const priority = d['priority'];
    if (priority !== undefined && (typeof priority !== 'number' || !Number.isFinite(priority))) {
      throw new ValidationError(`[scheduling] demand '${id}': priority must be a finite number`);
    }

    demands.push({
      id,
      requiredResourceIds,
      durationMinutes,
      ...(earliest !== undefined ? { earliestStartUtcMs: earliest } : {}),
      ...(latest !== undefined ? { latestEndUtcMs: latest } : {}),
      ...(priority !== undefined ? { priority } : {}),
    });
  }

  return {
    demands,
    base: { start: windowStart, end: windowEnd },
    objective,
    allResourceIds: Array.from(allResources),
  };
}

// ─── Deterministic default seed ───────────────────────────────────────────────

/**
 * deriveSeed — a stable, deterministic default seed from the normalized request.
 * NO Date.now / Math.random: the seed is a pure function of the demand set +
 * window so the same input yields the same proposals. Tests inject their own seed
 * via opts; this is only the fallback. Returns a JS-safe non-negative integer.
 */
export function deriveSeed(norm: NormalizedAutoSchedule): number {
  // FNV-1a over a canonical string encoding of the request.
  const parts: string[] = [`${norm.base.start}:${norm.base.end}:${norm.objective}`];
  for (const d of [...norm.demands].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    parts.push(
      `${d.id}|${d.requiredResourceIds.join(',')}|${d.durationMinutes}|${d.earliestStartUtcMs ?? ''}|${d.latestEndUtcMs ?? ''}|${d.priority ?? 0}`,
    );
  }
  const s = parts.join(';');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Fold to a non-negative JS-safe integer.
  return h >>> 0;
}
