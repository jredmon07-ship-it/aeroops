/**
 * rank-results.ts — Pure ranking comparator for global search results.
 *
 * RANKING RULE (deterministic, total, idempotent):
 *   1. Prefix-match first: results whose `primary` field starts with the query
 *      (case-insensitive) sort before non-prefix matches.
 *   2. Within the same prefix bucket, sort alphabetically by `lower(primary)`
 *      (ascending, case-insensitive).
 *
 * The comparator is stable and total — equal elements (same prefix rank AND
 * same lower(primary)) are considered equal (return 0).
 *
 * NOTE: The SQL ORDER BY clause mirrors this ranking so that pglite results
 * already arrive sorted. rankResults is used in pure property tests and as
 * a fallback for in-memory sorting after retrieval.
 *
 * Pure (no I/O). Property-tested in packages/core/src/__tests__/search.test.ts.
 */

/** Minimal shape required for ranking. */
export interface Rankable {
  /** The primary display field (tail number, full name, title, …). */
  primary: string;
}

/**
 * makePrefixComparator — returns a comparison function that implements the
 * prefix-first, then lower(primary)-alphabetical ranking rule.
 *
 * @param query - The raw (un-escaped) search query used to detect prefix matches.
 * @returns A comparator `(a, b) => number` suitable for Array.prototype.sort().
 */
export function makePrefixComparator<T extends Rankable>(
  query: string,
): (a: T, b: T) => number {
  const lowerQuery = query.toLowerCase();

  return (a: T, b: T): number => {
    const aIsPrefix = a.primary.toLowerCase().startsWith(lowerQuery) ? 0 : 1;
    const bIsPrefix = b.primary.toLowerCase().startsWith(lowerQuery) ? 0 : 1;

    // Primary sort: prefix matches (rank 0) before non-prefix (rank 1).
    if (aIsPrefix !== bIsPrefix) return aIsPrefix - bIsPrefix;

    // Secondary sort: lower(primary) ascending — case-insensitive alphabetical.
    const aLower = a.primary.toLowerCase();
    const bLower = b.primary.toLowerCase();
    if (aLower < bLower) return -1;
    if (aLower > bLower) return 1;
    return 0;
  };
}

/**
 * rankResults — sort a results array in-place using the prefix-first ranking rule.
 *
 * Mutates and returns the same array (consistent with Array.prototype.sort).
 *
 * @param results - The array of Rankable items to sort.
 * @param query   - The raw search query (un-escaped).
 * @returns The same array, sorted in place.
 */
export function rankResults<T extends Rankable>(results: T[], query: string): T[] {
  return results.sort(makePrefixComparator<T>(query));
}
