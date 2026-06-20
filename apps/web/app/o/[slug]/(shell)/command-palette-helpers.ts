/**
 * command-palette-helpers.ts — Pure, side-effect-free helpers for the ⌘K
 * command palette (Slice S1.2).
 *
 * Extracted so that:
 *   • command-palette.tsx (client component) can import + re-export them.
 *   • __tests__/command-palette-helpers.test.ts can import them directly
 *     without pulling in any React/Radix/DOM code.
 *
 * NO React, NO Radix, NO Next.js imports — safe for both environments.
 */

import type { SearchGroup, SearchResult, SearchResultType } from '@aeroops/api';

// ─── shouldSearch ─────────────────────────────────────────────────────────────

/**
 * shouldSearch — client min-length gate. Returns true only if query is worth
 * sending to the server. The server enforces the same rule; this is perf-only.
 */
export function shouldSearch(query: string): boolean {
  return query.trim().length >= 2;
}

// ─── buildHref ────────────────────────────────────────────────────────────────

/**
 * buildHref — prepend the org slug to the server's slug-less path.
 *
 * @param slug - the org slug (e.g. "acme-flight")
 * @param path - the server-returned slug-less path (e.g. "/fleet/abc-123")
 * @returns    - the full app path (e.g. "/o/acme-flight/fleet/abc-123")
 */
export function buildHref(slug: string, path: string): string {
  return `/o/${slug}${path}`;
}

// ─── FlatResult ───────────────────────────────────────────────────────────────

export interface FlatResult {
  optionId: string;
  groupType: SearchResultType;
  groupLabel: string;
  result: SearchResult;
  href: string;
  accessibleLabel: string;
}

// ─── flattenGroups ────────────────────────────────────────────────────────────

/**
 * flattenGroups — flatten a SearchGroup[] into an ordered flat list for
 * keyboard navigation. Each item carries its group label and an option id.
 */
export function flattenGroups(groups: SearchGroup[], slug: string): FlatResult[] {
  const flat: FlatResult[] = [];
  for (const group of groups) {
    for (let i = 0; i < group.results.length; i++) {
      const result = group.results[i]!;
      const secondary = result.secondary ? ` — ${result.secondary}` : '';
      flat.push({
        optionId: `palette-option-${group.type}-${i}`,
        groupType: group.type,
        groupLabel: group.label,
        result,
        href: buildHref(slug, result.path),
        accessibleLabel: `${group.label}: ${result.primary}${secondary}`,
      });
    }
  }
  return flat;
}

// ─── clampIndex ───────────────────────────────────────────────────────────────

/**
 * clampIndex — clamp a roving index to [0, length-1].
 * Returns -1 when length === 0 (no items to highlight).
 */
export function clampIndex(index: number, length: number): number {
  if (length === 0) return -1;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}
