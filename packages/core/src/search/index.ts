/**
 * @aeroops/core/search — pure search helpers (no I/O).
 *
 * escapeLike   — escape LIKE metacharacters in a user string (for ILIKE patterns).
 * rankResults  — sort search results prefix-first then alphabetical by primary.
 * makePrefixComparator — the raw comparator for use in property tests.
 */
export { escapeLike } from './escape-like.js';
export { rankResults, makePrefixComparator } from './rank-results.js';
export type { Rankable } from './rank-results.js';
