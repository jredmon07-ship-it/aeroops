/**
 * escape-like.ts — Pure LIKE-escape helper for PostgreSQL ILIKE patterns.
 *
 * escapeLike(s) escapes the three LIKE metacharacters so that a user-supplied
 * string can be safely embedded in a LIKE / ILIKE pattern:
 *
 *   1. `\`  → `\\`   (escape character itself — MUST be escaped first)
 *   2. `%`  → `\%`   (match-any-sequence wildcard)
 *   3. `_`  → `\_`   (match-single-char wildcard)
 *
 * ORDER MATTERS: escape the backslash FIRST so that the subsequent replacements
 * do not double-escape the backslashes we just introduced.
 *
 * NOTE: this is for LIKE-semantics safety (prevents wildcards from matching
 * unintended characters). It is NOT a SQL-injection guard — that is handled
 * separately by passing the entire pattern as a bound parameter.
 *
 * Pure (no I/O). Property-tested in packages/core/src/__tests__/search.test.ts.
 */

/**
 * escapeLike — escape a raw user string so it can be embedded in a LIKE pattern.
 *
 * Usage: `ILIKE ${'%' + escapeLike(userInput) + '%'} ESCAPE '\'`
 *
 * @param s - The raw user-supplied string.
 * @returns A string safe to embed in a LIKE pattern; none of `%`, `_`, `\` act
 *          as wildcards.
 */
export function escapeLike(s: string): string {
  // 1. Escape the LIKE escape character itself FIRST (order is critical).
  // 2. Escape wildcard: % → \%
  // 3. Escape wildcard: _ → \_
  return s
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
}
