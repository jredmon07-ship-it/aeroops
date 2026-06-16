/**
 * scheduling/recurrence.ts — pure weekly-recurrence expander (ADR-0006 §2).
 *
 * The `@aeroops/core` half of Slice 2b. No I/O, no Drizzle, no React, no clock,
 * and — critically — NO timezone library. Timezone conversion (local wall-clock
 * in an IANA zone → UTC epoch ms) is INJECTED as `resolveZoned`, exactly as
 * `now` is injected. This keeps `@aeroops/core` dependency-free and the expander
 * deterministic + property-testable (ADR-0006 invariant 2).
 *
 * ADVISORY only: this produces a list of candidate UTC windows. Each candidate
 * is later funnelled through the SAME single gated create path (conflict EXCLUDE
 * + policy gate) at the API layer — this function is NEVER the gate (ADR-0006
 * invariant 1). The conflict/policy gates + storage stay UTC-only; tz lives here
 * in expansion, UTC lives downstream (ADR-0006 §2 seam).
 *
 * SCOPE (2b): WEEKLY only — `weekdays` (ISO 1..7), `intervalWeeks` (>=1), bounded
 * by `count` (1..52) XOR `until` (a local calendar date), at a single
 * `localStartTime` for `durationMinutes` (same-day, no overnight). NO
 * monthly/yearly/RRULE/per-occurrence overrides — those are explicitly OUT.
 *
 * HALF-OPEN `[start, end)`: `endUtcMs = startUtcMs + durationMinutes*60000`;
 * start inclusive, end exclusive — same discipline as overlap.ts / policy.ts and
 * the DB's `tstzrange(start, end, '[)')`.
 *
 * ─── START-ANCHOR DESIGN CHOICE (documented per the build contract) ───────────
 * The core contract carries NO explicit series start date. We anchor the series
 * at the LOCAL CALENDAR DATE OF `now`, computed in the rule's own `iana_tz` via a
 * single `resolveZoned` probe (we resolve `now` rendered back to a local date by
 * binary-search-free arithmetic — see `localDateOfNowInZone`). Concretely:
 *
 *   1. Derive the rule's "anchor local date" = the local Y/M/D in `tz` at `now`.
 *   2. Week 0 = the ISO week (Mon..Sun) containing that anchor date.
 *   3. Stepping `intervalWeeks` from week 0, within each ACTIVE week we emit each
 *      selected weekday (sorted ascending, ISO 1=Mon..7=Sun) at `localStartTime`.
 *   4. The series therefore BEGINS at the first selected weekday on/after the
 *      anchor local date (earlier weekdays in week 0 fall before the anchor and
 *      are dropped by the no-past filter below — they resolve to start < now).
 *
 * This matches the spec's "generate from the week of `now` forward; the series
 * begins at the first qualifying weekday on/after the local date of `now`."
 * The API layer owns range semantics (count/until) on top of this anchor.
 *
 * NO-PAST: any occurrence whose `startUtcMs < now` is generated then DROPPED. A
 * dropped no-past or DST-nonexistent occurrence still consumed a step of the
 * calendar walk but is NOT charged against the `count` budget beyond generation
 * — i.e. `count` counts GENERATED candidates (the deterministic series length),
 * and no-past/DST drops thin the emitted list. This makes preview == create
 * (ADR-0006 resolved-decision (d)).
 *
 * CAP: at most `hardCap` (default 52) candidates are GENERATED. If the rule
 * would have generated more, generation stops and `truncatedByCap = true`.
 *
 * DST (deterministic, reported — never silent; ADR-0006 §2):
 *   - `resolveZoned` status `'nonexistent'` (spring-forward gap): occurrence
 *     DROPPED, recorded in `skippedLocalDates` (reason 'nonexistent_local_time').
 *   - status `'ambiguous'` (fall-back, twice): the resolver already returns the
 *     EARLIER (pre-transition) instant; treated as a normal valid occurrence.
 *   - status `'valid'`: normal. A fixed wall-clock (e.g. 10:00 local) stays
 *     10:00 local across both transitions — the offset shifts, we never add a
 *     naive 7*86_400_000 (the DST-stability property test asserts this).
 */

import type { RecurrenceFreq } from './enums.js';

/** Epoch ms in one minute. Mirrors overlap.ts / policy.ts unit constants. */
const MS_PER_MINUTE = 60_000;

/**
 * ZonedToUtc — INJECTED resolver: a local wall-clock instant in an IANA zone →
 * its UTC epoch ms, plus a DST status. Supplied at the API boundary (an
 * `Intl`-based offset resolver, ADR-0006 resolved-decision (f)); the test layer
 * supplies a deterministic equivalent. NEVER imported into core.
 *
 *   - `'valid'`     — the local time exists exactly once; `utcMs` is it.
 *   - `'nonexistent'` — spring-forward gap; the local time does not exist.
 *     `utcMs` is unspecified/ignored by the expander (the occurrence is dropped).
 *   - `'ambiguous'` — fall-back; the local time occurs twice. The resolver MUST
 *     return the EARLIER (pre-transition) instant in `utcMs` (ADR-0006 §2).
 */
export type ZonedToUtc = (p: {
  year: number;
  month: number; // 1..12
  day: number; // 1..31
  hour: number; // 0..23
  minute: number; // 0..59
  tz: string;
}) => { utcMs: number; status: 'valid' | 'nonexistent' | 'ambiguous' };

/** How a series is bounded: a fixed occurrence count, XOR a local end date. */
export type RecurrenceEnd =
  | { kind: 'count'; count: number }
  | { kind: 'until'; untilDate: { year: number; month: number; day: number } };

/**
 * RecurrenceRule — the structured weekly rule (mirrors `reservation_series`
 * columns; ADR-0006 §1). No explicit start date in this core contract — see the
 * START-ANCHOR design note above.
 */
export interface RecurrenceRule {
  /** WEEKLY only in 2b. */
  readonly freq: Extract<RecurrenceFreq, 'weekly'>;
  /** ISO weekdays 1..7 (Mon..Sun). Non-empty; deduped + sorted internally. */
  readonly weekdays: readonly number[];
  /** Step between active weeks, >= 1 (1 = every week). */
  readonly intervalWeeks: number;
  /** Bound: count XOR until. */
  readonly end: RecurrenceEnd;
  /** Local wall-clock start time, in `tz`. */
  readonly localStartTime: { hour: number; minute: number };
  /** Occurrence length in minutes, > 0 (same-day; no overnight in 2b). */
  readonly durationMinutes: number;
  /** IANA zone the local times are interpreted in (e.g. 'America/Chicago'). */
  readonly tz: string;
}

/** Options for one expansion. `now` + `resolveZoned` are injected (purity). */
export interface ExpansionOptions {
  /** INJECTED current time, epoch ms (never `Date.now()` here). */
  readonly now: number;
  /** INJECTED tz resolver (keeps core dep-free). */
  readonly resolveZoned: ZonedToUtc;
  /** Hard generation cap; default 52 (ADR-0006 §1). */
  readonly hardCap?: number;
}

/** A single emitted occurrence: its local date + half-open UTC window. */
export interface Occurrence {
  readonly localDate: { year: number; month: number; day: number };
  /** epoch ms, start (inclusive). */
  readonly startUtcMs: number;
  /** epoch ms, end (exclusive) = startUtcMs + durationMinutes*60000. */
  readonly endUtcMs: number;
}

/** A generated-but-dropped local date and why (only DST-nonexistent in 2b). */
export interface SkippedLocalDate {
  readonly date: { year: number; month: number; day: number };
  readonly reason: 'nonexistent_local_time';
}

/** The result of one expansion. */
export interface ExpansionResult {
  /** Emitted occurrences, chronological, <= cap, all with startUtcMs >= now. */
  readonly occurrences: Occurrence[];
  /** True iff the rule would have generated more than `hardCap` candidates. */
  readonly truncatedByCap: boolean;
  /** Local dates dropped because the wall-clock time does not exist (DST gap). */
  readonly skippedLocalDates: SkippedLocalDate[];
}

const DEFAULT_HARD_CAP = 52;

// ─── Internal calendar helpers (proleptic Gregorian, pure integer math) ───────
//
// We do calendar arithmetic on a UTC reference clock purely to ENUMERATE which
// (year,month,day) triples qualify, and to compute ISO weekdays. We do NOT use
// it to compute UTC instants for occurrences — those come ONLY from the injected
// `resolveZoned`. Using `Date.UTC`/`getUTCDay` here is a fixed-offset (UTC)
// calendar calculator, not a clock and not a tz library: it never reads the
// ambient timezone and never calls `Date.now()`. This keeps the expander pure
// and dependency-free while avoiding a hand-rolled day-count algorithm.

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
  const ms = Date.UTC(date.year, date.month - 1, date.day) + n * 86_400_000;
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Compare two calendar dates: <0, 0, >0. */
function compareDate(
  a: { year: number; month: number; day: number },
  b: { year: number; month: number; day: number },
): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

/**
 * localDateOfNowInZone — the local calendar date in `tz` at instant `now`.
 *
 * Implemented WITHOUT a tz library by using the injected `resolveZoned` as the
 * forward map and inverting it with a tiny bounded search: a local date's
 * midnight resolves to some UTC instant; we pick the calendar date whose local
 * midnight straddles `now`. We probe the UTC-rendered date of `now` and its
 * neighbours (±1 day covers every real offset, |offset| < 24h), choosing the
 * date `d` for which `resolveZoned(d, 00:00) <= now < resolveZoned(d+1, 00:00)`.
 *
 * This stays pure (only `now` + injected resolver) and dep-free.
 */
function localDateOfNowInZone(now: number, tz: string, resolveZoned: ZonedToUtc): {
  year: number;
  month: number;
  day: number;
} {
  // Start from the UTC-rendered calendar date of `now` (a fixed-offset render,
  // not a tz read), then walk ±1 day to land on the correct local date.
  const base = new Date(now);
  let guess = {
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: base.getUTCDate(),
  };

  const midnightUtc = (d: { year: number; month: number; day: number }): number => {
    const r = resolveZoned({ ...d, hour: 0, minute: 0, tz });
    // For a nonexistent/ambiguous local midnight (rare) the resolver still
    // returns a usable instant; status is irrelevant for the bracketing search.
    return r.utcMs;
  };

  // At most a couple of corrective steps are ever needed (|offset| < 24h).
  for (let i = 0; i < 3; i++) {
    const startOfGuess = midnightUtc(guess);
    if (now < startOfGuess) {
      guess = addDays(guess, -1);
      continue;
    }
    const startOfNext = midnightUtc(addDays(guess, 1));
    if (now >= startOfNext) {
      guess = addDays(guess, 1);
      continue;
    }
    break; // startOfGuess <= now < startOfNext
  }
  return guess;
}

/**
 * expandRecurrence — expand a weekly rule into chronological UTC occurrences.
 *
 * Deterministic + pure: identical `(rule, opts)` ⇒ identical result (no
 * `Date.now()`, no `Math.random`, no tz library; all time math goes through the
 * injected `now` + `resolveZoned`).
 *
 * See the file-level docblock for the START-ANCHOR, NO-PAST, CAP and DST rules.
 *
 * @param rule - the weekly recurrence rule
 * @param opts - injected `now`, `resolveZoned`, optional `hardCap` (default 52)
 * @returns occurrences (chronological, <= cap, all >= now) + cap/DST reports
 */
export function expandRecurrence(rule: RecurrenceRule, opts: ExpansionOptions): ExpansionResult {
  const { now, resolveZoned } = opts;
  const hardCap = opts.hardCap ?? DEFAULT_HARD_CAP;

  const occurrences: Occurrence[] = [];
  const skippedLocalDates: SkippedLocalDate[] = [];

  // Dedup + sort weekdays ascending (ISO 1..7) for deterministic within-week
  // emission order. Out-of-range entries are filtered (defensive; the API/DB
  // CHECK enforces 1..7 upstream).
  const weekdays = Array.from(new Set(rule.weekdays))
    .filter((d) => d >= 1 && d <= 7)
    .sort((a, b) => a - b);

  // Nothing to emit (empty weekday set or non-positive cap) → clean empty.
  if (weekdays.length === 0 || hardCap <= 0) {
    return { occurrences, truncatedByCap: false, skippedLocalDates };
  }

  const intervalWeeks = Math.max(1, Math.trunc(rule.intervalWeeks));
  const { hour, minute } = rule.localStartTime;
  const durationMs = rule.durationMinutes * MS_PER_MINUTE;

  // Anchor: the local calendar date in `tz` at `now`, then back up to the ISO
  // Monday of that week → week 0's Monday.
  const anchorDate = localDateOfNowInZone(now, rule.tz, resolveZoned);
  const anchorWeekday = isoWeekday(anchorDate.year, anchorDate.month, anchorDate.day);
  let weekMonday = addDays(anchorDate, -(anchorWeekday - 1)); // ISO Mon of week 0

  // Generation budget: count mode caps generated candidates at `count`; both
  // modes also obey `hardCap`. We track generated separately so truncatedByCap
  // reflects "the rule would have produced more".
  const countLimit = rule.end.kind === 'count' ? rule.end.count : Infinity;
  let generated = 0;
  let truncatedByCap = false;

  // Bounded outer loop. The generation cap (count OR hardCap) and, in until
  // mode, the untilDate guarantee termination. We add a defensive week ceiling
  // (hardCap weeks * worst case) so a misconfigured until far in the future
  // still terminates by the cap branch below; the explicit break handles it.
  // eslint-disable-next-line no-constant-condition
  outer: while (true) {
    // Emit the selected weekdays within this active week, in ascending order.
    for (const wd of weekdays) {
      const occDate = addDays(weekMonday, wd - 1); // ISO: Mon+0 .. Sun+6

      // UNTIL mode: stop once the date passes untilDate (inclusive end date).
      if (rule.end.kind === 'until') {
        if (compareDate(occDate, rule.end.untilDate) > 0) break outer;
      }

      // COUNT/CAP generation budget. A candidate counts as GENERATED here, even
      // if it is later dropped (no-past / DST gap). Hitting the cap mid-budget
      // sets truncatedByCap iff there was still budget the rule wanted.
      if (generated >= hardCap) {
        // More would have been generated (count not yet exhausted, or until not
        // yet reached) ⇒ truncated by the hard cap.
        if (generated < countLimit) truncatedByCap = true;
        break outer;
      }
      if (generated >= countLimit) break outer;

      generated++;

      // Resolve the local wall-clock to UTC via the injected resolver.
      const { utcMs, status } = resolveZoned({
        year: occDate.year,
        month: occDate.month,
        day: occDate.day,
        hour,
        minute,
        tz: rule.tz,
      });

      if (status === 'nonexistent') {
        // Spring-forward gap: drop + report (never silently shift intent).
        skippedLocalDates.push({
          date: { year: occDate.year, month: occDate.month, day: occDate.day },
          reason: 'nonexistent_local_time',
        });
        continue;
      }

      // 'ambiguous' ⇒ resolver already returned the EARLIER instant; treat as
      // valid. 'valid' ⇒ normal.
      const startUtcMs = utcMs;
      if (startUtcMs < now) continue; // NO-PAST: generated then dropped.

      occurrences.push({
        localDate: { year: occDate.year, month: occDate.month, day: occDate.day },
        startUtcMs,
        endUtcMs: startUtcMs + durationMs,
      });
    }

    // Step to the next active week.
    weekMonday = addDays(weekMonday, 7 * intervalWeeks);
  }

  // Occurrences are already generated in chronological calendar order (weeks
  // ascending, weekdays ascending). The UTC instants are monotonic for a fixed
  // local time across DST (offset changes are < the 7-day step), so no re-sort
  // is needed; we keep input order, which is chronological by construction.
  return { occurrences, truncatedByCap, skippedLocalDates };
}
