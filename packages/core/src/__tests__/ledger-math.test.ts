/**
 * ledger-math.test.ts — unit + property tests for the pure billing ledger
 * balance math (B2 @aeroops/core). PROPERTY-BASED tests (the HARD guardrail
 * per CLAUDE.md: "money math gets PROPERTY-BASED tests").
 *
 * SIGN CONVENTION (pin here): balance = Σcredits − Σdebits.
 *
 * WHAT WE PROVE:
 *   Unit targets:
 *     - empty ⇒ 0; single credit; single debit; mixed; canonical scenarios.
 *     - error paths: non-positive/non-integer amountCents, invalid direction.
 *
 *   Properties (fast-check):
 *     P1  Permutation invariance: computeBalance(shuffle(entries)) === computeBalance(entries).
 *     P2  Append monotonicity: appending a credit entry never LOWERS the balance.
 *     P3  Append monotonicity (debit): appending a debit entry never RAISES the balance.
 *     P4  Integer closure: the result is always an integer.
 *     P5  Reversal cancellation: a debit of X immediately followed by a credit
 *         of X (or vice versa) leaves the balance unchanged vs before both.
 *     P6  Zero-entry edge: computeBalance([]) === 0.
 *     P7  Determinism: same input twice ⇒ same output (pure).
 *     P8  Single credit entry: balance === that entry's amount.
 *     P9  Single debit entry: balance === -that entry's amount.
 *     P10 Non-positive amountCents ⇒ always throws RangeError.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeBalance } from '../billing/ledger-math.js';
import type { LedgerEntryAmount } from '../billing/ledger-math.js';

// ─── Generators ───────────────────────────────────────────────────────────────

/** A realistic positive integer cent amount [1..10_000_000] ($0.01–$100,000). */
const posCents = fc.integer({ min: 1, max: 10_000_000 });

const directionGen = fc.constantFrom<'debit' | 'credit'>('debit', 'credit');

const entryGen: fc.Arbitrary<LedgerEntryAmount> = fc.record({
  direction: directionGen,
  amountCents: posCents,
});

const entriesGen = fc.array(entryGen, { minLength: 0, maxLength: 200 });

// ─── Unit edges ───────────────────────────────────────────────────────────────

describe('computeBalance — unit edges', () => {
  it('empty array ⇒ 0', () => {
    expect(computeBalance([])).toBe(0);
  });

  it('single credit ⇒ balance === amount', () => {
    expect(computeBalance([{ direction: 'credit', amountCents: 5000 }])).toBe(5000);
  });

  it('single debit ⇒ balance === -amount', () => {
    expect(computeBalance([{ direction: 'debit', amountCents: 5000 }])).toBe(-5000);
  });

  it('credit then debit of the same amount ⇒ 0', () => {
    const result = computeBalance([
      { direction: 'credit', amountCents: 12500 },
      { direction: 'debit', amountCents: 12500 },
    ]);
    expect(result).toBe(0);
  });

  it('two payments then one invoice_finalized-shaped debit ⇒ net positive', () => {
    const result = computeBalance([
      { direction: 'credit', amountCents: 10000 },
      { direction: 'credit', amountCents: 5000 },
      { direction: 'debit', amountCents: 8000 },
    ]);
    expect(result).toBe(7000);
  });

  it('debits exceeding credits ⇒ negative balance (member owes money — not clamped)', () => {
    const result = computeBalance([
      { direction: 'credit', amountCents: 1000 },
      { direction: 'debit', amountCents: 5000 },
    ]);
    expect(result).toBe(-4000);
  });

  it('order does not matter for a fixed set (unit spot-check)', () => {
    const a: LedgerEntryAmount[] = [
      { direction: 'credit', amountCents: 100 },
      { direction: 'debit', amountCents: 30 },
      { direction: 'credit', amountCents: 7 },
    ];
    const b = [...a].reverse();
    expect(computeBalance(a)).toBe(computeBalance(b));
  });
});

// ─── Error paths ────────────────────────────────────────────────────────────

describe('computeBalance — error paths', () => {
  it('zero amountCents ⇒ throws RangeError', () => {
    expect(() => computeBalance([{ direction: 'credit', amountCents: 0 }])).toThrow(RangeError);
  });

  it('negative amountCents ⇒ throws RangeError', () => {
    expect(() => computeBalance([{ direction: 'debit', amountCents: -1 }])).toThrow(RangeError);
  });

  it('non-integer amountCents ⇒ throws RangeError', () => {
    expect(() => computeBalance([{ direction: 'credit', amountCents: 1.5 }])).toThrow(RangeError);
  });

  it('NaN amountCents ⇒ throws RangeError', () => {
    expect(() => computeBalance([{ direction: 'credit', amountCents: NaN }])).toThrow(RangeError);
  });

  it('Infinity amountCents ⇒ throws RangeError', () => {
    expect(() => computeBalance([{ direction: 'credit', amountCents: Infinity }])).toThrow(RangeError);
  });

  it('invalid direction ⇒ throws RangeError', () => {
    expect(() =>
      computeBalance([{ direction: 'bogus' as unknown as 'debit', amountCents: 100 }]),
    ).toThrow(RangeError);
  });

  it('throws on the first invalid entry even if earlier entries were valid', () => {
    expect(() =>
      computeBalance([
        { direction: 'credit', amountCents: 100 },
        { direction: 'debit', amountCents: -5 },
      ]),
    ).toThrow(RangeError);
  });
});

// ─── P1 Permutation invariance ─────────────────────────────────────────────────

describe('P1 — Permutation invariance: order does not change the balance', () => {
  it('shuffled (reversed) entries produce the same balance', () => {
    fc.assert(
      fc.property(entriesGen, (entries) => {
        const reversed = [...entries].reverse();
        expect(computeBalance(reversed)).toBe(computeBalance(entries));
      }),
    );
  });

  it('an arbitrary fc-shuffled permutation produces the same balance', () => {
    fc.assert(
      fc.property(entriesGen, fc.integer({ min: 0, max: 2 ** 31 - 1 }), (entries, seed) => {
        // Deterministic shuffle via a simple seeded swap pass (no external dep).
        const shuffled = [...entries];
        let s = seed || 1;
        for (let i = shuffled.length - 1; i > 0; i--) {
          s = (s * 1103515245 + 12345) & 0x7fffffff;
          const j = s % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }
        expect(computeBalance(shuffled)).toBe(computeBalance(entries));
      }),
    );
  });
});

// ─── P2/P3 Append monotonicity ─────────────────────────────────────────────────

describe('P2 — Append monotonicity: adding a credit entry never lowers the balance', () => {
  it('balance with an appended credit >= balance without it', () => {
    fc.assert(
      fc.property(entriesGen, posCents, (entries, amount) => {
        const before = computeBalance(entries);
        const after = computeBalance([...entries, { direction: 'credit', amountCents: amount }]);
        expect(after).toBeGreaterThanOrEqual(before);
      }),
    );
  });
});

describe('P3 — Append monotonicity: adding a debit entry never raises the balance', () => {
  it('balance with an appended debit <= balance without it', () => {
    fc.assert(
      fc.property(entriesGen, posCents, (entries, amount) => {
        const before = computeBalance(entries);
        const after = computeBalance([...entries, { direction: 'debit', amountCents: amount }]);
        expect(after).toBeLessThanOrEqual(before);
      }),
    );
  });
});

// ─── P4 Integer closure ─────────────────────────────────────────────────────────

describe('P4 — Integer closure: the result is always an integer', () => {
  it('computeBalance always returns a safe integer', () => {
    fc.assert(
      fc.property(entriesGen, (entries) => {
        const result = computeBalance(entries);
        expect(Number.isInteger(result)).toBe(true);
        expect(Number.isSafeInteger(result)).toBe(true);
      }),
    );
  });
});

// ─── P5 Reversal cancellation ───────────────────────────────────────────────────

describe('P5 — Reversal cancellation: a same-amount debit+credit pair is a no-op', () => {
  it('appending a debit(X) then credit(X) leaves the balance unchanged', () => {
    fc.assert(
      fc.property(entriesGen, posCents, (entries, amount) => {
        const before = computeBalance(entries);
        const afterPair = computeBalance([
          ...entries,
          { direction: 'debit', amountCents: amount },
          { direction: 'credit', amountCents: amount },
        ]);
        expect(afterPair).toBe(before);
      }),
    );
  });

  it('appending a credit(X) then debit(X) leaves the balance unchanged', () => {
    fc.assert(
      fc.property(entriesGen, posCents, (entries, amount) => {
        const before = computeBalance(entries);
        const afterPair = computeBalance([
          ...entries,
          { direction: 'credit', amountCents: amount },
          { direction: 'debit', amountCents: amount },
        ]);
        expect(afterPair).toBe(before);
      }),
    );
  });
});

// ─── P6 Zero-entry edge ─────────────────────────────────────────────────────────

describe('P6 — Zero-entry edge: computeBalance([]) === 0', () => {
  it('the empty ledger has a zero balance', () => {
    expect(computeBalance([])).toBe(0);
  });
});

// ─── P7 Determinism ─────────────────────────────────────────────────────────────

describe('P7 — Determinism: same input twice ⇒ same output (pure)', () => {
  it('computeBalance(entries) === computeBalance(entries) for any valid entries', () => {
    fc.assert(
      fc.property(entriesGen, (entries) => {
        expect(computeBalance(entries)).toBe(computeBalance(entries));
      }),
    );
  });
});

// ─── P8/P9 Single-entry identities ──────────────────────────────────────────────

describe('P8 — Single credit entry: balance === that entry amount', () => {
  it('holds for all positive integer amounts', () => {
    fc.assert(
      fc.property(posCents, (amount) => {
        expect(computeBalance([{ direction: 'credit', amountCents: amount }])).toBe(amount);
      }),
    );
  });
});

describe('P9 — Single debit entry: balance === -(that entry amount)', () => {
  it('holds for all positive integer amounts', () => {
    fc.assert(
      fc.property(posCents, (amount) => {
        expect(computeBalance([{ direction: 'debit', amountCents: amount }])).toBe(-amount);
      }),
    );
  });
});

// ─── P10 Precondition: non-positive amountCents ⇒ throws ───────────────────────

describe('P10 — Non-positive amountCents always throws RangeError', () => {
  it('zero or negative amounts always throw', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 0 }), directionGen, (amount, direction) => {
        expect(() => computeBalance([{ direction, amountCents: amount }])).toThrow(RangeError);
      }),
    );
  });
});
