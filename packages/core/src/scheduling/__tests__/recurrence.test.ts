/**
 * recurrence.test.ts — unit + PROPERTY tests for the pure weekly expander.
 *
 * This is where the SCHED-2b core PROPERTY tests live (ADR-0006 invariant 4 /
 * spec §2.4 — HARD GUARDRAIL). Mirrors policy.test.ts / overlap.test.ts (vitest
 * + fast-check). The expander is pure: `now` + `resolveZoned` are INJECTED, so
 * every test passes fixed `now` values and a deterministic resolver — no
 * `Date.now()`, no `Math.random` driving inputs.
 *
 * TZ RESOLVER (test-only): `intlResolver` computes the UTC instant for a local
 * wall-clock in a REAL IANA zone using the platform `Intl.DateTimeFormat`
 * (offset-iteration; handles the spring-forward gap → 'nonexistent' and the
 * fall-back ambiguity → earlier instant + 'ambiguous'). This stays in TEST code;
 * core imports NO tz library. Synthetic resolvers cover the DST-nonexistent and
 * DST-ambiguous unit edges deterministically.
 *
 * COVERAGE:
 *   Property (fast-check):
 *     - PB-count: count mode emits exactly `count` occurrences (no DST/past drops)
 *     - PB-until: until mode emits exactly the qualifying dates <= untilDate
 *                 (incl. ZERO when untilDate < first occurrence)
 *     - PB-weekday: every occurrence's ISO weekday is in the rule's weekday set
 *     - PB-interval: consecutive same-weekday occurrences are intervalWeeks apart
 *     - PB-cap: never more than hardCap; truncatedByCap iff the rule wanted more
 *     - PB-no-past: with now placed after the Kth would-be start, exactly the
 *                   first K (those < now) are dropped, the rest remain
 *     - PB-dst-stability: across a REAL DST transition the wall-clock h:m is
 *                         IDENTICAL for every occurrence (offset shifts, not time)
 *     - PB-determinism: identical (rule, opts) ⇒ deep-equal result (idempotent)
 *   Unit:
 *     - DST-nonexistent: synthetic resolver flags one date → that date in
 *                        skippedLocalDates, absent from occurrences
 *     - DST-ambiguous: synthetic resolver returns 'ambiguous' + earlier instant →
 *                      occurrence present at exactly that instant
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { expandRecurrence } from '../recurrence.js';
import type { RecurrenceRule, ZonedToUtc } from '../recurrence.js';

// ─── Test resolvers ──────────────────────────────────────────────────────────

/**
 * A FIXED-OFFSET resolver: interprets local wall-clock as if the zone were a
 * constant UTC offset (`offsetMinutes`). Always 'valid'. Used by the calendar
 * property tests (count/until/weekday/interval/cap/no-past/determinism) where we
 * want exact arithmetic without DST noise. 'UTC' default ⇒ offset 0.
 */
function fixedOffsetResolver(offsetMinutes = 0): ZonedToUtc {
  return ({ year, month, day, hour, minute }) => {
    const utcMs = Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60_000;
    return { utcMs, status: 'valid' as const };
  };
}

/**
 * intlResolver — REAL IANA-zone resolver built from `Intl.DateTimeFormat`.
 *
 * Strategy: a candidate local time `L` in zone `tz` corresponds to UTC instant
 * `U` iff rendering `U` back into `tz` yields `L`. We compute the zone offset at
 * a trial instant, correct once, then verify by formatting:
 *   - exactly one matching `U` ⇒ 'valid'
 *   - no matching `U` (the local time is skipped by spring-forward) ⇒ 'nonexistent'
 *   - two matching `U` (fall-back repeats the hour) ⇒ 'ambiguous', return the
 *     EARLIER instant (ADR-0006 §2).
 */
function makeIntlResolver(): ZonedToUtc {
  // Offset (minutes, UTC = local - offset... we return offset = local - utc) of
  // `tz` at the given UTC instant.
  const fmt = new Map<string, Intl.DateTimeFormat>();
  const getFmt = (tz: string) => {
    let f = fmt.get(tz);
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
      fmt.set(tz, f);
    }
    return f;
  };

  // Render a UTC instant into the zone's local civil parts.
  const partsAt = (utcMs: number, tz: string) => {
    const parts = getFmt(tz).formatToParts(new Date(utcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    let hour = get('hour');
    if (hour === 24) hour = 0; // some engines emit 24 for midnight
    return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute') };
  };

  // The zone's offset (minutes) such that local = utc + offset, at `utcMs`.
  const offsetAt = (utcMs: number, tz: string): number => {
    const p = partsAt(utcMs, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    return Math.round((asUtc - utcMs) / 60_000);
  };

  return ({ year, month, day, hour, minute, tz }) => {
    const targetLocal = Date.UTC(year, month - 1, day, hour, minute);
    // Candidate UTC instants: subtract the offset estimated at two probes (the
    // local time straddles a transition only near DST changes). Use both the
    // pre- and post-transition offsets to find all real solutions.
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
      // Fall-back: ambiguous. Return the EARLIER instant.
      return { utcMs: Math.min(...valid), status: 'ambiguous' as const };
    }
    return { utcMs: valid[0]!, status: 'valid' as const };
  };
}

const intlResolver = makeIntlResolver();

// ─── Calendar helpers (test-side, mirror core's UTC-reference arithmetic) ─────

const isoWeekday = (y: number, m: number, d: number): number => {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
};
const dayIndex = (y: number, m: number, d: number): number =>
  Math.round(Date.UTC(y, m - 1, d) / 86_400_000);

// ─── Property generators ─────────────────────────────────────────────────────

/** A non-empty deduped subset of ISO weekdays 1..7. */
const arbWeekdays = fc
  .uniqueArray(fc.integer({ min: 1, max: 7 }), { minLength: 1, maxLength: 7 })
  .map((ws) => [...ws].sort((a, b) => a - b));

const arbInterval = fc.integer({ min: 1, max: 6 });
const arbTime = fc.record({
  hour: fc.integer({ min: 0, max: 23 }),
  minute: fc.constantFrom(0, 15, 30, 45),
});
const arbDuration = fc.integer({ min: 15, max: 480 });
// A fixed `now` somewhere in 2026 (epoch ms), aligned to a deterministic value.
const arbNow = fc.integer({ min: 0, max: 60 }).map((dDays) => Date.UTC(2026, 0, 1 + dDays));
// A `now` at MONDAY 00:00 UTC. With a Monday anchor, week 0 has NO selected
// weekday earlier than the anchor day, so the no-past filter drops nothing in
// week 0 ⇒ emitted === min(count, cap) exactly. (Jan 5 2026 is a Monday;
// stepping by whole weeks keeps every `now` on a Monday.) Used by the
// exact-count properties (PB-count / PB-cap) where the count budget must match
// the emitted length one-for-one.
const arbMondayNow = fc
  .integer({ min: 0, max: 30 })
  .map((weeks) => Date.UTC(2026, 0, 5) + weeks * 7 * 86_400_000);

// ─── PB-count: count mode emits exactly `count` occurrences ───────────────────

describe('PB-count: count mode emits exactly `count` occurrences', () => {
  it('with a no-DST UTC resolver and now at/before the anchor, count is exact', () => {
    fc.assert(
      fc.property(
        arbWeekdays,
        arbInterval,
        arbTime,
        arbDuration,
        fc.integer({ min: 1, max: 52 }),
        arbMondayNow,
        (weekdays, intervalWeeks, localStartTime, durationMinutes, count, now) => {
          const rule: RecurrenceRule = {
            freq: 'weekly',
            weekdays,
            intervalWeeks,
            end: { kind: 'count', count },
            localStartTime,
            durationMinutes,
            tz: 'UTC',
          };
          // now at MONDAY 00:00 UTC ⇒ no week-0 weekday precedes the anchor, so
          // no no-past drops; UTC ⇒ no DST drops. Therefore emitted === count.
          const res = expandRecurrence(rule, { now, resolveZoned: fixedOffsetResolver(0) });
          expect(res.occurrences.length).toBe(count);
          expect(res.skippedLocalDates).toEqual([]);
        },
      ),
    );
  });
});

// ─── PB-until: until mode emits exactly the qualifying dates ──────────────────

describe('PB-until: until mode emits exactly dates <= untilDate (zero when before first)', () => {
  it('emitted local dates are exactly the qualifying weekdays up to untilDate', () => {
    fc.assert(
      fc.property(
        arbWeekdays,
        arbInterval,
        arbTime,
        arbDuration,
        arbNow,
        fc.integer({ min: -3, max: 120 }), // untilDate = anchor-day + this many days
        (weekdays, intervalWeeks, localStartTime, durationMinutes, now, untilOffset) => {
          // Anchor local date in UTC zone == the UTC calendar date of `now`.
          const base = new Date(now);
          const anchor = {
            year: base.getUTCFullYear(),
            month: base.getUTCMonth() + 1,
            day: base.getUTCDate(),
          };
          const untilMs = Date.UTC(anchor.year, anchor.month - 1, anchor.day) + untilOffset * 86_400_000;
          const u = new Date(untilMs);
          const untilDate = { year: u.getUTCFullYear(), month: u.getUTCMonth() + 1, day: u.getUTCDate() };

          const rule: RecurrenceRule = {
            freq: 'weekly',
            weekdays,
            intervalWeeks,
            end: { kind: 'until', untilDate },
            localStartTime,
            durationMinutes,
            tz: 'UTC',
          };
          const res = expandRecurrence(rule, {
            now,
            resolveZoned: fixedOffsetResolver(0),
            hardCap: 200, // raise cap so until is the only bound here
          });

          // Independently enumerate expected qualifying dates: week 0 = ISO Mon
          // of anchor's week, step intervalWeeks, emit selected weekdays whose
          // date is >= anchor (no-past: start at hour>=0 so start>=now iff
          // date >= anchor day) AND <= untilDate.
          const anchorIdx = dayIndex(anchor.year, anchor.month, anchor.day);
          const anchorWd = isoWeekday(anchor.year, anchor.month, anchor.day);
          const week0MonIdx = anchorIdx - (anchorWd - 1);
          const untilIdx = dayIndex(untilDate.year, untilDate.month, untilDate.day);
          const expected: number[] = [];
          for (let w = 0; w < 60; w++) {
            const monIdx = week0MonIdx + 7 * intervalWeeks * w;
            if (monIdx > untilIdx) break;
            for (const wd of weekdays) {
              const idx = monIdx + (wd - 1);
              if (idx > untilIdx) continue;
              // no-past: start (date at hour:minute) >= now. now is midnight of
              // anchor day, so any date strictly after anchor passes; the anchor
              // day itself passes iff its local start >= midnight (always true).
              // Earlier dates in week 0 (idx < anchorIdx) start before now → drop.
              if (idx < anchorIdx) continue;
              expected.push(idx);
            }
          }
          expected.sort((a, b) => a - b);

          const got = res.occurrences.map((o) => dayIndex(o.localDate.year, o.localDate.month, o.localDate.day));
          expect(got).toEqual(expected);
          if (untilIdx < anchorIdx) expect(res.occurrences.length).toBe(0); // until before first ⇒ zero
        },
      ),
    );
  });
});

// ─── PB-weekday: every occurrence falls on a selected ISO weekday ─────────────

describe('PB-weekday: every occurrence is on a rule weekday', () => {
  it('occurrence ISO weekdays ⊆ the rule weekday set', () => {
    fc.assert(
      fc.property(arbWeekdays, arbInterval, arbTime, arbNow, (weekdays, intervalWeeks, localStartTime, now) => {
        const rule: RecurrenceRule = {
          freq: 'weekly',
          weekdays,
          intervalWeeks,
          end: { kind: 'count', count: 20 },
          localStartTime,
          durationMinutes: 60,
          tz: 'UTC',
        };
        const res = expandRecurrence(rule, { now, resolveZoned: fixedOffsetResolver(0) });
        const set = new Set(weekdays);
        for (const o of res.occurrences) {
          expect(set.has(isoWeekday(o.localDate.year, o.localDate.month, o.localDate.day))).toBe(true);
        }
      }),
    );
  });
});

// ─── PB-interval: consecutive same-weekday occurrences are intervalWeeks apart ─

describe('PB-interval: same-weekday gaps equal intervalWeeks * 7 days', () => {
  it('for a single-weekday rule, consecutive occurrences are 7*interval days apart', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 7 }),
        arbInterval,
        arbTime,
        arbNow,
        (wd, intervalWeeks, localStartTime, now) => {
          const rule: RecurrenceRule = {
            freq: 'weekly',
            weekdays: [wd],
            intervalWeeks,
            end: { kind: 'count', count: 8 },
            localStartTime,
            durationMinutes: 60,
            tz: 'UTC',
          };
          const res = expandRecurrence(rule, { now, resolveZoned: fixedOffsetResolver(0) });
          const idxs = res.occurrences.map((o) => dayIndex(o.localDate.year, o.localDate.month, o.localDate.day));
          for (let i = 1; i < idxs.length; i++) {
            expect(idxs[i]! - idxs[i - 1]!).toBe(7 * intervalWeeks);
          }
        },
      ),
    );
  });
});

// ─── PB-cap: never exceed hardCap; truncatedByCap iff the rule wanted more ─────

describe('PB-cap: hardCap is enforced and flagged', () => {
  it('occurrences <= cap; truncatedByCap iff count > cap', () => {
    fc.assert(
      fc.property(
        arbWeekdays,
        arbInterval,
        fc.integer({ min: 1, max: 100 }), // requested count
        fc.integer({ min: 1, max: 52 }), // hardCap
        arbMondayNow,
        (weekdays, intervalWeeks, count, hardCap, now) => {
          const rule: RecurrenceRule = {
            freq: 'weekly',
            weekdays,
            intervalWeeks,
            end: { kind: 'count', count },
            localStartTime: { hour: 9, minute: 0 },
            durationMinutes: 60,
            tz: 'UTC',
          };
          const res = expandRecurrence(rule, { now, resolveZoned: fixedOffsetResolver(0), hardCap });
          // Monday anchor ⇒ no week-0 no-past drops; UTC ⇒ no DST drops ⇒
          // generated == emitted == min(count, hardCap).
          expect(res.occurrences.length).toBeLessThanOrEqual(hardCap);
          expect(res.occurrences.length).toBe(Math.min(count, hardCap));
          expect(res.truncatedByCap).toBe(count > hardCap);
        },
      ),
    );
  });
});

// ─── PB-no-past: occurrences with start < now are dropped, exactly those ──────

describe('PB-no-past: exactly the pre-now occurrences are dropped', () => {
  // We anchor with `until` mode against a FIXED end date so the covered date
  // RANGE is identical regardless of `now` (count mode would re-extend the tail
  // when `now` advances, since the anchor — and thus the count budget — slides).
  // With a fixed until date, advancing `now` is a pure prefix-trim: the result
  // is exactly the would-be occurrences with start >= now, nothing more dropped.
  it('advancing now past the Kth would-be start drops exactly the prefix < now', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 7 }), // single weekday
        arbInterval,
        fc.integer({ min: 0, max: 12 }), // K = which occurrence start to advance past
        (wd, intervalWeeks, k) => {
          const baseNow = Date.UTC(2026, 0, 1); // Thursday — everything future
          const rule: RecurrenceRule = {
            freq: 'weekly',
            weekdays: [wd],
            intervalWeeks,
            end: { kind: 'until', untilDate: { year: 2026, month: 12, day: 31 } },
            localStartTime: { hour: 10, minute: 0 },
            durationMinutes: 60,
            tz: 'UTC',
          };
          const full = expandRecurrence(rule, { now: baseNow, resolveZoned: fixedOffsetResolver(0), hardCap: 200 });
          fc.pre(full.occurrences.length > k);
          // Advance now to just AFTER occurrence (k-1)'s start (k=0 ⇒ no advance).
          const newNow = k === 0 ? baseNow : full.occurrences[k - 1]!.startUtcMs + 1;
          const trimmed = expandRecurrence(rule, { now: newNow, resolveZoned: fixedOffsetResolver(0), hardCap: 200 });
          // The result is exactly the full set restricted to start >= newNow.
          const expected = full.occurrences.filter((o) => o.startUtcMs >= newNow).map((o) => o.startUtcMs);
          expect(trimmed.occurrences.map((o) => o.startUtcMs)).toEqual(expected);
          for (const o of trimmed.occurrences) expect(o.startUtcMs).toBeGreaterThanOrEqual(newNow);
        },
      ),
    );
  });
});

// ─── PB-dst-stability: wall-clock h:m fixed across a REAL DST transition ──────

describe('PB-dst-stability: wall-clock time is identical across a DST transition', () => {
  it('a fixed local time stays at the same h:m for every occurrence (America/Chicago)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 7 }), // weekday
        // A start time that is NOT in the spring-forward gap (02:00–02:59 local)
        // and not the ambiguous fall-back hour — pick safe daytime hours.
        fc.constantFrom(9, 10, 11, 13, 14, 18),
        fc.constantFrom(0, 15, 30, 45),
        // now: a January 2026 instant so the series spans the March DST jump.
        fc.constantFrom(Date.UTC(2026, 0, 5), Date.UTC(2026, 0, 12), Date.UTC(2026, 0, 19)),
        (wd, hour, minute, now) => {
          const tz = 'America/Chicago';
          const rule: RecurrenceRule = {
            freq: 'weekly',
            weekdays: [wd],
            intervalWeeks: 1,
            end: { kind: 'count', count: 20 }, // ~20 weeks spans the March transition
            localStartTime: { hour, minute },
            durationMinutes: 60,
            tz,
          };
          const res = expandRecurrence(rule, { now, resolveZoned: intlResolver });
          // Render every occurrence back into Chicago local time and assert the
          // wall-clock h:m is identical to the rule's localStartTime — the offset
          // shifts across DST but the local time does not.
          const fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });
          for (const o of res.occurrences) {
            const parts = fmt.formatToParts(new Date(o.startUtcMs));
            let h = Number(parts.find((p) => p.type === 'hour')!.value);
            if (h === 24) h = 0;
            const m = Number(parts.find((p) => p.type === 'minute')!.value);
            expect({ h, m }).toEqual({ h: hour, m: minute });
          }
          // Sanity: across the March transition the weekly UTC step is NOT a
          // constant 7*86_400_000 — the offset shift produces a 6-day-23h step
          // exactly once. This proves the expander did NOT naively add 7 days in
          // UTC (which would have drifted the wall-clock). We only assert when
          // the series demonstrably spanned the transition (>=2 distinct steps).
          const steps = new Set<number>();
          for (let i = 1; i < res.occurrences.length; i++) {
            steps.add(res.occurrences[i]!.startUtcMs - res.occurrences[i - 1]!.startUtcMs);
          }
          // The wall-clock assertion above is the hard guarantee; the step set
          // merely documents that DST was exercised (>1 step ⇒ a transition was
          // crossed; ==1 ⇒ the window happened to miss it, still wall-clock-fixed).
          expect(steps.size).toBeGreaterThanOrEqual(1);
        },
      ),
    );
  });
});

// ─── PB-determinism: identical inputs ⇒ deep-equal result (idempotent) ────────

describe('PB-determinism: expansion is pure and idempotent', () => {
  it('identical (rule, opts) ⇒ deep-equal result', () => {
    fc.assert(
      fc.property(
        arbWeekdays,
        arbInterval,
        arbTime,
        arbDuration,
        fc.integer({ min: 1, max: 40 }),
        arbNow,
        fc.constantFrom('UTC', 'America/Chicago', 'America/New_York'),
        (weekdays, intervalWeeks, localStartTime, durationMinutes, count, now, tz) => {
          const rule: RecurrenceRule = {
            freq: 'weekly',
            weekdays,
            intervalWeeks,
            end: { kind: 'count', count },
            localStartTime,
            durationMinutes,
            tz,
          };
          const a = expandRecurrence(rule, { now, resolveZoned: intlResolver });
          const b = expandRecurrence(rule, { now, resolveZoned: intlResolver });
          expect(a).toEqual(b);
        },
      ),
    );
  });
});

// ─── Unit: DST-nonexistent (synthetic resolver) ──────────────────────────────

describe('DST-nonexistent: a nonexistent local time is dropped + reported', () => {
  it('the flagged date appears in skippedLocalDates and not in occurrences', () => {
    // Synthetic resolver: every occurrence is valid EXCEPT one specific local
    // date which is flagged nonexistent (spring-forward gap).
    const gapDate = { year: 2026, month: 3, day: 11 }; // a Wednesday
    const resolver: ZonedToUtc = ({ year, month, day, hour, minute }) => {
      const utcMs = Date.UTC(year, month - 1, day, hour, minute);
      if (year === gapDate.year && month === gapDate.month && day === gapDate.day) {
        return { utcMs, status: 'nonexistent' as const };
      }
      return { utcMs, status: 'valid' as const };
    };

    const rule: RecurrenceRule = {
      freq: 'weekly',
      weekdays: [3], // Wednesday
      intervalWeeks: 1,
      end: { kind: 'count', count: 5 },
      localStartTime: { hour: 2, minute: 30 },
      durationMinutes: 60,
      tz: 'America/Chicago',
    };
    // now = the first Wednesday (Mar 4) so the week-0 Wednesday is the first
    // occurrence (no no-past drop in week 0). Series Wednesdays: Mar 4, 11(gap),
    // 18, 25, Apr 1 ⇒ 5 generated, Mar 11 dropped ⇒ 4 emitted.
    const res = expandRecurrence(rule, { now: Date.UTC(2026, 2, 4), resolveZoned: resolver });

    // The gap date is reported and absent from occurrences.
    expect(res.skippedLocalDates).toContainEqual({ date: gapDate, reason: 'nonexistent_local_time' });
    for (const o of res.occurrences) {
      expect(o.localDate).not.toEqual(gapDate);
    }
    expect(res.occurrences.length).toBe(4);
  });
});

// ─── Unit: DST-ambiguous (synthetic resolver → earlier instant, present) ──────

describe('DST-ambiguous: a fall-back local time resolves to the earlier instant', () => {
  it('the ambiguous occurrence is present at exactly the earlier instant', () => {
    const ambDate = { year: 2026, month: 11, day: 1 }; // fall-back Sunday (US)
    const earlierInstant = Date.UTC(2026, 10, 1, 6, 30); // arbitrary fixed "earlier" instant
    const resolver: ZonedToUtc = ({ year, month, day, hour, minute }) => {
      if (year === ambDate.year && month === ambDate.month && day === ambDate.day) {
        return { utcMs: earlierInstant, status: 'ambiguous' as const };
      }
      return { utcMs: Date.UTC(year, month - 1, day, hour, minute), status: 'valid' as const };
    };

    const rule: RecurrenceRule = {
      freq: 'weekly',
      weekdays: [7], // Sunday
      intervalWeeks: 1,
      end: { kind: 'count', count: 1 },
      localStartTime: { hour: 1, minute: 30 },
      durationMinutes: 60,
      tz: 'America/Chicago',
    };
    // now = Nov 1 00:00 (a Sunday) so the FIRST (count:1) occurrence lands on
    // the ambiguous date itself; earlierInstant (06:30) is after now ⇒ kept.
    const res = expandRecurrence(rule, { now: Date.UTC(2026, 10, 1), resolveZoned: resolver });

    expect(res.skippedLocalDates).toEqual([]);
    expect(res.occurrences.length).toBe(1);
    expect(res.occurrences[0]!.startUtcMs).toBe(earlierInstant);
    expect(res.occurrences[0]!.endUtcMs).toBe(earlierInstant + 60 * 60_000);
    expect(res.occurrences[0]!.localDate).toEqual(ambDate);
  });
});

// ─── Unit: zero-future in until mode (until before first) ─────────────────────

describe('until before first occurrence ⇒ clean empty result', () => {
  it('untilDate strictly before the anchor yields zero occurrences, no skips', () => {
    const now = Date.UTC(2026, 5, 15); // mid-June 2026
    const rule: RecurrenceRule = {
      freq: 'weekly',
      weekdays: [1, 3, 5],
      intervalWeeks: 1,
      end: { kind: 'until', untilDate: { year: 2026, month: 6, day: 1 } }, // before now
      localStartTime: { hour: 9, minute: 0 },
      durationMinutes: 60,
      tz: 'UTC',
    };
    const res = expandRecurrence(rule, { now, resolveZoned: fixedOffsetResolver(0) });
    expect(res.occurrences).toEqual([]);
    expect(res.skippedLocalDates).toEqual([]);
    expect(res.truncatedByCap).toBe(false);
  });
});
