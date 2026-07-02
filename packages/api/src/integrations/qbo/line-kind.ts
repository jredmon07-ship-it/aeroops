/**
 * line-kind.ts — the shared QBO GL-mapping "kind" domain (Slice QB1).
 *
 * Mirrors rate_schedule.rate_kind (migration 0019: 'wet_hourly' |
 * 'dry_hourly' | 'instruction' | 'flat') plus two synthetic buckets:
 *   'other'   — invoice line items with no rate_schedule_id.
 *   'default' — an operator-set catch-all mapping row.
 *
 * MUST stay byte-identical to the qbo_account_mapping_line_kind_check
 * CHECK constraint in migration 0021.
 */

export const QBO_LINE_KINDS = [
  'wet_hourly',
  'dry_hourly',
  'instruction',
  'flat',
  'other',
  'default',
] as const;

export type QboLineKind = (typeof QBO_LINE_KINDS)[number];

/**
 * QBO_MAPPABLE_LINE_KINDS — the kinds that can actually appear ON an
 * invoice line (excludes 'default', which is a mapping-table-only fallback
 * row, never a line's own kind).
 */
export const QBO_MAPPABLE_LINE_KINDS = [
  'wet_hourly',
  'dry_hourly',
  'instruction',
  'flat',
  'other',
] as const;

export type QboMappableLineKind = (typeof QBO_MAPPABLE_LINE_KINDS)[number];

/** Type guard: is `value` one of the four rate_schedule.rate_kind values? */
function isRateKind(value: string): value is 'wet_hourly' | 'dry_hourly' | 'instruction' | 'flat' {
  return value === 'wet_hourly' || value === 'dry_hourly' || value === 'instruction' || value === 'flat';
}

/**
 * resolveLineKind — derive an invoice line item's QBO GL-mapping kind.
 *
 * A line with a rate_schedule_id inherits that rate's rate_kind. A line
 * with no rate_schedule_id (a manual/ad-hoc charge, e.g. an operator-typed
 * landing fee or fuel surcharge) resolves to 'other'.
 *
 * @param rateKind - The joined rate_schedule.rate_kind for this line, or
 *                   null when the line has no rate_schedule_id.
 * @returns A QboMappableLineKind — never 'default'.
 */
export function resolveLineKind(rateKind: string | null | undefined): QboMappableLineKind {
  if (rateKind && isRateKind(rateKind)) {
    return rateKind;
  }
  return 'other';
}

/** Runtime guard for a value read back from qbo_account_mapping.line_kind. */
export function isQboLineKind(value: string): value is QboLineKind {
  return (QBO_LINE_KINDS as readonly string[]).includes(value);
}
