/**
 * integrations/qbo/map-invoice.ts — PURE mapping from an AeroOps invoice +
 * line items + per-org account mapping to a QBO Invoice create payload
 * (Slice QB1).
 *
 * NO I/O, no Drizzle, no fetch, no clock, no randomness. This is the
 * property-tested money-math boundary for the QBO export.
 *
 * ── PER-LINE-ITEM-CATEGORY GL MAPPING (the competitive wedge) ─────────────────
 * Each AeroOps invoice_line_item becomes its OWN QBO Line with the ItemRef
 * mapped for its `lineKind` (aircraft rental revenue / instructor time /
 * other charge kinds land in their own operator-chosen QBO Item/account) —
 * NEVER a single lumped-sum line. If any line's kind has no mapping AND no
 * 'default' fallback mapping exists, mapInvoiceToQboPayload REFUSES the
 * whole export and lists every unmapped kind — it never silently lumps
 * unmapped lines into a generic bucket.
 *
 * ── MONEY: CENTS → QBO DECIMAL, NEVER FLOAT ARITHMETIC ────────────────────────
 * Every amount here starts as an INTEGER CENTS value (already computed and
 * snapshotted by Slice B1 — this module never recomputes a line total).
 * Cents are converted to a QBO decimal dollar amount via INTEGER division +
 * modulo only (centsToDollarString) — never `cents / 100` float division —
 * so a Line's Amount always round-trips back to the exact original cents.
 * QBO's JSON transport requires the Amount field to be a JSON number, so the
 * final step (Number(dollarString)) is an unavoidable, lossless parse of an
 * already-exact 2-decimal string — not an arithmetic operation.
 *
 * ── DocNumber ─────────────────────────────────────────────────────────────────
 * Slice B1's invoice table has no dedicated human invoice-number column
 * (uuid id only). DocNumber uses a short operator-facing form derived from
 * the invoice id: "AO-" + the first 8 hex chars, uppercased (e.g.
 * "AO-3F2A9C10"). [VERIFY-QB1-DOC]: a dedicated sequential invoice_number
 * column is a natural follow-up if operators want QBO doc numbers to match
 * an existing numbering scheme.
 *
 * NO Stripe, NO card/bank data, NO payment. This is a bookkeeping export of
 * an EXISTING invoice record.
 */

import type { QboInvoiceLine, QboInvoicePayload } from './client.js';
import type { QboMappableLineKind, QboLineKind } from './line-kind.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** One AeroOps invoice line item, already resolved to its GL-mapping kind. */
export interface QboLineItemInput {
  description: string;
  /** flight hours (matches invoice_line_item.quantity_hours) — used as QBO Qty. */
  quantityHours: number;
  /** integer cents — matches invoice_line_item.unit_amount_cents. */
  unitAmountCents: number;
  /** integer cents — matches invoice_line_item.line_total_cents (snapshotted). */
  lineTotalCents: number;
  lineKind: QboMappableLineKind;
}

/** One qbo_account_mapping row, keyed by line_kind (including 'default'). */
export interface QboAccountMappingEntry {
  qboItemId: string;
  qboItemName: string;
}

/** The org's full account mapping — a dict keyed by QboLineKind (sparse). */
export type QboAccountMap = Partial<Record<QboLineKind, QboAccountMappingEntry>>;

export interface MapInvoiceInput {
  /** The AeroOps invoice id — embedded verbatim in PrivateNote for traceability. */
  aeroopsInvoiceId: string;
  /** integer cents — matches invoice.total_cents. Used only to sanity-check the sum. */
  totalCents: number;
  customerRef: { value: string; name?: string };
  lines: readonly QboLineItemInput[];
  accountMap: QboAccountMap;
}

export type MapInvoiceResult =
  | { ok: true; payload: QboInvoicePayload }
  | { ok: false; reason: 'no_lines' }
  | { ok: false; reason: 'unmapped_kinds'; kinds: QboMappableLineKind[] }
  | { ok: false; reason: 'total_mismatch'; expectedCents: number; computedCents: number };

// ─── Money helpers (integer-only; see module header) ─────────────────────────

/**
 * centsToDollarString — integer cents → a 2-decimal dollar string, using
 * only integer subtraction/modulo/division-of-a-multiple-of-100 — never
 * `cents / 100` float division on the raw value.
 *
 * @param cents non-negative integer cents.
 */
function centsToDollarString(cents: number): string {
  const wholeCents = Math.trunc(cents);
  const remainder = wholeCents % 100;
  const dollars = (wholeCents - remainder) / 100; // exact: divides a multiple of 100
  return `${dollars}.${String(remainder).padStart(2, '0')}`;
}

/** cents → a QBO-ready JSON number (lossless parse of the exact decimal string). */
function centsToQboAmount(cents: number): number {
  return Number(centsToDollarString(cents));
}

// ─── DocNumber helper ──────────────────────────────────────────────────────────

function docNumberFor(aeroopsInvoiceId: string): string {
  const compact = aeroopsInvoiceId.replace(/-/g, '').slice(0, 8).toUpperCase();
  return `AO-${compact}`;
}

// ─── Mapping resolution (own-property-safe) ─────────────────────────────────────

/**
 * resolveLineMapping — accountMap[kind] ?? accountMap['default'], but confined
 * to OWN properties. A plain-object index like accountMap['__proto__'] resolves
 * to a truthy prototype value (Object.prototype), which would slip past the
 * `?? default` fallback AND the unmapped guard, then emit a QBO line with an
 * undefined ItemRef. hasOwnProperty restricts resolution to real mapping entries.
 */
function resolveLineMapping(
  accountMap: QboAccountMap,
  kind: QboLineKind,
): QboAccountMappingEntry | undefined {
  const own = Object.prototype.hasOwnProperty;
  const direct = own.call(accountMap, kind) ? accountMap[kind] : undefined;
  if (direct) return direct;
  return own.call(accountMap, 'default') ? accountMap['default'] : undefined;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * mapInvoiceToQboPayload — build the QBO Invoice create payload from an
 * AeroOps invoice's line items, with each line mapped to its OWN QBO
 * ItemRef by kind.
 *
 * Resolution per line: accountMap[line.lineKind] ?? accountMap['default'].
 * If still unresolved for ANY line, the whole export is refused and every
 * unmapped kind is listed (deduplicated) — never a silent lump.
 *
 * @returns ok:true with the payload, or a typed refusal.
 */
export function mapInvoiceToQboPayload(input: MapInvoiceInput): MapInvoiceResult {
  if (input.lines.length === 0) {
    return { ok: false, reason: 'no_lines' };
  }

  // Resolve every line's ItemRef; collect any unmapped kinds first (never
  // partially build a payload that silently drops or lumps a line).
  const unmapped = new Set<QboMappableLineKind>();
  for (const line of input.lines) {
    const mapping = resolveLineMapping(input.accountMap, line.lineKind);
    if (!mapping) {
      unmapped.add(line.lineKind);
    }
  }
  if (unmapped.size > 0) {
    return { ok: false, reason: 'unmapped_kinds', kinds: Array.from(unmapped) };
  }

  const qboLines: QboInvoiceLine[] = input.lines.map((line) => {
    const mapping = resolveLineMapping(input.accountMap, line.lineKind);
    // Unreachable (guarded above), but keep TS honest without a non-null assertion.
    if (!mapping) {
      throw new Error('[qbo] mapInvoiceToQboPayload: internal invariant violated — unmapped line survived the guard');
    }
    return {
      DetailType: 'SalesItemLineDetail',
      Amount: centsToQboAmount(line.lineTotalCents),
      Description: line.description,
      SalesItemLineDetail: {
        ItemRef: { value: mapping.qboItemId, name: mapping.qboItemName },
        Qty: line.quantityHours,
        UnitPrice: centsToQboAmount(line.unitAmountCents),
      },
    };
  });

  // Sanity check: the sum of line totals (integer cents — exact) must equal
  // the invoice's stored total_cents. This is a pure-function invariant
  // check (Slice B1's computeInvoiceTotals guarantees this on write) — if it
  // ever fails, refuse rather than push a mismatched invoice to QBO.
  const computedCents = input.lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
  if (computedCents !== input.totalCents) {
    return { ok: false, reason: 'total_mismatch', expectedCents: input.totalCents, computedCents };
  }

  return {
    ok: true,
    payload: {
      Line: qboLines,
      CustomerRef: input.customerRef,
      DocNumber: docNumberFor(input.aeroopsInvoiceId),
      PrivateNote: `AeroOps invoice ${input.aeroopsInvoiceId}`,
    },
  };
}

// Exported for property tests (round-trip verification without duplicating
// the integer-only conversion logic in the test file).
export const __internal = { centsToDollarString, centsToQboAmount, docNumberFor };
