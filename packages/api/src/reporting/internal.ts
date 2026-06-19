/**
 * reporting/internal.ts — pure helpers for the reporting module.
 *
 * NOT exported from @aeroops/api. Contains:
 *   - resolveRange(range, now): { from: Date; to: Date }
 *     Rolling UTC window [now - Nd, now) (exclusive `to`).
 *
 * D4 (spec §2): range = rolling [now-Nd, now) in UTC. tz-neutral.
 * No imports from external modules — stays pure/deterministic.
 */

// ─── Range key ───────────────────────────────────────────────────────────────

export type RangeKey = '7d' | '30d' | '90d';

// ─── resolveRange ─────────────────────────────────────────────────────────────

/**
 * resolveRange — converts a range key into an absolute UTC window.
 *
 * Rolling window: [now - N days, now) — `to` is exclusive (half-open).
 * Both bounds are computed in UTC; no tz conversion is performed.
 *
 * @param range - '7d' | '30d' | '90d'
 * @param now   - Injected current time (enables deterministic unit tests).
 * @returns     - { from: Date, to: Date } where to === now (exclusive upper).
 */
export function resolveRange(
  range: RangeKey,
  now: Date,
): { from: Date; to: Date } {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;

  const to = new Date(now.getTime()); // copy, exclusive upper bound = now
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  return { from, to };
}
