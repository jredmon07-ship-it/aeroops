/**
 * retention-utils.ts — Pure display helpers for the booking-request retention card.
 *
 * PURE: no I/O, no DOM, no Next.js, no React. Unit-testable in isolation.
 * Extracted from retention-settings.tsx so vitest (node environment) can import
 * them without parsing JSX.
 *
 * Exported for use by RetentionSettingsCard and tests.
 */

// ─── formatRetentionSummary ───────────────────────────────────────────────────

/**
 * formatRetentionSummary — human-readable summary of the active retention window.
 *
 * Describes the configured window in a single sentence. Does NOT cover the
 * days=0 case (keep-forever) — callers should guard for that separately.
 *
 * Examples:
 *   365 → "Booking requests are kept for 365 days, then permanently deleted."
 *   1   → "Booking requests are kept for 1 day, then permanently deleted."
 *   90  → "Booking requests are kept for 90 days, then permanently deleted."
 *   0   → "Retention is OFF — booking requests are kept indefinitely." (days=0 case)
 *
 * @param retentionDays - The configured retention window in days (0 = keep-forever).
 * @returns              - A human-readable sentence.
 */
export function formatRetentionSummary(retentionDays: number): string {
  if (retentionDays === 0) {
    return 'Retention is OFF — booking requests are kept indefinitely.';
  }
  const dayWord = retentionDays === 1 ? 'day' : 'days';
  return `Booking requests are kept for ${retentionDays} ${dayWord}, then permanently deleted.`;
}

// ─── formatDeletedCount ───────────────────────────────────────────────────────

/**
 * formatDeletedCount — summarizes the result of a purge apply.
 *
 * Examples:
 *   0  → "No requests were deleted."
 *   1  → "1 request was permanently deleted."
 *   42 → "42 requests were permanently deleted."
 *
 * @param count - The number of requests actually deleted (from deletedCount).
 * @returns      - A human-readable summary sentence.
 */
export function formatDeletedCount(count: number): string {
  if (count === 0) return 'No requests were deleted.';
  if (count === 1) return '1 request was permanently deleted.';
  return `${count} requests were permanently deleted.`;
}
