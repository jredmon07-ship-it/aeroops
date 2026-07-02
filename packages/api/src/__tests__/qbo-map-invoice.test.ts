/**
 * qbo-map-invoice.test.ts — unit + property tests for the PURE QBO invoice
 * mapper (Slice QB1 — the money-math boundary; CLAUDE.md HARD GUARDRAIL:
 * money math gets property-based tests).
 *
 * WHAT WE PROVE:
 *   Unit:
 *     - Empty lines → { ok:false, reason:'no_lines' }.
 *     - Every line kind mapped → ok:true, per-line ItemRef matches its kind.
 *     - A missing kind falls back to the 'default' mapping row when present.
 *     - A missing kind with NO 'default' row → { ok:false,
 *       reason:'unmapped_kinds' } listing every distinct unmapped kind —
 *       NEVER a partially-built/lumped payload.
 *     - DocNumber derivation is deterministic + stable.
 *     - PrivateNote embeds the AeroOps invoice id verbatim.
 *
 *   Properties (fast-check):
 *     P1 Arbitrary line items (all kinds mapped) → per-line QBO Amount,
 *        parsed back to cents, equals the original lineTotalCents exactly
 *        (no float drift) — for every line, not just the sum.
 *     P2 Sum of per-line Amounts (parsed back to cents) === invoice
 *        totalCents, for arbitrary integer-cent line items whose sum
 *        equals totalCents (the B1 computeInvoiceTotals invariant).
 *     P3 Each Line's ItemRef.value === accountMap[line.lineKind].qboItemId.
 *     P4 Unmapped-kind detection: any line whose kind is absent from the
 *        account map (and no 'default' row) => ok:false with that kind
 *        listed; deduplicated across repeated occurrences.
 *     P5 Determinism: same input => byte-identical result.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { mapInvoiceToQboPayload, __internal } from '../integrations/qbo/map-invoice.js';
import type { QboLineItemInput, QboAccountMap } from '../integrations/qbo/map-invoice.js';
import { QBO_MAPPABLE_LINE_KINDS } from '../integrations/qbo/line-kind.js';
import type { QboMappableLineKind } from '../integrations/qbo/line-kind.js';

const { centsToDollarString } = __internal;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const FULL_MAP: QboAccountMap = {
  wet_hourly: { qboItemId: 'item-wet', qboItemName: 'Aircraft Rental (Wet)' },
  dry_hourly: { qboItemId: 'item-dry', qboItemName: 'Aircraft Rental (Dry)' },
  instruction: { qboItemId: 'item-instruction', qboItemName: 'Instructor Time' },
  flat: { qboItemId: 'item-flat', qboItemName: 'Flat Fees' },
  other: { qboItemId: 'item-other', qboItemName: 'Other Charges' },
};

function line(overrides: Partial<QboLineItemInput> = {}): QboLineItemInput {
  return {
    description: 'Test line',
    quantityHours: 1.0,
    unitAmountCents: 10000,
    lineTotalCents: 10000,
    lineKind: 'wet_hourly',
    ...overrides,
  };
}

// ─── Unit tests ───────────────────────────────────────────────────────────────

describe('mapInvoiceToQboPayload — unit', () => {
  it('empty lines => ok:false, no_lines', () => {
    const result = mapInvoiceToQboPayload({
      aeroopsInvoiceId: '11111111-1111-1111-1111-111111111111',
      totalCents: 0,
      customerRef: { value: 'cust-1' },
      lines: [],
      accountMap: FULL_MAP,
    });
    expect(result).toEqual({ ok: false, reason: 'no_lines' });
  });

  it('every kind mapped => ok:true, one QBO Line per AeroOps line item', () => {
    const lines = [
      line({ lineKind: 'wet_hourly', lineTotalCents: 12500 }),
      line({ lineKind: 'instruction', lineTotalCents: 5000 }),
    ];
    const result = mapInvoiceToQboPayload({
      aeroopsInvoiceId: '11111111-1111-1111-1111-111111111111',
      totalCents: 17500,
      customerRef: { value: 'cust-1', name: 'Jane Pilot' },
      lines,
      accountMap: FULL_MAP,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.Line).toHaveLength(2);
    expect(result.payload.Line[0]?.SalesItemLineDetail.ItemRef.value).toBe('item-wet');
    expect(result.payload.Line[1]?.SalesItemLineDetail.ItemRef.value).toBe('item-instruction');
    expect(result.payload.CustomerRef).toEqual({ value: 'cust-1', name: 'Jane Pilot' });
  });

  it('per-line kind never lumped: distinct kinds get distinct ItemRefs (no single fallback line)', () => {
    const lines = [
      line({ lineKind: 'wet_hourly', lineTotalCents: 100 }),
      line({ lineKind: 'flat', lineTotalCents: 200 }),
      line({ lineKind: 'other', lineTotalCents: 300 }),
    ];
    const result = mapInvoiceToQboPayload({
      aeroopsInvoiceId: '11111111-1111-1111-1111-111111111111',
      totalCents: 600,
      customerRef: { value: 'cust-1' },
      lines,
      accountMap: FULL_MAP,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const itemRefs = result.payload.Line.map((l) => l.SalesItemLineDetail.ItemRef.value);
    expect(itemRefs).toEqual(['item-wet', 'item-flat', 'item-other']);
  });

  it("missing kind falls back to a 'default' mapping row when present", () => {
    const mapWithDefault: QboAccountMap = {
      wet_hourly: { qboItemId: 'item-wet', qboItemName: 'Aircraft Rental (Wet)' },
      default: { qboItemId: 'item-catchall', qboItemName: 'Catch-all' },
    };
    const lines = [line({ lineKind: 'wet_hourly' }), line({ lineKind: 'instruction' })];
    const result = mapInvoiceToQboPayload({
      aeroopsInvoiceId: '11111111-1111-1111-1111-111111111111',
      totalCents: 20000,
      customerRef: { value: 'cust-1' },
      lines,
      accountMap: mapWithDefault,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.Line[0]?.SalesItemLineDetail.ItemRef.value).toBe('item-wet');
    expect(result.payload.Line[1]?.SalesItemLineDetail.ItemRef.value).toBe('item-catchall');
  });

  it('missing kind with NO default row => ok:false, unmapped_kinds, never a partial payload', () => {
    const lines = [line({ lineKind: 'wet_hourly' }), line({ lineKind: 'instruction' }), line({ lineKind: 'flat' })];
    const partialMap: QboAccountMap = {
      wet_hourly: { qboItemId: 'item-wet', qboItemName: 'Aircraft Rental (Wet)' },
    };
    const result = mapInvoiceToQboPayload({
      aeroopsInvoiceId: '11111111-1111-1111-1111-111111111111',
      totalCents: 30000,
      customerRef: { value: 'cust-1' },
      lines,
      accountMap: partialMap,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unmapped_kinds');
    if (result.reason !== 'unmapped_kinds') return;
    expect(result.kinds.sort()).toEqual(['flat', 'instruction']);
  });

  it('unmapped kinds are deduplicated across repeated occurrences', () => {
    const lines = [line({ lineKind: 'instruction' }), line({ lineKind: 'instruction' }), line({ lineKind: 'instruction' })];
    const result = mapInvoiceToQboPayload({
      aeroopsInvoiceId: '11111111-1111-1111-1111-111111111111',
      totalCents: 30000,
      customerRef: { value: 'cust-1' },
      lines,
      accountMap: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unmapped_kinds');
    if (result.reason !== 'unmapped_kinds') return;
    expect(result.kinds).toEqual(['instruction']);
  });

  it('total mismatch (B1 invariant violated) => ok:false, total_mismatch', () => {
    const lines = [line({ lineTotalCents: 100 })];
    const result = mapInvoiceToQboPayload({
      aeroopsInvoiceId: '11111111-1111-1111-1111-111111111111',
      totalCents: 999, // deliberately wrong
      customerRef: { value: 'cust-1' },
      lines,
      accountMap: FULL_MAP,
    });
    expect(result).toEqual({ ok: false, reason: 'total_mismatch', expectedCents: 999, computedCents: 100 });
  });

  it('DocNumber is derived from the invoice id, deterministic', () => {
    const id = '3f2a9c10-abcd-4444-8888-000000000000';
    const lines = [line({ lineTotalCents: 100 })];
    const result = mapInvoiceToQboPayload({
      aeroopsInvoiceId: id,
      totalCents: 100,
      customerRef: { value: 'cust-1' },
      lines,
      accountMap: FULL_MAP,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.DocNumber).toBe('AO-3F2A9C10');
  });

  it('PrivateNote embeds the AeroOps invoice id verbatim', () => {
    const id = '3f2a9c10-abcd-4444-8888-000000000000';
    const lines = [line({ lineTotalCents: 100 })];
    const result = mapInvoiceToQboPayload({
      aeroopsInvoiceId: id,
      totalCents: 100,
      customerRef: { value: 'cust-1' },
      lines,
      accountMap: FULL_MAP,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.PrivateNote).toBe(`AeroOps invoice ${id}`);
  });

  it('centsToDollarString: exact 2-decimal formatting, no float drift', () => {
    expect(centsToDollarString(0)).toBe('0.00');
    expect(centsToDollarString(1)).toBe('0.01');
    expect(centsToDollarString(100)).toBe('1.00');
    expect(centsToDollarString(12345)).toBe('123.45');
    expect(centsToDollarString(100000000)).toBe('1000000.00');
  });
});

// ─── Property tests ─────────────────────────────────────────────────────────

/** Non-negative integer cents, realistic per-line bound ($0–$100,000). */
const cents = fc.integer({ min: 0, max: 10_000_000 });

/** Non-negative decimal hours on the 0.1 grid. */
const hours = fc.integer({ min: 0, max: 10_000 }).map((t) => t / 10);

const lineKindGen = fc.constantFrom(...QBO_MAPPABLE_LINE_KINDS);

const lineGen: fc.Arbitrary<QboLineItemInput> = fc.record({
  description: fc.constant('Test line'),
  quantityHours: hours,
  unitAmountCents: cents,
  lineTotalCents: cents,
  lineKind: lineKindGen,
});

describe('mapInvoiceToQboPayload — properties', () => {
  it('P1: per-line Amount round-trips exactly to the original lineTotalCents (all kinds mapped)', () => {
    fc.assert(
      fc.property(lineGen, (l) => {
        const result = mapInvoiceToQboPayload({
          aeroopsInvoiceId: '11111111-1111-1111-1111-111111111111',
          totalCents: l.lineTotalCents,
          customerRef: { value: 'cust-1' },
          lines: [l],
          accountMap: FULL_MAP,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const amount = result.payload.Line[0]?.Amount ?? -1;
        const roundTripCents = Math.round(amount * 100);
        expect(roundTripCents).toBe(l.lineTotalCents);
      }),
      { numRuns: 500 },
    );
  });

  it('P2: sum of per-line Amounts (parsed back to cents) === invoice totalCents', () => {
    fc.assert(
      fc.property(fc.array(lineGen, { minLength: 1, maxLength: 25 }), (rawLines) => {
        // Construct totalCents = exact integer sum (the B1 invariant this
        // mapper relies on — computeInvoiceTotals guarantees it on write).
        const totalCents = rawLines.reduce((sum, l) => sum + l.lineTotalCents, 0);
        const result = mapInvoiceToQboPayload({
          aeroopsInvoiceId: '11111111-1111-1111-1111-111111111111',
          totalCents,
          customerRef: { value: 'cust-1' },
          lines: rawLines,
          accountMap: FULL_MAP,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const summedCents = result.payload.Line.reduce(
          (sum, l) => sum + Math.round(l.Amount * 100),
          0,
        );
        expect(summedCents).toBe(totalCents);
      }),
      { numRuns: 300 },
    );
  });

  it('P3: each Line ItemRef.value matches accountMap[line.lineKind].qboItemId', () => {
    fc.assert(
      fc.property(fc.array(lineGen, { minLength: 1, maxLength: 10 }), (rawLines) => {
        const totalCents = rawLines.reduce((sum, l) => sum + l.lineTotalCents, 0);
        const result = mapInvoiceToQboPayload({
          aeroopsInvoiceId: '11111111-1111-1111-1111-111111111111',
          totalCents,
          customerRef: { value: 'cust-1' },
          lines: rawLines,
          accountMap: FULL_MAP,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        result.payload.Line.forEach((qboLine, i) => {
          const expectedKind = rawLines[i]?.lineKind as QboMappableLineKind;
          expect(qboLine.SalesItemLineDetail.ItemRef.value).toBe(FULL_MAP[expectedKind]?.qboItemId);
        });
      }),
      { numRuns: 300 },
    );
  });

  it('P4: any line whose kind is unmapped (no default) => ok:false listing that kind', () => {
    fc.assert(
      fc.property(lineGen, (l) => {
        const result = mapInvoiceToQboPayload({
          aeroopsInvoiceId: '11111111-1111-1111-1111-111111111111',
          totalCents: l.lineTotalCents,
          customerRef: { value: 'cust-1' },
          lines: [l],
          accountMap: {}, // nothing mapped, no default
        });
        expect(result).toEqual({ ok: false, reason: 'unmapped_kinds', kinds: [l.lineKind] });
      }),
      { numRuns: 200 },
    );
  });

  it('P5: determinism — same input produces a byte-identical result', () => {
    fc.assert(
      fc.property(fc.array(lineGen, { minLength: 1, maxLength: 10 }), (rawLines) => {
        const totalCents = rawLines.reduce((sum, l) => sum + l.lineTotalCents, 0);
        const input = {
          aeroopsInvoiceId: '11111111-1111-1111-1111-111111111111',
          totalCents,
          customerRef: { value: 'cust-1' },
          lines: rawLines,
          accountMap: FULL_MAP,
        };
        const a = mapInvoiceToQboPayload(input);
        const b = mapInvoiceToQboPayload(input);
        expect(a).toEqual(b);
      }),
      { numRuns: 200 },
    );
  });
});
