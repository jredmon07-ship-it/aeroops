/**
 * availability.test.ts — property + unit tests for the pure availability gate +
 * weekly-window → UTC resolver (Slice AV1.1, packages/core).
 *
 * This is where the SCHEDULING-AV1 PROPERTY tests live (the HARD guardrail).
 *
 * Deterministic: no Date.now(), no Math.random() — fast-check seeds the only
 * randomness; the candidate span + the injected tz resolver are the only time
 * inputs to the pure functions. The synthetic resolvers (fixed-offset + a real
 * Intl-backed IANA resolver) live ENTIRELY in test code — core imports NO tz
 * library — and are byte-for-byte the same strategy as recurrence.test.ts.
 *
 * THE 10 PROPERTY INVARIANTS (matched to the build contract):
 *   1. INERT — no/empty windows ⇒ always { ok: true } for any candidate.
 *   2. Fully-within a window ⇒ ok.
 *   3. Partial / fully-outside ⇒ warn (mode warn) XOR block (mode block) —
 *      mutually exclusive; ok in neither.
 *   4. UNION of overlapping/adjacent windows is one coverage region (a candidate
 *      spanning two adjacent windows that together cover it ⇒ ok).
 *   5. Half-open boundary: candidate [open, close) of the union ⇒ ok; ±1ms
 *      outside ⇒ violates.
 *   6. DST spring-forward (gap-open snaps forward / gap-close to gap-start).
 *   7. DST fall-back (ambiguous ⇒ earlier instant).
 *   8. Multi-window same day; overnight = two consecutive-day rows both resolve.
 *   9. Pure / deterministic / total (same input ⇒ deep-equal output; never throws).
 *  10. Mode-independence of the ok-case; warn vs block differ ONLY in the
 *      not-contained case.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  resolveAvailabilityWindowsToUtc,
  evaluateAvailabilityGate,
} from '../scheduling/availability.js';
import type {
  ResourceAvailabilityWindow,
  ResolvedAvailabilityWindow,
  AvailabilityGateResult,
} from '../scheduling/availability.js';
import type { ZonedToUtc } from '../scheduling/recurrence.js';

const MIN = 60_000;

// ─── Synthetic resolvers (copied strategy from recurrence.test.ts) ────────────

/** FIXED-OFFSET resolver: zone treated as a constant UTC offset. Always 'valid'. */
function fixedOffsetResolver(offsetMinutes = 0): ZonedToUtc {
  return ({ year, month, day, hour, minute }) => {
    const utcMs = Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes * 60_000;
    return { utcMs, status: 'valid' as const };
  };
}

/** REAL IANA resolver via Intl.DateTimeFormat (nonexistent + ambiguous aware). */
function makeIntlResolver(): ZonedToUtc {
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
  const partsAt = (utcMs: number, tz: string) => {
    const parts = getFmt(tz).formatToParts(new Date(utcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    let hour = get('hour');
    if (hour === 24) hour = 0;
    return { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute') };
  };
  const offsetAt = (utcMs: number, tz: string): number => {
    const p = partsAt(utcMs, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    return Math.round((asUtc - utcMs) / 60_000);
  };
  return ({ year, month, day, hour, minute, tz }) => {
    const targetLocal = Date.UTC(year, month - 1, day, hour, minute);
    const off1 = offsetAt(targetLocal, tz);
    const cand1 = targetLocal - off1 * 60_000;
    const off2 = offsetAt(cand1, tz);
    const cand2 = targetLocal - off2 * 60_000;
    const matches = (utcMs: number): boolean => {
      const p = partsAt(utcMs, tz);
      return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute;
    };
    const valid: number[] = [];
    for (const c of [cand1, cand2]) if (matches(c) && !valid.includes(c)) valid.push(c);
    if (valid.length === 0) return { utcMs: cand1, status: 'nonexistent' as const };
    if (valid.length >= 2) return { utcMs: Math.min(...valid), status: 'ambiguous' as const };
    return { utcMs: valid[0]!, status: 'valid' as const };
  };
}

const intlResolver = makeIntlResolver();
const utcResolver = fixedOffsetResolver(0);

// ─── Helpers ──────────────────────────────────────────────────────────────────

const isoWeekday = (y: number, m: number, d: number): number => {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 ? 7 : dow;
};

/** A simple resolved UTC window. */
const rw = (openUtcMs: number, closeUtcMs: number): ResolvedAvailabilityWindow => ({
  openUtcMs,
  closeUtcMs,
});

/** Assert exactly one of ok/warn/block holds for a given mode + containment. */
function classify(r: AvailabilityGateResult): 'ok' | 'warn' | 'block' {
  if (r.ok === false) {
    expect((r as { blocks: true }).blocks).toBe(true);
    return 'block';
  }
  if ('warns' in r && r.warns) return 'warn';
  return 'ok';
}

// ════════════════════════════════════════════════════════════════════════════
// INVARIANT 1 — INERT: no/empty windows ⇒ always ok.
// ════════════════════════════════════════════════════════════════════════════

describe('INV1 — INERT when windows null/empty', () => {
  it('property: any candidate, null or [] windows, any mode ⇒ { ok: true }', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1e12, max: 1e12 }),
        fc.integer({ min: 0, max: 1e9 }),
        fc.constantFrom<'block' | 'warn'>('block', 'warn'),
        fc.constantFrom<readonly ResolvedAvailabilityWindow[] | null>(null, []),
        (start, dur, mode, windows) => {
          const r = evaluateAvailabilityGate(
            { candidateStartUtcMs: start, candidateEndUtcMs: start + dur },
            windows,
            mode,
          );
          expect(r).toEqual({ ok: true });
        },
      ),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INVARIANT 2 — fully-within a window ⇒ ok.
// ════════════════════════════════════════════════════════════════════════════

describe('INV2 — candidate fully within a window ⇒ ok', () => {
  it('property: [s,e) ⊆ [open,close) ⇒ ok in both modes', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e9 }),
        fc.integer({ min: 1, max: 1e6 }),
        fc.integer({ min: 0, max: 1e6 }),
        fc.integer({ min: 0, max: 1e6 }),
        fc.constantFrom<'block' | 'warn'>('block', 'warn'),
        (open, span, padL, padR, mode) => {
          const close = open + span + padL + padR + 1;
          const start = open + padL;
          const end = close - padR;
          fc.pre(start < end); // non-degenerate candidate
          const r = evaluateAvailabilityGate(
            { candidateStartUtcMs: start, candidateEndUtcMs: end },
            [rw(open, close)],
            mode,
          );
          expect(classify(r)).toBe('ok');
        },
      ),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INVARIANT 3 — partial / outside ⇒ warn XOR block (mutually exclusive).
// ════════════════════════════════════════════════════════════════════════════

describe('INV3 — not contained ⇒ warn XOR block per mode', () => {
  it('property: a candidate poking outside the only window ⇒ warn(warn)/block(block)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 1e9 }),
        fc.integer({ min: 1, max: 1e6 }),
        fc.integer({ min: 1, max: 1000 }), // amount poking before open
        (open, span, poke) => {
          const close = open + span;
          const start = open - poke; // starts before open ⇒ uncovered head
          const end = close;
          const warnR = evaluateAvailabilityGate(
            { candidateStartUtcMs: start, candidateEndUtcMs: end },
            [rw(open, close)],
            'warn',
          );
          const blockR = evaluateAvailabilityGate(
            { candidateStartUtcMs: start, candidateEndUtcMs: end },
            [rw(open, close)],
            'block',
          );
          expect(classify(warnR)).toBe('warn');
          expect(classify(blockR)).toBe('block');
          // The uncovered head is reported exactly once.
          const wHits = (warnR as { hits: { startUtcMs: number; endUtcMs: number }[] }).hits;
          expect(wHits).toEqual([{ startUtcMs: start, endUtcMs: open }]);
          const bHits = (blockR as { hits: { startUtcMs: number; endUtcMs: number }[] }).hits;
          expect(bHits).toEqual([{ startUtcMs: start, endUtcMs: open }]);
        },
      ),
    );
  });

  it('fully-outside (no overlap) ⇒ the whole candidate is the single hit', () => {
    const r = evaluateAvailabilityGate(
      { candidateStartUtcMs: 100, candidateEndUtcMs: 200 },
      [rw(1000, 2000)],
      'block',
    );
    expect(r).toEqual({ ok: false, blocks: true, hits: [{ startUtcMs: 100, endUtcMs: 200 }] });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INVARIANT 4 — UNION of overlapping/adjacent windows is one coverage region.
// ════════════════════════════════════════════════════════════════════════════

describe('INV4 — union of overlapping/adjacent windows', () => {
  it('candidate spanning two ADJACENT windows that together cover it ⇒ ok', () => {
    // [0,100) and [100,200): touching ⇒ contiguous coverage [0,200).
    const r = evaluateAvailabilityGate(
      { candidateStartUtcMs: 10, candidateEndUtcMs: 190 },
      [rw(0, 100), rw(100, 200)],
      'block',
    );
    expect(r).toEqual({ ok: true });
  });

  it('candidate spanning two OVERLAPPING windows ⇒ ok', () => {
    const r = evaluateAvailabilityGate(
      { candidateStartUtcMs: 10, candidateEndUtcMs: 240 },
      [rw(0, 150), rw(120, 250)],
      'warn',
    );
    expect(r).toEqual({ ok: true });
  });

  it('a GAP between two non-touching windows is reported as a hit', () => {
    // [0,100) and [200,300): candidate [50,250) leaves [100,200) uncovered.
    const r = evaluateAvailabilityGate(
      { candidateStartUtcMs: 50, candidateEndUtcMs: 250 },
      [rw(0, 100), rw(200, 300)],
      'block',
    );
    expect(r).toEqual({
      ok: false,
      blocks: true,
      hits: [{ startUtcMs: 100, endUtcMs: 200 }],
    });
  });

  it('property: union order independence — shuffled windows give same verdict', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.integer({ min: 0, max: 1000 }).chain((o) =>
            fc.integer({ min: 1, max: 500 }).map((len) => rw(o, o + len)),
          ),
          { minLength: 1, maxLength: 6 },
        ),
        fc.integer({ min: 0, max: 1500 }),
        fc.integer({ min: 1, max: 800 }),
        fc.constantFrom<'block' | 'warn'>('block', 'warn'),
        (windows, start, dur, mode) => {
          const cand = { candidateStartUtcMs: start, candidateEndUtcMs: start + dur };
          const a = evaluateAvailabilityGate(cand, windows, mode);
          const reversed = [...windows].reverse();
          const b = evaluateAvailabilityGate(cand, reversed, mode);
          expect(b).toEqual(a);
        },
      ),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INVARIANT 5 — half-open boundary: exact [open,close) ⇒ ok; ±1ms outside ⇒ no.
// ════════════════════════════════════════════════════════════════════════════

describe('INV5 — strict half-open boundary', () => {
  const win = [rw(1000, 2000)];

  it('candidate == [open, close) exactly ⇒ ok', () => {
    expect(
      evaluateAvailabilityGate({ candidateStartUtcMs: 1000, candidateEndUtcMs: 2000 }, win, 'block'),
    ).toEqual({ ok: true });
  });

  it('start 1ms before open ⇒ violates (head hit of 1ms)', () => {
    const r = evaluateAvailabilityGate(
      { candidateStartUtcMs: 999, candidateEndUtcMs: 2000 },
      win,
      'block',
    );
    expect(r).toEqual({ ok: false, blocks: true, hits: [{ startUtcMs: 999, endUtcMs: 1000 }] });
  });

  it('end 1ms after close ⇒ violates (tail hit of 1ms)', () => {
    const r = evaluateAvailabilityGate(
      { candidateStartUtcMs: 1000, candidateEndUtcMs: 2001 },
      win,
      'block',
    );
    expect(r).toEqual({ ok: false, blocks: true, hits: [{ startUtcMs: 2000, endUtcMs: 2001 }] });
  });

  it('candidate ending EXACTLY at the union end (open inclusive) ⇒ ok', () => {
    // Two adjacent windows; candidate from union open to union close exactly.
    const r = evaluateAvailabilityGate(
      { candidateStartUtcMs: 0, candidateEndUtcMs: 200 },
      [rw(0, 100), rw(100, 200)],
      'block',
    );
    expect(r).toEqual({ ok: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INVARIANT 6 — DST spring-forward (gap-open snaps forward / close to gap-start).
// ════════════════════════════════════════════════════════════════════════════

describe('INV6 — DST spring-forward (decision 10)', () => {
  // America/Chicago 2026-03-08: 02:00 local jumps to 03:00 (02:00–02:59 do not
  // exist). A window 02:00–04:00 local on that Sunday (ISO 7) must resolve so
  // the OPEN snaps forward to 03:00 local (the gap end) and the close stays 04:00.
  const tz = 'America/Chicago';
  const gapDate = { year: 2026, month: 3, day: 8 };

  it('window open at the nonexistent local hour snaps FORWARD to gap end (03:00)', () => {
    const dow = isoWeekday(gapDate.year, gapDate.month, gapDate.day); // Sunday = 7
    const windows: ResourceAvailabilityWindow[] = [
      { dayOfWeek: dow, startMinute: 2 * 60, endMinute: 4 * 60, tz },
    ];
    // Candidate span: the whole local day in UTC terms (wide).
    const spanStart = Date.UTC(2026, 2, 8, 0, 0);
    const spanEnd = Date.UTC(2026, 2, 9, 0, 0);
    const resolved = resolveAvailabilityWindowsToUtc(windows, spanStart, spanEnd, intlResolver);
    expect(resolved.length).toBe(1);
    // 03:00 CDT = 08:00 UTC; 04:00 CDT = 09:00 UTC.
    expect(resolved[0]!.openUtcMs).toBe(Date.UTC(2026, 2, 8, 8, 0));
    expect(resolved[0]!.closeUtcMs).toBe(Date.UTC(2026, 2, 8, 9, 0));
  });

  it('window CLOSE inside the gap snaps to gap-start (02:00 → last valid instant)', () => {
    const dow = isoWeekday(gapDate.year, gapDate.month, gapDate.day);
    // Window 00:00 → 02:30 local; 02:30 is in the gap → close snaps to gap start
    // (02:00 local = 08:00 UTC, since 01:59:59.999 CST is the last instant).
    const windows: ResourceAvailabilityWindow[] = [
      { dayOfWeek: dow, startMinute: 0, endMinute: 2 * 60 + 30, tz },
    ];
    const spanStart = Date.UTC(2026, 2, 8, 0, 0);
    const spanEnd = Date.UTC(2026, 2, 9, 0, 0);
    const resolved = resolveAvailabilityWindowsToUtc(windows, spanStart, spanEnd, intlResolver);
    expect(resolved.length).toBe(1);
    // 00:00 CST = 06:00 UTC; gap-start = 02:00 CST = 08:00 UTC.
    expect(resolved[0]!.openUtcMs).toBe(Date.UTC(2026, 2, 8, 6, 0));
    expect(resolved[0]!.closeUtcMs).toBe(Date.UTC(2026, 2, 8, 8, 0));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INVARIANT 7 — DST fall-back (ambiguous ⇒ earlier instant).
// ════════════════════════════════════════════════════════════════════════════

describe('INV7 — DST fall-back (ambiguous ⇒ earlier instant)', () => {
  // America/Chicago 2026-11-01: 02:00 local falls back to 01:00; 01:00–01:59
  // occur twice. A window opening at 01:30 local resolves to the EARLIER instant.
  const tz = 'America/Chicago';
  const fbDate = { year: 2026, month: 11, day: 1 };

  it('window open at an ambiguous local time uses the EARLIER UTC instant', () => {
    const dow = isoWeekday(fbDate.year, fbDate.month, fbDate.day); // Sunday = 7
    const windows: ResourceAvailabilityWindow[] = [
      { dayOfWeek: dow, startMinute: 90, endMinute: 180, tz }, // 01:30 → 03:00
    ];
    const spanStart = Date.UTC(2026, 10, 1, 0, 0);
    const spanEnd = Date.UTC(2026, 10, 2, 0, 0);
    const resolved = resolveAvailabilityWindowsToUtc(windows, spanStart, spanEnd, intlResolver);
    expect(resolved.length).toBe(1);
    // Earlier 01:30 = still CDT (UTC-5) ⇒ 06:30 UTC (not the later 07:30 CST).
    expect(resolved[0]!.openUtcMs).toBe(Date.UTC(2026, 10, 1, 6, 30));
    // 03:00 CST (UTC-6) = 09:00 UTC.
    expect(resolved[0]!.closeUtcMs).toBe(Date.UTC(2026, 10, 1, 9, 0));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INVARIANT 8 — multi-window same day; overnight = two consecutive-day rows.
// ════════════════════════════════════════════════════════════════════════════

describe('INV8 — multi-window + overnight two-row resolution', () => {
  const tz = 'UTC'; // fixed offset for exact arithmetic

  it('two windows on the same day both resolve', () => {
    // Wednesday 2026-06-17 is ISO day 3.
    const dow = isoWeekday(2026, 6, 17); // 3
    const windows: ResourceAvailabilityWindow[] = [
      { dayOfWeek: dow, startMinute: 8 * 60, endMinute: 12 * 60, tz },
      { dayOfWeek: dow, startMinute: 13 * 60, endMinute: 17 * 60, tz },
    ];
    const spanStart = Date.UTC(2026, 5, 17, 0, 0);
    const spanEnd = Date.UTC(2026, 5, 18, 0, 0);
    const resolved = resolveAvailabilityWindowsToUtc(windows, spanStart, spanEnd, utcResolver);
    expect(resolved.length).toBe(2);
    expect(resolved).toContainEqual(rw(Date.UTC(2026, 5, 17, 8), Date.UTC(2026, 5, 17, 12)));
    expect(resolved).toContainEqual(rw(Date.UTC(2026, 5, 17, 13), Date.UTC(2026, 5, 17, 17)));

    // A lunch-break booking 12:00–13:00 falls in the gap ⇒ uncovered.
    const lunch = evaluateAvailabilityGate(
      { candidateStartUtcMs: Date.UTC(2026, 5, 17, 12), candidateEndUtcMs: Date.UTC(2026, 5, 17, 13) },
      resolved,
      'block',
    );
    expect(lunch.ok).toBe(false);
  });

  it('overnight modeled as two consecutive-day rows both resolve & union covers the night', () => {
    // 22:00 Wed → 24:00 (row A, day 3) and 00:00 → 06:00 Thu (row B, day 4).
    const dowWed = isoWeekday(2026, 6, 17); // 3
    const dowThu = isoWeekday(2026, 6, 18); // 4
    const windows: ResourceAvailabilityWindow[] = [
      { dayOfWeek: dowWed, startMinute: 22 * 60, endMinute: 1440, tz },
      { dayOfWeek: dowThu, startMinute: 0, endMinute: 6 * 60, tz },
    ];
    const spanStart = Date.UTC(2026, 5, 17, 0, 0);
    const spanEnd = Date.UTC(2026, 5, 19, 0, 0);
    const resolved = resolveAvailabilityWindowsToUtc(windows, spanStart, spanEnd, utcResolver);
    expect(resolved.length).toBe(2);
    // The two rows are adjacent at midnight ⇒ union covers 22:00 Wed → 06:00 Thu.
    const overnight = evaluateAvailabilityGate(
      {
        candidateStartUtcMs: Date.UTC(2026, 5, 17, 23),
        candidateEndUtcMs: Date.UTC(2026, 5, 18, 5),
      },
      resolved,
      'block',
    );
    expect(overnight).toEqual({ ok: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INVARIANT 9 — pure / deterministic / total (never throws).
// ════════════════════════════════════════════════════════════════════════════

describe('INV9 — pure / deterministic / total', () => {
  it('property: gate is deterministic (same input ⇒ deep-equal output twice)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.integer({ min: -1000, max: 1000 }).chain((o) =>
            fc.integer({ min: -200, max: 600 }).map((len) => rw(o, o + len)),
          ),
          { maxLength: 8 },
        ),
        fc.integer({ min: -2000, max: 2000 }),
        fc.integer({ min: -500, max: 2000 }),
        fc.constantFrom<'block' | 'warn'>('block', 'warn'),
        (windows, start, dur, mode) => {
          const cand = { candidateStartUtcMs: start, candidateEndUtcMs: start + dur };
          const a = evaluateAvailabilityGate(cand, windows, mode);
          const b = evaluateAvailabilityGate(cand, windows, mode);
          expect(b).toEqual(a);
        },
      ),
    );
  });

  it('property: resolver is deterministic + never throws on arbitrary windows', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            dayOfWeek: fc.integer({ min: -3, max: 11 }), // includes invalid rows
            startMinute: fc.integer({ min: -100, max: 1500 }),
            endMinute: fc.integer({ min: -100, max: 1500 }),
            tz: fc.constantFrom('UTC', 'America/Chicago', 'America/New_York'),
          }),
          { maxLength: 6 },
        ),
        fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2026, 11, 1) }),
        fc.integer({ min: MIN, max: 5 * 24 * 60 * MIN }),
        (windows, spanStart, spanLen) => {
          const a = resolveAvailabilityWindowsToUtc(windows, spanStart, spanStart + spanLen, intlResolver);
          const b = resolveAvailabilityWindowsToUtc(windows, spanStart, spanStart + spanLen, intlResolver);
          expect(b).toEqual(a);
          // Every resolved window is a non-degenerate half-open interval.
          for (const w of a) expect(w.openUtcMs).toBeLessThan(w.closeUtcMs);
        },
      ),
    );
  });

  it('degenerate candidate (start >= end) ⇒ ok (covers nothing)', () => {
    expect(
      evaluateAvailabilityGate({ candidateStartUtcMs: 500, candidateEndUtcMs: 500 }, [rw(0, 100)], 'block'),
    ).toEqual({ ok: true });
    expect(
      evaluateAvailabilityGate({ candidateStartUtcMs: 500, candidateEndUtcMs: 100 }, [rw(0, 100)], 'block'),
    ).toEqual({ ok: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// INVARIANT 10 — mode-independence of ok-case; warn vs block differ ONLY when
// not contained.
// ════════════════════════════════════════════════════════════════════════════

describe('INV10 — mode independence of the ok-case', () => {
  it('property: when contained, warn and block both give identical { ok: true }', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1e6 }),
        fc.integer({ min: 1, max: 1e6 }),
        (open, span) => {
          const close = open + span;
          const cand = { candidateStartUtcMs: open, candidateEndUtcMs: close };
          const warnR = evaluateAvailabilityGate(cand, [rw(open, close)], 'warn');
          const blockR = evaluateAvailabilityGate(cand, [rw(open, close)], 'block');
          expect(warnR).toEqual({ ok: true });
          expect(blockR).toEqual({ ok: true });
        },
      ),
    );
  });

  it('property: when NOT contained, warn and block carry the SAME hits, differ only in arm', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1000, max: 1e6 }),
        fc.integer({ min: 1, max: 1e5 }),
        fc.integer({ min: 1, max: 500 }),
        (open, span, poke) => {
          const close = open + span;
          const cand = { candidateStartUtcMs: open - poke, candidateEndUtcMs: close + poke };
          const win = [rw(open, close)];
          const warnR = evaluateAvailabilityGate(cand, win, 'warn') as {
            ok: true;
            warns: true;
            hits: unknown;
          };
          const blockR = evaluateAvailabilityGate(cand, win, 'block') as {
            ok: false;
            blocks: true;
            hits: unknown;
          };
          expect(warnR.ok).toBe(true);
          expect(warnR.warns).toBe(true);
          expect(blockR.ok).toBe(false);
          expect(blockR.blocks).toBe(true);
          expect(warnR.hits).toEqual(blockR.hits);
        },
      ),
    );
  });
});
