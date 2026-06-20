/**
 * types.ts — Result types for the global search API (Slice S1.1).
 *
 * SearchResult   — one matching entity.
 * SearchGroup    — a labelled group of results of the same type.
 * SearchOrgInput — validated caller input.
 * SearchOrgResult — the top-level return value of searchOrg.
 *
 * INVARIANTS:
 *   - primary is NEVER empty (member falls back to email).
 *   - path is slug-less (e.g. `/fleet/{id}`); the palette prepends `/o/{slug}`.
 *   - secondary may be null.
 *   - groups are in fixed type order; empty groups are OMITTED.
 */

/** The six entity types that the global search can return. */
export type SearchResultType =
  | 'aircraft'
  | 'member'
  | 'work_order'
  | 'squawk'
  | 'course'
  | 'reservation';

/** Human-readable labels for each type (used in the palette group headers). */
export const SEARCH_RESULT_TYPE_LABELS: Record<SearchResultType, string> = {
  aircraft:    'Aircraft',
  member:      'Members',
  work_order:  'Work Orders',
  squawk:      'Squawks',
  course:      'Courses',
  reservation: 'Reservations',
};

/** Fixed order for assembling the groups output. */
export const SEARCH_RESULT_TYPE_ORDER: SearchResultType[] = [
  'aircraft',
  'member',
  'work_order',
  'squawk',
  'course',
  'reservation',
];

/**
 * SearchResult — one matching entity returned by the global search.
 *
 * id       — the entity's UUID.
 * primary  — the main display field (never empty).
 * secondary — a secondary label (make+model, status, etc.), or null.
 * path     — slug-less route (e.g. `/fleet/{id}`).
 */
export interface SearchResult {
  id: string;
  primary: string;
  secondary: string | null;
  path: string;
}

/**
 * SearchGroup — a named group of results for one entity type.
 */
export interface SearchGroup {
  type: SearchResultType;
  label: string;
  results: SearchResult[];
}

/**
 * SearchOrgInput — the validated input shape for searchOrg.
 */
export interface SearchOrgInput {
  query: string;
}

/**
 * SearchOrgResult — the return value of searchOrg / searchOrgWithDb.
 *
 * groups — ordered list of non-empty groups (fixed type order).
 *          An empty result returns `{ groups: [] }`.
 */
export interface SearchOrgResult {
  groups: SearchGroup[];
}
