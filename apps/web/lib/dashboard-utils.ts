/**
 * lib/dashboard-utils.ts — Pure helpers for the Slice-7 ops dashboard.
 *
 * Extracted so they are independently testable (no Next.js, no DOM, no DB).
 *
 * PURE: no I/O; safe to import in both RSC and test environments.
 */

// ─── Range key ────────────────────────────────────────────────────────────────

export type DashboardRangeKey = '7d' | '30d' | '90d';

/**
 * resolveRangeKey — validates a raw ?range= string and falls back to '30d'.
 *
 * Contract: any input that is not '7d'/'30d'/'90d' → returns '30d' (default).
 * Spec §3: "validate→fallback 30d".
 */
export function resolveRangeKey(
  raw: string | string[] | undefined | null,
): DashboardRangeKey {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === '7d' || v === '30d' || v === '90d') return v;
  return '30d';
}

/**
 * rangeLabelFull — human-readable label for a range key.
 *
 * Used in heading labels like "Last 30 days".
 */
export function rangeLabelFull(key: DashboardRangeKey): string {
  if (key === '7d') return '7 days';
  if (key === '90d') return '90 days';
  return '30 days';
}

/**
 * formatUtcTime — format a UTC ISO string as HH:MM.
 *
 * [VERIFY-7-TZ]: UTC-day fallback; labelled "UTC" in the UI.
 * Returns '—' on any parse failure (never throws).
 */
export function formatUtcTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  } catch {
    return '—';
  }
}

/**
 * clampBarWidth — clamp a utilization proportion to [0, 100].
 *
 * If maxHours is 0, returns 0 (all bars are empty — correct for zero-flight fleet).
 */
export function clampBarWidth(flightHours: number, maxHours: number): number {
  if (maxHours <= 0 || flightHours < 0) return 0;
  return Math.min(100, (flightHours / maxHours) * 100);
}
