/**
 * _utils/resource-map.ts — Resource lookup helpers for the schedule module.
 *
 * Builds an in-memory Map from resource id → display name to resolve resource
 * names on reservation cards without N extra queries.
 */
import type { ResourceRow } from '@aeroops/api';

/**
 * buildResourceMap — builds a Map<id, ResourceRow> from a ResourceRow array.
 * Deactivated resources remain in the map so stale reservations can show names.
 */
export function buildResourceMap(resources: ResourceRow[]): Map<string, ResourceRow> {
  return new Map(resources.map((r) => [r.id, r]));
}

/**
 * resolveResourceName — returns the display name for a resource id.
 * Falls back to "Unknown resource" (italic, slate-400) if not found.
 */
export function resolveResourceName(
  resourceId: string,
  resourceMap: Map<string, ResourceRow>,
): { name: string; unknown: boolean } {
  const row = resourceMap.get(resourceId);
  if (!row) return { name: 'Unknown resource', unknown: true };
  return { name: row.displayName, unknown: false };
}

/**
 * sortResourceIds — sorts resource ids so aircraft come before instructors,
 * matching the display order specified in spec §3.
 */
export function sortResourceIds(
  ids: string[],
  resourceMap: Map<string, ResourceRow>,
): string[] {
  return [...ids].sort((a, b) => {
    const ra = resourceMap.get(a);
    const rb = resourceMap.get(b);
    const kindA = ra?.kind ?? 'z';
    const kindB = rb?.kind ?? 'z';
    // aircraft < instructor alphabetically — but we want aircraft first
    if (kindA === 'aircraft' && kindB !== 'aircraft') return -1;
    if (kindA !== 'aircraft' && kindB === 'aircraft') return 1;
    return 0;
  });
}
