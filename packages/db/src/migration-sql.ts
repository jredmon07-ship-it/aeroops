/**
 * migration-sql.ts — Shared loader for the on-disk migration files.
 *
 * Replaces the hand-maintained `const MIGRATION_SQL = [readFileSync(...), ...]`
 * arrays duplicated across test files. Reads packages/db/migrations/*.sql
 * (excluding *.down.sql), sorted by filename — i.e. in application order.
 *
 * DELIBERATELY pglite-free (node builtins only) so the @aeroops/db barrel can
 * re-export it STATICALLY without pulling @electric-sql/pglite (WASM) into the
 * production server bundle (see testing.ts header for why that matters).
 * It performs filesystem reads, so it is only ever CALLED from tests/tooling.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../migrations',
);

/**
 * loadMigrationSql — returns the SQL text of every up migration, in order.
 *
 * @param upToPrefix - optional numeric filename prefix (e.g. '0039'); when
 *                     given, only migrations whose prefix sorts <= it are
 *                     returned (inclusive). Omit for ALL migrations.
 */
export function loadMigrationSql(upToPrefix?: string): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
    .sort();
  const selected =
    upToPrefix === undefined
      ? files
      : files.filter((f) => f.slice(0, upToPrefix.length) <= upToPrefix);
  return selected.map((f) => readFileSync(resolve(MIGRATIONS_DIR, f), 'utf-8'));
}
