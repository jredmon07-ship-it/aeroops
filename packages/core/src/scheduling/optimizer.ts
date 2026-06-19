/**
 * scheduling/optimizer.ts — pure intelligent auto-scheduler PROPOSER (Slice 4b §4b.2).
 *
 * The `@aeroops/core` half of Slice 4b. No I/O, no Drizzle, no React, NO clock
 * (`Date.now()`), NO randomness (`Math.random()`), no tz library. The only time
 * input is the injected `now`; the only source of tie-break entropy is the
 * injected integer `seed`. Same `(input, seed, now)` ⇒ deep-equal `ProposalSet`.
 *
 * ─── WHAT THIS IS (and is NOT) ────────────────────────────────────────────────
 * ADVISORY ONLY. `proposeSchedule` produces a SELF-CONSISTENT set of proposals:
 * no two emitted proposals that share a resource overlap (half-open `[)`), every
 * proposal lies inside an availability window for each of its required resources,
 * inside its earliest/latest bounds, and inside any twilight boundary handed in.
 * It is NOT the authoritative gate. The api orchestrator (`runAutoSchedule`,
 * a SEPARATE ticket) re-checks every proposal through the FROZEN
 * `gatedCreateOccurrence` (conflict EXCLUDE + policy + grounding + twilight), so
 * the Postgres EXCLUDE constraint — not this function — is the no-double-book
 * guarantee. A proposal may still be refused at commit if reality drifted (a
 * concurrent booking, a blackout, etc.); that is expected and handled downstream.
 *
 * This module REUSES the FROZEN half-open overlap predicate `intervalsOverlap`
 * (ADR-0004) for every conflict test — it does NOT reimplement interval math.
 *
 * ─── ALGORITHM: deterministic greedy + bounded backtracking ───────────────────
 * 1. Sort demands by (priority DESC, durationMinutes DESC, id ASC). The id tie-
 *    break is total + stable, so the order is fully deterministic; `seed` only
 *    perturbs the *candidate-window scan order* within a demand (see below), never
 *    the demand order, so accounting + determinism stay simple to reason about.
 * 2. For each demand in that order, find the EARLIEST feasible placement: a
 *    `durationMinutes`-long window [s, s+dur) such that for EVERY required
 *    resource (a) [s, e) ⊆ some AvailabilityWindow for that resource, (b) [s, e)
 *    does not overlap any already-emitted proposal sharing that resource,
 *    (c) s ≥ earliestStartUtcMs (if set) and e ≤ latestEndUtcMs (if set), and
 *    (d) the twilight boundary holds for that resource (s ≥ civilDawn when set,
 *    e ≤ civilDusk when set; a null boundary = no limit that direction).
 *    Candidate start instants are the finite set of "event" boundaries (window
 *    starts, the earliest-bound, existing-proposal ends, twilight dawn) — the
 *    earliest-placement optimum always sits flush against one of these.
 * 3. If no placement exists, BOUNDED BACKTRACK: try displacing one already-placed
 *    demand of STRICTLY LOWER priority that shares a resource, remove it, place
 *    the current demand, then re-place the displaced one later. Bounded to
 *    `MAX_BACKTRACK_DEPTH` displacement attempts per demand.
 * 4. If still no placement → `unschedulable`: `no_feasible_window` when the demand
 *    has NO geometrically feasible window at all (ignoring other proposals);
 *    `over_constrained` when feasible windows EXIST but every one collides with a
 *    higher-or-equal-priority placement that could not be displaced.
 *
 * TERMINATION (hard guardrail, like recurrence's hardCap): a global
 * `MAX_TOTAL_ATTEMPTS` budget caps total placement+backtrack work. The outer loop
 * is one pass over a finite demand list; each demand's placement search is over a
 * finite, deduped candidate-start set; backtracking is depth-bounded and never
 * re-displaces the same demand twice within one demand's attempt (a visited set).
 * Pathological/over-constrained inputs therefore complete well under the cap and
 * the function is TOTAL.
 *
 * `objective` ('maximize_utilization' | 'maximize_sessions_scheduled') currently
 * selects the same earliest-fit greedy (both are served by "place as many as
 * possible, earliest-first"); it is threaded for forward compatibility and to
 * keep the api contract stable. Documented: today both behave identically; a
 * future utilization-weighted tie-break would key off `seed` only.
 */

import { intervalsOverlap } from './overlap.js';

// ─── Public types (mirror the api/spec contract; §4b.2) ───────────────────────

/** One scheduling demand: a session needing a set of resources for a duration. */
export interface DemandRequest {
  readonly id: string;
  /** Every resource this session must hold simultaneously (aircraft, instructor…). */
  readonly requiredResourceIds: string[];
  /** Session length in minutes, > 0. */
  readonly durationMinutes: number;
  /** Earliest acceptable START, epoch ms (inclusive). Optional = unbounded below. */
  readonly earliestStartUtcMs?: number;
  /** Latest acceptable END, epoch ms (inclusive of the end instant). Optional = unbounded above. */
  readonly latestEndUtcMs?: number;
  /** Higher = scheduled first / harder to displace. Default 0. */
  readonly priority?: number;
}

/** A bookable window for ONE resource: [startUtcMs, endUtcMs) half-open. */
export interface AvailabilityWindow {
  readonly resourceId: string;
  readonly startUtcMs: number;
  readonly endUtcMs: number;
}

/**
 * Optional per-resource twilight limits (from Slice 4a). A `null` boundary means
 * "no limit in that direction" (e.g. polar day, no coords, config off — the 4a
 * gate is INERT). Only meaningful for aircraft resources; non-aircraft resources
 * simply have no entry and are unconstrained by twilight.
 */
export interface PerResourceTwilight {
  readonly resourceId: string;
  /** Bookings must START at or after this instant (epoch ms). null = no lower limit. */
  readonly civilDawnUtcMs: number | null;
  /** Bookings must END at or before this instant (epoch ms). null = no upper limit. */
  readonly civilDuskUtcMs: number | null;
}

/** One emitted proposal: a demand placed at a concrete half-open window. */
export interface ProposedOccurrence {
  readonly demandId: string;
  readonly resourceIds: string[];
  /** epoch ms, start (inclusive). */
  readonly startUtcMs: number;
  /** epoch ms, end (exclusive) = startUtcMs + durationMinutes*60000. */
  readonly endUtcMs: number;
}

/** The full advisory output: placed proposals + accounted-for failures. */
export interface ProposalSet {
  readonly proposals: ProposedOccurrence[];
  readonly unschedulable: Array<{
    demandId: string;
    reason: 'no_feasible_window' | 'over_constrained';
  }>;
}

// ─── Caps (termination guardrail; mirrors recurrence's hardCap discipline) ─────

const MS_PER_MINUTE = 60_000;

/** Max displacement attempts when backtracking to place one demand. */
const MAX_BACKTRACK_DEPTH = 8;

/**
 * Global ceiling on total placement-search "events" considered across the whole
 * run. Generous (covers large but sane inputs) yet finite — guarantees the
 * function terminates on pathological/adversarial inputs. Once exhausted, any
 * remaining unplaced demand is reported `over_constrained` rather than looping.
 */
const MAX_TOTAL_ATTEMPTS = 1_000_000;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** A small, fast, deterministic integer hash for seed-derived tie ordering. */
function mix(seed: number, n: number): number {
  // xorshift-ish mixing; pure integer math, no Math.random.
  let x = (seed ^ (n * 0x9e3779b1)) >>> 0;
  x ^= x << 13;
  x >>>= 0;
  x ^= x >>> 17;
  x ^= x << 5;
  x >>>= 0;
  return x;
}

/** Internal placement: a demand pinned to a window, with its resolved fields. */
interface Placement {
  readonly demandId: string;
  readonly resourceIds: string[];
  readonly startUtcMs: number;
  readonly endUtcMs: number;
  readonly priority: number;
}

/** A demand normalized with defaults + derived duration-ms. */
interface NormDemand {
  readonly id: string;
  readonly resourceIds: string[];
  readonly durationMs: number;
  readonly earliest: number | null;
  readonly latest: number | null;
  readonly priority: number;
}

/**
 * Does interval [s, e) fit ENTIRELY inside ANY availability window for `resId`?
 * Half-open containment: s >= win.start && e <= win.end. Adjacent window edges
 * are honored (end exclusive). Returns false if the resource has no windows.
 */
function fitsSomeWindow(
  s: number,
  e: number,
  resId: string,
  windowsByResource: Map<string, AvailabilityWindow[]>,
): boolean {
  const wins = windowsByResource.get(resId);
  if (!wins) return false;
  for (const w of wins) {
    if (s >= w.startUtcMs && e <= w.endUtcMs) return true;
  }
  return false;
}

/**
 * Twilight check for one resource at [s, e). Honors a null boundary as "no
 * limit". Resources with no twilight entry are unconstrained.
 */
function twilightOk(
  s: number,
  e: number,
  resId: string,
  twilightByResource: Map<string, PerResourceTwilight>,
): boolean {
  const tw = twilightByResource.get(resId);
  if (!tw) return true;
  if (tw.civilDawnUtcMs !== null && s < tw.civilDawnUtcMs) return false;
  if (tw.civilDuskUtcMs !== null && e > tw.civilDuskUtcMs) return false;
  return true;
}

// ─── proposeSchedule ──────────────────────────────────────────────────────────

/**
 * proposeSchedule — pure, deterministic greedy-with-bounded-backtracking
 * auto-scheduler PROPOSER. See the module docblock for the full algorithm,
 * advisory semantics, and termination guarantee.
 *
 * @returns a self-consistent `ProposalSet`: every demand id appears EXACTLY once
 *          across `proposals` ∪ `unschedulable` (total accounting), no two
 *          emitted proposals share a resource and overlap, and every proposal
 *          honors its availability / bounds / twilight constraints.
 */
export function proposeSchedule(input: {
  demands: DemandRequest[];
  availability: AvailabilityWindow[];
  twilightBoundaries?: PerResourceTwilight[];
  objective: 'maximize_utilization' | 'maximize_sessions_scheduled';
  seed: number;
  now: number;
}): ProposalSet {
  const { demands, availability, twilightBoundaries, seed, now } = input;

  // ── Index availability per resource, windows sorted by start (earliest-first). ──
  const windowsByResource = new Map<string, AvailabilityWindow[]>();
  for (const w of availability) {
    // Skip degenerate/empty windows defensively (start >= end is the empty set).
    if (w.startUtcMs >= w.endUtcMs) continue;
    const list = windowsByResource.get(w.resourceId);
    if (list) list.push(w);
    else windowsByResource.set(w.resourceId, [w]);
  }
  for (const list of windowsByResource.values()) {
    list.sort((a, b) => a.startUtcMs - b.startUtcMs || a.endUtcMs - b.endUtcMs);
  }

  // ── Index twilight per resource. ──
  const twilightByResource = new Map<string, PerResourceTwilight>();
  for (const t of twilightBoundaries ?? []) {
    twilightByResource.set(t.resourceId, t);
  }

  // ── Normalize + deterministically order demands. ──
  // Order: priority DESC, durationMinutes DESC, id ASC. Stable + total (id is the
  // final unique tiebreak), so demand order is fully deterministic and seed-free.
  const norm: NormDemand[] = demands.map((d) => ({
    id: d.id,
    resourceIds: d.requiredResourceIds.slice(),
    durationMs: d.durationMinutes * MS_PER_MINUTE,
    earliest: d.earliestStartUtcMs ?? null,
    latest: d.latestEndUtcMs ?? null,
    priority: d.priority ?? 0,
  }));
  norm.sort(
    (a, b) =>
      b.priority - a.priority ||
      b.durationMs - a.durationMs ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const placements: Placement[] = [];
  const unschedulable: ProposalSet['unschedulable'] = [];

  let attempts = 0;

  /**
   * Compute the ordered, deduped set of candidate START instants for `d`, given
   * the current `activePlacements` (used so backtracking sees a reduced set).
   * Candidate starts are window starts, the earliest bound, twilight dawn, and
   * the END of each active placement sharing a resource — clamped to feasibility.
   * The earliest-fit optimum is always flush against one of these.
   */
  function candidateStarts(d: NormDemand, activePlacements: Placement[]): number[] {
    const set = new Set<number>();
    const lowerBound = d.earliest ?? -Infinity;

    const consider = (t: number): void => {
      if (t >= lowerBound) set.add(t);
    };

    for (const resId of d.resourceIds) {
      const wins = windowsByResource.get(resId);
      if (wins) for (const w of wins) consider(w.startUtcMs);
      const tw = twilightByResource.get(resId);
      if (tw && tw.civilDawnUtcMs !== null) consider(tw.civilDawnUtcMs);
    }
    if (d.earliest !== null) set.add(d.earliest);

    // Push-against the end of every active placement that shares a resource: a
    // back-to-back slot may be the earliest feasible one.
    const myResources = new Set(d.resourceIds);
    for (const p of activePlacements) {
      if (p.resourceIds.some((r) => myResources.has(r))) consider(p.endUtcMs);
    }

    // Earliest-first.
    return Array.from(set).sort((a, b) => a - b);
  }

  /** Is [s, s+dur) a fully feasible placement for `d` against `activePlacements`? */
  function feasibleAt(
    d: NormDemand,
    s: number,
    activePlacements: Placement[],
  ): boolean {
    const e = s + d.durationMs;
    if (d.earliest !== null && s < d.earliest) return false;
    if (d.latest !== null && e > d.latest) return false;
    for (const resId of d.resourceIds) {
      if (!fitsSomeWindow(s, e, resId, windowsByResource)) return false;
      if (!twilightOk(s, e, resId, twilightByResource)) return false;
    }
    // No overlap with any active placement sharing a resource (half-open).
    const myResources = new Set(d.resourceIds);
    for (const p of activePlacements) {
      if (!p.resourceIds.some((r) => myResources.has(r))) continue;
      if (intervalsOverlap(s, e, p.startUtcMs, p.endUtcMs)) return false;
    }
    return true;
  }

  /**
   * Does `d` have ANY geometrically feasible window at all (ignoring other
   * placements)? Distinguishes `no_feasible_window` from `over_constrained`.
   */
  function hasAnyFeasibleWindow(d: NormDemand): boolean {
    for (const s of candidateStarts(d, [])) {
      attempts++;
      if (attempts > MAX_TOTAL_ATTEMPTS) return false;
      if (feasibleAt(d, s, [])) return true;
    }
    return false;
  }

  /**
   * Find the earliest feasible start for `d` against `activePlacements`, scanning
   * candidate starts earliest-first. `seed` perturbs only the tie order among
   * EQUAL starts (there are none after dedup, so it is a no-op today) — kept for
   * the documented forward-compat seam. Returns null if none.
   */
  function earliestFeasible(d: NormDemand, activePlacements: Placement[]): number | null {
    const starts = candidateStarts(d, activePlacements);
    // Deterministic seed-derived stable order among equal keys (currently all
    // starts are distinct post-dedup; this keeps the seam honest + pure).
    starts.sort((a, b) => a - b || mix(seed, a) - mix(seed, b));
    for (const s of starts) {
      attempts++;
      if (attempts > MAX_TOTAL_ATTEMPTS) return null;
      if (feasibleAt(d, s, activePlacements)) return s;
    }
    return null;
  }

  // ── Greedy pass with bounded backtracking. ──
  for (const d of norm) {
    if (d.resourceIds.length === 0 || d.durationMs <= 0) {
      // A demand with no resources or non-positive duration has no real window.
      unschedulable.push({ demandId: d.id, reason: 'no_feasible_window' });
      continue;
    }

    // Quick geometric feasibility: if there is NO window anywhere, it's
    // structurally unschedulable regardless of other placements.
    if (!hasAnyFeasibleWindow(d)) {
      unschedulable.push({ demandId: d.id, reason: 'no_feasible_window' });
      continue;
    }

    // Direct earliest-fit against all current placements.
    const direct = earliestFeasible(d, placements);
    if (direct !== null) {
      placements.push({
        demandId: d.id,
        resourceIds: d.resourceIds,
        startUtcMs: direct,
        endUtcMs: direct + d.durationMs,
        priority: d.priority,
      });
      continue;
    }

    // ── BOUNDED BACKTRACK ──────────────────────────────────────────────────────
    // Feasible windows exist but all collide. Try displacing already-placed demands
    // of STRICTLY LOWER priority that share a resource with `d`. For each, remove
    // it, attempt to place `d`, then attempt to re-place the displaced demand
    // elsewhere; if both succeed, commit. Depth-bounded; never re-displaces the
    // same victim twice (visited set) so it always terminates.
    const placed = tryBacktrack(d);
    if (!placed) {
      // Windows existed (hasAnyFeasibleWindow true) but every slot is taken by
      // equal/higher priority that couldn't be displaced ⇒ over-constrained.
      unschedulable.push({ demandId: d.id, reason: 'over_constrained' });
    }
  }

  /**
   * Bounded backtracking placement for `d`. Mutates `placements` only on success.
   * Returns true iff `d` (and any displaced victim) were all placed.
   */
  function tryBacktrack(d: NormDemand): boolean {
    const myResources = new Set(d.resourceIds);

    // Candidate victims: lower-priority placements sharing a resource, ordered by
    // priority ASC (cheapest to displace first), then by start DESC, then id ASC
    // for determinism.
    const victims = placements
      .filter(
        (p) =>
          p.priority < d.priority &&
          p.resourceIds.some((r) => myResources.has(r)),
      )
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          b.startUtcMs - a.startUtcMs ||
          (a.demandId < b.demandId ? -1 : a.demandId > b.demandId ? 1 : 0),
      );

    let depth = 0;
    for (const victim of victims) {
      if (depth >= MAX_BACKTRACK_DEPTH) break;
      depth++;
      attempts++;
      if (attempts > MAX_TOTAL_ATTEMPTS) return false;

      // Remove the victim, try to place d, then re-place the victim.
      const without = placements.filter((p) => p !== victim);
      const dStart = earliestFeasible(d, without);
      if (dStart === null) continue;

      const dPlacement: Placement = {
        demandId: d.id,
        resourceIds: d.resourceIds,
        startUtcMs: dStart,
        endUtcMs: dStart + d.durationMs,
        priority: d.priority,
      };

      // Re-place the victim against (without + d).
      const victimDemand: NormDemand = {
        id: victim.demandId,
        resourceIds: victim.resourceIds,
        durationMs: victim.endUtcMs - victim.startUtcMs,
        // Reconstruct bounds from the demand list (the victim originally fit them).
        earliest: null,
        latest: null,
        priority: victim.priority,
      };
      const orig = demands.find((x) => x.id === victim.demandId);
      const victimNorm: NormDemand = orig
        ? {
            ...victimDemand,
            earliest: orig.earliestStartUtcMs ?? null,
            latest: orig.latestEndUtcMs ?? null,
          }
        : victimDemand;

      const reStart = earliestFeasible(victimNorm, [...without, dPlacement]);
      if (reStart === null) continue;

      // Both placed — commit the swap.
      const replaced: Placement = { ...victim, startUtcMs: reStart, endUtcMs: reStart + victimNorm.durationMs };
      placements.length = 0;
      placements.push(...without, dPlacement, replaced);
      return true;
    }
    return false;
  }

  // ── Emit. Sort proposals deterministically (start ASC, demandId ASC). ──
  const proposals: ProposedOccurrence[] = placements
    .map((p) => ({
      demandId: p.demandId,
      resourceIds: p.resourceIds,
      startUtcMs: p.startUtcMs,
      endUtcMs: p.endUtcMs,
    }))
    .sort(
      (a, b) =>
        a.startUtcMs - b.startUtcMs ||
        (a.demandId < b.demandId ? -1 : a.demandId > b.demandId ? 1 : 0),
    );

  // Total accounting: ensure every demand id is in exactly one bucket. (Defensive
  // — by construction each demand is either placed or pushed to unschedulable.)
  unschedulable.sort((a, b) => (a.demandId < b.demandId ? -1 : a.demandId > b.demandId ? 1 : 0));

  // `now` is part of the pure signature (forward-compat: a future rule could
  // refuse past-now placements). Referenced to keep the contract honest without
  // affecting today's purely window-driven placement.
  void now;

  return { proposals, unschedulable };
}
