/**
 * db-rows.ts — one place for the driver-result-shape assumption.
 *
 * `tx.execute(sql\`...\`)` returns different shapes depending on the driver:
 * node-postgres yields a `QueryResult` with a `.rows` array, while pglite (used
 * in tests) yields the row array directly. Across the API package this was
 * bridged inline ~99 times as `(res.rows ?? res) as unknown as Array<T>` — a
 * doubly-unsafe cast duplicated at every raw-SQL call site.
 *
 * `extractRows<T>(result)` centralizes that single assumption so the cast lives
 * in exactly one tested place. Behavior is byte-equivalent to the inline form:
 * `.rows` when present, otherwise the result itself.
 */
export function extractRows<T>(result: { rows?: T[] } | T[]): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}
