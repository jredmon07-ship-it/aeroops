/**
 * alerts-bell-helpers.ts — Pure, side-effect-free helpers for the AlertsBell
 * component (Slice N1.2).
 *
 * Extracted so that:
 *   • alerts-bell.tsx (client component) can import + use them.
 *   • __tests__/alerts-bell-helpers.test.ts can import them directly
 *     without pulling in any React/Radix/DOM/Next.js code.
 *
 * NO React, NO Radix, NO Next.js, NO localStorage — safe for both environments.
 */

// ─── Seen-set storage key ─────────────────────────────────────────────────────

/**
 * seenSetKey — returns the localStorage key for the seen-alert id set.
 *
 * Format: aeroops:alerts-seen:{orgId}:{userId}
 * Per-tenant, per-user: never leaks across orgs or members.
 */
export function seenSetKey(orgId: string, userId: string): string {
  return `aeroops:alerts-seen:${orgId}:${userId}`;
}

// ─── Seen-set read/write (pure, localStorage-agnostic) ───────────────────────

/**
 * readSeenIds — parse the raw localStorage string into a Set<string>.
 * Returns an empty set on any parse failure (null, invalid JSON).
 * Called with the raw string from localStorage.getItem(key) — caller wraps
 * the localStorage access in try/catch; this fn handles JSON failures.
 */
export function readSeenIds(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((x): x is string => typeof x === 'string'));
    }
    return new Set();
  } catch {
    return new Set();
  }
}

/**
 * serializeSeenIds — serialize a Set<string> to a JSON string for storage.
 * Returns the JSON string; never throws.
 */
export function serializeSeenIds(seen: Set<string>): string {
  try {
    return JSON.stringify(Array.from(seen));
  } catch {
    return '[]';
  }
}

// ─── Prune stale ids ─────────────────────────────────────────────────────────

/**
 * pruneSeenIds — remove ids from the seen set that are no longer present
 * in the current alert list. Returns a NEW Set (does not mutate input).
 *
 * Prevents unbounded localStorage growth as alerts expire.
 */
export function pruneSeenIds(seen: Set<string>, currentIds: Set<string>): Set<string> {
  const pruned = new Set<string>();
  for (const id of seen) {
    if (currentIds.has(id)) {
      pruned.add(id);
    }
  }
  return pruned;
}

// ─── Unread count ─────────────────────────────────────────────────────────────

/**
 * computeUnreadCount — count alerts whose id is NOT in the seen set.
 */
export function computeUnreadCount(alertIds: string[], seen: Set<string>): number {
  return alertIds.filter((id) => !seen.has(id)).length;
}

// ─── Badge label (9+ clamp) ───────────────────────────────────────────────────

/**
 * badgeLabel — return the display string for the unread badge.
 * Clamps to "9+" when count > 9.
 */
export function badgeLabel(unread: number): string {
  if (unread > 9) return '9+';
  return String(unread);
}

// ─── Slug-less path → full href ───────────────────────────────────────────────

/**
 * buildAlertHref — prepend the org slug to the server's slug-less path.
 * Returns null when path is null (no obvious deep-link).
 *
 * @param slug - the org slug (e.g. "acme-flight")
 * @param path - the server-returned slug-less path, or null
 * @returns    - the full app path (e.g. "/o/acme-flight/schedule?date=2026-11-10"), or null
 */
export function buildAlertHref(slug: string, path: string | null): string | null {
  if (path === null) return null;
  return `/o/${slug}${path}`;
}
