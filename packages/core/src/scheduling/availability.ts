/**
 * scheduling/availability.ts — pure resource operating-hours availability gate
 * + weekly-window → UTC resolver (the `@aeroops/core` half of Slice AV1.1).
 *
 * No I/O, no Drizzle, no React, no clock (`Date.now()`), no randomness, NO
 * timezone library. Timezone conversion (a local wall-clock in an IANA zone →
 * UTC epoch ms) is INJECTED as a `ZonedToUtc` resolver — identical seam to
 * `recurrence.ts` — so this module stays dependency-free, deterministic, and
 * property-testable (the HARD guardrail). The injected `now` is NOT used here:
 * the resolver carries every time conversion; the candidate span is supplied.
 *
 * SHAPE / IDIOM (mirrors the twilight gate's INERT + mutually-exclusive
 * warn/block + STRICT half-open `[open, close)` discipline). The result is the
 * canonical `ok`-arm idiom so the AV1.2 `gatedCreateOccurrence` integration is
 * SYMMETRIC with the twilight step:
 *
 *   { ok: true }                              — contained, or INERT (no windows)
 *   { ok: true,  warns: true,  hits: [...] }  — not contained, mode='warn'
 *   { ok: false, blocks: true, hits: [...] }  — not contained, mode='block'
 *
 * INERT (always `{ ok: true }`) when the resolved window list is null/empty —
 * a resource with zero operating-hours rows (or the operator flag OFF, which the
 * API surfaces as no resolved windows) imposes NO constraint, byte-identical to
 * the pre-AV1 create path.
 *
 * CONTAINMENT: a candidate `[start, end)` is OK iff it is FULLY CONTAINED in the
 * UNION of the resolved windows. Overlapping / adjacent windows are merged into
 * coverage regions first, so a booking that spans two back-to-back windows that
 * together cover it is OK. Anything outside the union is reported in `hits` as
 * the uncovered sub-interval(s), in chronological order.
 *
 * ─── DST (decision 10) — encoded in `resolveAvailabilityWindowsToUtc` ─────────
 * A weekly window is a LOCAL wall-clock band `[startMinute, endMinute)` on a
 * given ISO weekday in an IANA `tz`. Resolving it to a concrete UTC instant can
 * land on a DST transition:
 *   - SPRING-FORWARD gap (nonexistent local time): a window OPEN snaps FORWARD to
 *     the gap END (the first instant that exists); a window CLOSE snaps to the
 *     gap START (the last instant before the jump). This shrinks, never invents,
 *     coverage across the gap.
 *   - FALL-BACK (ambiguous local time, occurs twice): resolves to the EARLIER
 *     instant — identical to recurrence.ts (the injected resolver returns the
 *     earlier `utcMs` for status 'ambiguous').
 * The resolver NEVER reads the ambient zone or a tz lib; it only calls the
 * injected `ZonedToUtc` and, for the gap snap, brackets the gap with a 1-minute
 * probe (see `snapOpen` / `snapClose`). Operator scheduling data, NOT an FAA
 * duty/rest/Part-117 or currency determination ([VERIFY-AV1-A..D]).
 */

import { intervalsOverlap } from './overlap.js';
import type { ZonedToUtc } from './recurrence.js';

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

// ─── Public types (DISTINCT names — avoid colliding with the optimizer's
//     existing `AvailabilityWindow`) ───────────────────────────────────────────

/**
 * A weekly resource operating-hours window, in LOCAL wall-clock minutes within
 * an IANA zone. Mirrors the `resource_availability_window` row (decision 1/2):
 * overnight bands are modeled as TWO rows on consecutive days (no wrap), so the
 * resolver never has to wrap midnight — `endMinute > startMinute` always holds.
 */
export interface ResourceAvailabilityWindow {
  /** ISO weekday 1..7 (Mon..Sun). */
  readonly dayOfWeek: number;
  /** Minutes since local midnight, inclusive open. 0..1439. */
  readonly startMinute: number;
  /** Minutes since local midnight, exclusive close. 1..1440, > startMinute. */
  readonly endMinute: number;
  /** IANA zone the local minutes are interpreted in (e.g. 'America/Chicago'). */
  readonly tz: string;
}

/** A concrete UTC `[open, close)` half-open interval (resolver output). */
export interface ResolvedAvailabilityWindow {
  /** epoch ms, open (inclusive). */
  readonly openUtcMs: number;
  /** epoch ms, close (exclusive). */
  readonly closeUtcMs: number;
}

/** One uncovered sub-interval of the candidate (a portion outside the union). */
export interface AvailabilityHit {
  /** epoch ms, start of the uncovered sub-interval (inclusive). */
  readonly startUtcMs: number;
  /** epoch ms, end of the uncovered sub-interval (exclusive). */
  readonly endUtcMs: number;
}

/** The gate verdict — canonical `ok`-arm idiom (symmetric with twilight). */
export type AvailabilityGateResult =
  | { readonly ok: true }
  | { readonly ok: true; readonly warns: true; readonly hits: AvailabilityHit[] }
  | { readonly ok: false; readonly blocks: true; readonly hits: AvailabilityHit[] };

// ─── resolveAvailabilityWindowsToUtc ──────────────────────────────────────────

/**
 * Resolve weekly local operating-hours windows into concrete UTC `[open, close)`
 * intervals covering the candidate's date span (evaluated in EACH window's own
 * `tz`). PURE — every time conversion goes through the injected `tzResolver`.
 *
 * For each window we enumerate the candidate's covered local calendar dates in
 * that window's zone, keep the ones matching `dayOfWeek`, and resolve the
 * local `[startMinute, endMinute)` band to UTC with the DST rules (decision 10).
 * The span is padded ±1 local day so a window whose UTC projection bleeds across
 * the candidate edges (offset shift) is still captured; downstream containment
 * only cares about the union near the candidate, so extra windows are harmless.
 *
 * @param windows               weekly windows (any tz mix; may be empty)
 * @param candidateStartUtcMs   candidate window start (epoch ms)
 * @param candidateEndUtcMs     candidate window end (epoch ms)
 * @param tzResolver            INJECTED local→UTC resolver (recurrence.ts seam)
 * @returns concrete UTC `[open, close)` intervals (unsorted; gate unions them)
 */
export function resolveAvailabilityWindowsToUtc(
  windows: readonly ResourceAvailabilityWindow[],
  candidateStartUtcMs: number,
  candidateEndUtcMs: number,
  tzResolver: ZonedToUtc,
): ResolvedAvailabilityWindow[] {
  const resolved: ResolvedAvailabilityWindow[] = [];
  if (windows.length === 0) return resolved;

  for (const w of windows) {
    // Defensive validation (DB CHECKs enforce upstream): skip nonsensical rows
    // rather than throw — keep the resolver total.
    if (w.dayOfWeek < 1 || w.dayOfWeek > 7) continue;
    if (w.startMinute < 0 || w.startMinute > 1439) continue;
    if (w.endMinute < 1 || w.endMinute > 1440) continue;
    if (w.endMinute <= w.startMinute) continue;

    for (const date of localDatesInSpan(candidateStartUtcMs, candidateEndUtcMs, w.tz, tzResolver)) {
      if (isoWeekday(date.year, date.month, date.day) !== w.dayOfWeek) continue;

      const openUtcMs = snapOpen(date, w.startMinute, w.tz, tzResolver);
      const closeUtcMs = snapClose(date, w.endMinute, w.tz, tzResolver);

      // After DST snapping a degenerate/empty band can result (open >= close).
      // Drop it — it covers nothing.
      if (openUtcMs >= closeUtcMs) continue;
      resolved.push({ openUtcMs, closeUtcMs });
    }
  }

  return resolved;
}

/**
 * Resolve a local minute-of-day OPEN edge to UTC. Decision 10: a nonexistent
 * (spring-forward gap) open snaps FORWARD to the gap end. We find the gap end by
 * stepping the local clock forward minute-by-minute until a valid local time
 * resolves (the gap is bounded — always < 24h, in practice 60 min), and use its
 * UTC instant. 'ambiguous' → the resolver's earlier instant (earliest valid
 * start). 'valid' → the instant itself.
 */
function snapOpen(
  date: { year: number; month: number; day: number },
  minute: number,
  tz: string,
  tzResolver: ZonedToUtc,
): number {
  let m = minute;
  // Walk forward across the (bounded) gap to the first existing local minute.
  for (let i = 0; i <= 24 * 60; i++) {
    const r = resolveAtMinute(date, m, tz, tzResolver);
    if (r.status !== 'nonexistent') return r.utcMs;
    m += 1;
  }
  // Fully-degenerate fallback (should never happen): use the raw instant.
  return resolveAtMinute(date, minute, tz, tzResolver).utcMs;
}

/**
 * Resolve a local minute-of-day CLOSE edge to UTC. Decision 10: a nonexistent
 * (spring-forward gap) close snaps to the gap START — i.e. step the local clock
 * BACKWARD minute-by-minute until a valid local time resolves, then use the
 * instant ONE minute past it (the last instant that existed before the jump =
 * the gap start). 'ambiguous' → earlier instant. 'valid' → the instant itself.
 */
function snapClose(
  date: { year: number; month: number; day: number },
  minute: number,
  tz: string,
  tzResolver: ZonedToUtc,
): number {
  const direct = resolveAtMinute(date, minute, tz, tzResolver);
  if (direct.status !== 'nonexistent') return direct.utcMs;
  // Walk backward to the last existing local minute before the gap; the gap
  // start instant is one minute past that last-valid local minute.
  let m = minute - 1;
  for (let i = 0; i <= 24 * 60; i++) {
    const r = resolveAtMinute(date, m, tz, tzResolver);
    if (r.status !== 'nonexistent') return r.utcMs + MS_PER_MINUTE;
    m -= 1;
  }
  return direct.utcMs;
}

/**
 * Resolve a {date, minute-of-day} to UTC via the injected resolver. `minute` may
 * exceed 1439 (close at 1440 = next-day 00:00) or go negative (backward gap
 * probe); we normalize into a calendar date + hour:minute first.
 */
function resolveAtMinute(
  date: { year: number; month: number; day: number },
  minute: number,
  tz: string,
  tzResolver: ZonedToUtc,
): { utcMs: number; status: 'valid' | 'nonexistent' | 'ambiguous' } {
  const dayDelta = Math.floor(minute / (24 * 60));
  const minOfDay = minute - dayDelta * 24 * 60;
  const d = dayDelta === 0 ? date : addDays(date, dayDelta);
  return tzResolver({
    year: d.year,
    month: d.month,
    day: d.day,
    hour: Math.floor(minOfDay / 60),
    minute: minOfDay % 60,
    tz,
  });
}

// ─── evaluateAvailabilityGate ─────────────────────────────────────────────────

/**
 * Pure additive availability gate. Mirrors `evaluateTwilightGate`'s INERT +
 * mutually-exclusive warn/block + STRICT half-open semantics.
 *
 * INERT (`{ ok: true }`) when `resolvedUtcWindows` is null/empty.
 *
 * Otherwise the candidate `[start, end)` must be FULLY CONTAINED in the UNION of
 * the resolved windows. If it is, `{ ok: true }`. If not, the uncovered
 * sub-intervals are collected as `hits` and routed by `mode`:
 *   mode='warn'  → { ok: true,  warns: true,  hits }
 *   mode='block' → { ok: false, blocks: true, hits }
 * The ok-case is identical in both modes (mode only matters when NOT contained).
 *
 * @param candidate          the proposed booking window (epoch ms)
 * @param resolvedUtcWindows pre-resolved UTC `[open, close)` windows, or null
 * @param mode               'block' or 'warn'
 */
export function evaluateAvailabilityGate(
  candidate: { candidateStartUtcMs: number; candidateEndUtcMs: number },
  resolvedUtcWindows: readonly ResolvedAvailabilityWindow[] | null,
  mode: 'block' | 'warn',
): AvailabilityGateResult {
  // INERT: no windows configured → no constraint.
  if (resolvedUtcWindows === null || resolvedUtcWindows.length === 0) {
    return { ok: true };
  }

  const { candidateStartUtcMs, candidateEndUtcMs } = candidate;

  // A degenerate/empty candidate ([start, end) with start >= end) covers no
  // instant; treat as trivially contained (nothing to cover). Mirrors
  // intervalsOverlap's empty-interval handling.
  if (candidateStartUtcMs >= candidateEndUtcMs) {
    return { ok: true };
  }

  const hits = uncoveredSubIntervals(candidateStartUtcMs, candidateEndUtcMs, resolvedUtcWindows);

  if (hits.length === 0) {
    return { ok: true };
  }

  if (mode === 'block') {
    return { ok: false, blocks: true, hits };
  }
  return { ok: true, warns: true, hits };
}

// ─── Coverage math (union + difference, half-open) ────────────────────────────

/**
 * The portions of candidate `[start, end)` NOT covered by the union of windows.
 * Computed by merging the windows that overlap the candidate into disjoint
 * coverage regions, then subtracting them from the candidate interval — all
 * STRICT half-open `[)`. Returns chronological, non-empty hits (or [] if fully
 * covered). Adjacent/touching coverage regions are merged (a close exactly at
 * the next open leaves no gap).
 */
function uncoveredSubIntervals(
  start: number,
  end: number,
  windows: readonly ResolvedAvailabilityWindow[],
): AvailabilityHit[] {
  // Keep only windows that actually intersect the candidate and are non-empty.
  const relevant = windows
    .filter((w) => w.openUtcMs < w.closeUtcMs && intervalsOverlap(start, end, w.openUtcMs, w.closeUtcMs))
    .map((w) => ({ open: w.openUtcMs, close: w.closeUtcMs }))
    .sort((a, b) => (a.open !== b.open ? a.open - b.open : a.close - b.close));

  if (relevant.length === 0) {
    return [{ startUtcMs: start, endUtcMs: end }];
  }

  // Merge into disjoint coverage regions. Touching (closeA === openB) merges:
  // there is no uncovered instant between them, so coverage is contiguous.
  const merged: { open: number; close: number }[] = [];
  for (const r of relevant) {
    const last = merged[merged.length - 1];
    if (last && r.open <= last.close) {
      if (r.close > last.close) last.close = r.close;
    } else {
      merged.push({ open: r.open, close: r.close });
    }
  }

  // Subtract merged coverage from [start, end), walking left to right.
  const hits: AvailabilityHit[] = [];
  let cursor = start;
  for (const region of merged) {
    const covStart = Math.max(region.open, start);
    const covEnd = Math.min(region.close, end);
    if (covStart > cursor) {
      hits.push({ startUtcMs: cursor, endUtcMs: covStart });
    }
    if (covEnd > cursor) cursor = covEnd;
    if (cursor >= end) break;
  }
  if (cursor < end) {
    hits.push({ startUtcMs: cursor, endUtcMs: end });
  }

  return hits;
}

// ─── Internal calendar helpers (proleptic Gregorian, fixed-offset UTC ref) ────
//
// Same discipline as recurrence.ts: `Date.UTC` / `getUTC*` are used ONLY as a
// fixed-offset (UTC) calendar calculator to enumerate (year,month,day) triples
// and ISO weekdays. They never read the ambient timezone and never call
// `Date.now()`. Every actual local→UTC instant comes from the injected resolver.

/** Civil ISO weekday (1=Mon..7=Sun) of a calendar date, via UTC reference. */
function isoWeekday(year: number, month: number, day: number): number {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun..6=Sat
  return dow === 0 ? 7 : dow;
}

/** Add `n` whole days to a calendar date, returning a new {year,month,day}. */
function addDays(
  date: { year: number; month: number; day: number },
  n: number,
): { year: number; month: number; day: number } {
  const ms = Date.UTC(date.year, date.month - 1, date.day) + n * MS_PER_DAY;
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/**
 * Enumerate the local calendar dates (in `tz`) the candidate span touches,
 * padded ±1 day. We invert the injected resolver with the same bounded-search
 * idea as recurrence's `localDateOfNowInZone`: find the local date whose local
 * midnight brackets `candidateStartUtcMs`, then walk forward day-by-day until a
 * date's local midnight is past `candidateEndUtcMs`, padding one extra day each
 * side to catch offset-shift bleed.
 */
function localDatesInSpan(
  startUtcMs: number,
  endUtcMs: number,
  tz: string,
  tzResolver: ZonedToUtc,
): Array<{ year: number; month: number; day: number }> {
  const localMidnight = (d: { year: number; month: number; day: number }): number =>
    tzResolver({ ...d, hour: 0, minute: 0, tz }).utcMs;

  // Bracket the start: the local date whose [midnight, nextMidnight) holds start.
  let first = localDateOf(startUtcMs);
  for (let i = 0; i < 4; i++) {
    const m0 = localMidnight(first);
    if (startUtcMs < m0) {
      first = addDays(first, -1);
      continue;
    }
    const m1 = localMidnight(addDays(first, 1));
    if (startUtcMs >= m1) {
      first = addDays(first, 1);
      continue;
    }
    break;
  }

  // Pad one day before to catch a window whose UTC open bled earlier.
  first = addDays(first, -1);

  const dates: Array<{ year: number; month: number; day: number }> = [];
  // Walk forward until a date's local midnight is strictly after the candidate
  // end, plus one pad day. Bounded by the span length in days + slack.
  const maxDays = Math.ceil((endUtcMs - startUtcMs) / MS_PER_DAY) + 4;
  let cur = first;
  for (let i = 0; i <= maxDays + 2; i++) {
    dates.push(cur);
    if (localMidnight(cur) > endUtcMs) break;
    cur = addDays(cur, 1);
  }
  return dates;
}

/** The UTC-rendered calendar date of an instant (fixed-offset render). */
function localDateOf(ms: number): { year: number; month: number; day: number } {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}
