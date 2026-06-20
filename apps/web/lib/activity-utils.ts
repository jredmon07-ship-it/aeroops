/**
 * lib/activity-utils.ts — Pure helpers for the Activity feed page (Slice A1.2).
 *
 * Extracted so they are independently testable (no Next.js, no DOM, no DB).
 *
 * PURE: no I/O; safe to import in both RSC and test environments.
 */

// ─── Relative time formatter ──────────────────────────────────────────────────

/**
 * formatRelativeTime — returns a concise relative-time string from an ISO
 * timestamp string (e.g. "2h ago", "3d ago", "just now").
 *
 * Thresholds (all computed from millisecond delta, always non-negative):
 *   < 60 s   → "just now"
 *   < 60 min → "{n}m ago"
 *   < 24 h   → "{n}h ago"
 *   < 30 d   → "{n}d ago"
 *   < 365 d  → "{n}wk ago"
 *   ≥ 365 d  → "{n}yr ago"
 *
 * Never throws. Returns "—" on any parse failure.
 * Future timestamps (delta < 0) are treated as "just now".
 *
 * @param iso - ISO 8601 date string (as serialized at the action boundary).
 * @param now - Override "now" for testability; defaults to new Date().
 */
export function formatRelativeTime(iso: string, now?: Date): string {
  try {
    const then = new Date(iso);
    if (isNaN(then.getTime())) return '—';
    const base = now ?? new Date();
    const deltaMs = base.getTime() - then.getTime();
    if (deltaMs < 0) return 'just now';

    const secs = Math.floor(deltaMs / 1000);
    if (secs < 60) return 'just now';

    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;

    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;

    if (days < 365) {
      const weeks = Math.floor(days / 7);
      return `${weeks}wk ago`;
    }

    const years = Math.floor(days / 365);
    return `${years}yr ago`;
  } catch {
    return '—';
  }
}
