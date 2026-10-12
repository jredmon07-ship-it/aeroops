/**
 * migrate.mjs — AeroOps human-gated migration runner.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  HUMAN-GATED CONTRACT                                                   ║
 * ║                                                                          ║
 * ║  DEFAULT MODE = DRY RUN. Prints pending migrations and exits without     ║
 * ║  applying anything. This is intentional: a human must read the output    ║
 * ║  and decide whether it is safe to proceed.                               ║
 * ║                                                                          ║
 * ║  To apply:  CONFIRM_APPLY=1 node scripts/migrate.mjs --apply            ║
 * ║  (both the --apply flag AND the env var are required)                    ║
 * ║                                                                          ║
 * ║  This runner MUST connect as a role with DDL privileges (the DB owner    ║
 * ║  / superuser used only during provisioning), NOT the runtime             ║
 * ║  aeroops_app role. The aeroops_app role is a non-superuser created BY    ║
 * ║  migration 0000 and used by the running application. Connecting as        ║
 * ║  aeroops_app for migrations will fail with permission errors.            ║
 * ║                                                                          ║
 * ║  Down migrations (.down.sql) are NEVER run automatically. If you need   ║
 * ║  to roll back, apply the relevant .down.sql file manually after          ║
 * ║  explicit human review.                                                  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   pnpm db:migrate                                  # dry run (safe default)
 *   CONFIRM_APPLY=1 pnpm db:migrate:apply            # apply pending migrations
 *   DATABASE_URL=postgres://... node scripts/migrate.mjs            # dry run
 *   DATABASE_URL=postgres://... CONFIRM_APPLY=1 node scripts/migrate.mjs --apply
 *
 * Environment:
 *   DATABASE_URL  — required; the owner/admin connection string (NOT aeroops_app)
 *
 * The runner:
 *   1. Ensures a `schema_migrations` tracking table (idempotent).
 *   2. Reads all NNNN_*.sql files in migrations/ (excluding .down.sql),
 *      sorted numerically by the NNNN prefix.
 *   3. Computes the pending set (files not yet in schema_migrations).
 *   4. In dry-run mode: prints the pending list and exits 0 (safe default).
 *   5. In apply mode (--apply + CONFIRM_APPLY=1): applies each migration in its
 *      own transaction, recording it in schema_migrations in the SAME tx so a
 *      failed migration rolls back atomically and is not marked as applied.
 *   6. Prints a summary.
 */

import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Path resolution ──────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
// This script lives at packages/db/scripts/migrate.mjs;
// migrations live at packages/db/migrations/
const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

// ── Argument + environment parsing ──────────────────────────────────────────

const APPLY_FLAG = process.argv.includes('--apply');
const CONFIRM_ENV = process.env['CONFIRM_APPLY'] === '1';
const DATABASE_URL = process.env['DATABASE_URL'];

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(msg);
}

function err(msg) {
  // eslint-disable-next-line no-console
  console.error(msg);
}

function banner(title) {
  log('');
  log('  ' + '─'.repeat(60));
  log('  ' + title);
  log('  ' + '─'.repeat(60));
}

// ── Migration file discovery ─────────────────────────────────────────────────

/**
 * Returns sorted list of { name, path } for all up-migration files.
 * Files matching /^\d{4}_.*\.sql$/ that do NOT end with .down.sql.
 */
function discoverMigrations() {
  const entries = readdirSync(MIGRATIONS_DIR);
  const files = entries
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && !f.endsWith('.down.sql'))
    .sort(); // lexicographic sort = numeric sort for NNNN_ prefix
  return files.map((name) => ({ name, path: join(MIGRATIONS_DIR, name) }));
}

// ── Schema migrations table ──────────────────────────────────────────────────

const CREATE_TRACKING_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    id          text        PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now()
  );
`;

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  banner('AeroOps migration runner');

  // 1. Validate prerequisites ---------------------------------------------------

  if (!DATABASE_URL) {
    err('');
    err('  ERROR: DATABASE_URL is not set.');
    err('  Export it (the owner/admin connection string, NOT aeroops_app):');
    err('    export DATABASE_URL="postgres://owner:password@host:5432/aeroops"');
    err('  Then re-run: pnpm db:migrate');
    err('');
    process.exit(1);
  }

  const isApplyMode = APPLY_FLAG && CONFIRM_ENV;

  if (APPLY_FLAG && !CONFIRM_ENV) {
    err('');
    err('  ERROR: --apply flag requires CONFIRM_APPLY=1 in the environment.');
    err('  This is a double-confirmation gate. To apply:');
    err('    CONFIRM_APPLY=1 pnpm db:migrate:apply');
    err('');
    process.exit(1);
  }

  // 2. Connect -----------------------------------------------------------------

  log('');
  log('  Connecting to database…');

  // Redact credentials from the URL for display
  const displayUrl = DATABASE_URL.replace(/:([^@/]+)@/, ':***@');
  log(`  Target: ${displayUrl}`);

  const sql = postgres(DATABASE_URL, {
    max: 1,
    // Migrations can be slow — allow up to 10 minutes per statement
    idle_timeout: 600,
    connect_timeout: 30,
  });

  try {
    // 3. Ensure tracking table --------------------------------------------------

    await sql.unsafe(CREATE_TRACKING_TABLE);

    // 4. Discover migration files -----------------------------------------------

    const allMigrations = discoverMigrations();
    log('');
    log(`  Found ${allMigrations.length} migration file(s) in migrations/:`);
    for (const m of allMigrations) {
      log(`    ${m.name}`);
    }

    // 5. Compute pending set ----------------------------------------------------

    const applied = await sql`
      SELECT id FROM schema_migrations ORDER BY id
    `;
    const appliedSet = new Set(applied.map((r) => r.id));

    const pending = allMigrations.filter((m) => !appliedSet.has(m.name));

    log('');
    if (pending.length === 0) {
      log('  All migrations already applied. Nothing to do.');
      log('');
      await sql.end();
      return;
    }

    log(`  Already applied: ${appliedSet.size} migration(s)`);
    log(`  Pending:         ${pending.length} migration(s)`);
    log('');
    log('  Pending migrations (in apply order):');
    for (const m of pending) {
      log(`    + ${m.name}`);
    }

    // 6. Dry run (default) ------------------------------------------------------

    if (!isApplyMode) {
      log('');
      log('  DRY RUN — no changes made.');
      log('  To apply these migrations:');
      log('    CONFIRM_APPLY=1 pnpm db:migrate:apply');
      log('');
      log('  REMINDER: review each pending migration file before applying.');
      log('  Down migrations (.down.sql) are the rollback path if needed.');
      log('');
      await sql.end();
      return;
    }

    // 7. Apply mode -------------------------------------------------------------

    log('');
    log('  APPLY MODE — applying pending migrations…');
    log('');

    let appliedCount = 0;
    let failedMigration = null;

    for (const m of pending) {
      log(`  Applying: ${m.name} …`);
      const migrationSql = readFileSync(m.path, 'utf8');

      try {
        // Each migration runs in its own transaction so that:
        //   - A failed migration rolls back atomically (no partial state).
        //   - The schema_migrations record is committed in the SAME tx so
        //     a failure never marks a migration as applied.
        await sql.begin(async (tx) => {
          await tx.unsafe(migrationSql);
          await tx`
            INSERT INTO schema_migrations (id) VALUES (${m.name})
          `;
        });
        log(`    OK: ${m.name}`);
        appliedCount++;
      } catch (e) {
        err(`    FAILED: ${m.name}`);
        err(`    Error: ${e.message}`);
        failedMigration = m.name;
        // Stop on first failure — remaining migrations may depend on this one.
        break;
      }
    }

    log('');
    banner('Migration summary');
    log('');
    log(`  Applied: ${appliedCount} migration(s)`);

    if (failedMigration) {
      err(`  Failed:  ${failedMigration}`);
      err('  The failed migration was rolled back atomically.');
      err('  Fix the issue, then re-run to retry.');
      log('');
      await sql.end();
      process.exit(1);
    }

    log('  All pending migrations applied successfully.');
    log('');
    log('  NEXT STEPS (if this was a fresh database):');
    log('  1. Let aeroops_app log in and set its password:');
    log('     psql $DATABASE_URL -c "ALTER ROLE aeroops_app WITH LOGIN PASSWORD \'your-password\';"');
    log('  2. Build the app DATABASE_URL for the runtime (aeroops_app, not owner):');
    log('     DATABASE_URL="postgres://aeroops_app:your-password@host:5432/aeroops"');
    log('  3. For a hosted demo: ALLOW_DEMO_SEED=1 pnpm db:seed:demo');
    log('');
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  err('');
  err('  FATAL: migration runner crashed.');
  err(`  ${e.message}`);
  err('');
  process.exit(1);
});
