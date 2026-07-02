/**
 * format-cents.ts — pure integer-cents → dollar-string display helper.
 *
 * DISPLAY ONLY — never used for money arithmetic (the source of truth for
 * all money math is @aeroops/core's integer-cents functions). This is the
 * standard `(cents / 100).toFixed(2)` display pattern already used
 * elsewhere in the billing command layer (generate-invoice.ts).
 */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}
