/**
 * purge-booking-requests.mjs — AeroOps booking-request PII purge script.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  HUMAN-GATED CONTRACT                                                   ║
 * ║                                                                          ║
 * ║  DEFAULT MODE = DRY RUN. Prints eligible row counts per org and exits   ║
 * ║  without deleting anything. A human must read the output and decide     ║
 * ║  whether it is safe to proceed.                                          ║
 * ║                                                                          ║
 * ║  To apply:  CONFIRM_APPLY=1 node scripts/purge-booking-requests.mjs --apply ║
 * ║  (both the --apply flag AND the env var are required)                   ║
 * ║                                                                          ║
 * ║  ISOLATION: purges are run per-org, each under its own withOrgContext   ║
 * ║  (separate transaction + RLS GUC). NOT a single cross-org DELETE.       ║
 * ║                                                                          ║
 * ║  SAFETY:                                                                ║
 * ║   - retentionDays = 0 for an org → that org is skipped entirely.        ║
 * ║   - RLS DELETE policy (org_id = current_org_id) is the structural       ║
 * ║     backstop in addition to per-org context.                            ║
 * ║   - Audit: ONE 'booking_request.purged' row per org per apply run       ║
 * ║     (counts only — NO requester PII in the audit log).                  ║
 * ║   - dry-run produces NO audit rows and NO deletes.                      ║
 * ║                                                                          ║
 * ║  Connect as the aeroops_app runtime role (non-superuser) so RLS is     ║
 * ║  active. This script does NOT need DDL privileges.                      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   pnpm db:purge:booking                                    # dry run (safe default)
 *   CONFIRM_APPLY=1 pnpm db:purge:booking:apply              # delete eligible rows
 *   DATABASE_URL=postgres://... node scripts/purge-booking-requests.mjs            # dry run
 *   DATABASE_URL=postgres://... CONFIRM_APPLY=1 node scripts/purge-booking-requests.mjs --apply
 *
 * Environment:
 *   DATABASE_URL — required; the aeroops_app runtime connection string.
 *
 * The script:
 *   1. Connects to the database.
 *   2. Reads all org IDs via a single platform-context query (no RLS GUC).
 *   3. For each org, calls purgeExpiredBookingRequestsForOrg under its own
 *      withOrgContext (per-org transaction, per-org RLS GUC).
 *   4. In dry-run mode: prints per-org eligible counts and exits 0.
 *   5. In apply mode: deletes expired rows, writes audit rows, prints summary.
 */

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── ESM self-path ─────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Argument + environment parsing ───────────────────────────────────────────
const APPLY_FLAG  = process.argv.includes('--apply');
const CONFIRM_ENV = process.env['CONFIRM_APPLY'] === '1';
const DATABASE_URL = process.env['DATABASE_URL'];

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  banner('AeroOps booking-request purge script');

  // 1. Validate prerequisites ─────────────────────────────────────────────────

  if (!DATABASE_URL) {
    err('');
    err('  ERROR: DATABASE_URL is not set.');
    err('  Export it (the aeroops_app runtime connection string):');
    err('    export DATABASE_URL="postgres://aeroops_app:password@host:5432/aeroops"');
    err('  Then re-run: pnpm db:purge:booking');
    err('');
    process.exit(1);
  }

  const isApplyMode = APPLY_FLAG && CONFIRM_ENV;

  if (APPLY_FLAG && !CONFIRM_ENV) {
    err('');
    err('  ERROR: --apply flag requires CONFIRM_APPLY=1 in the environment.');
    err('  This is a double-confirmation gate. To apply:');
    err('    CONFIRM_APPLY=1 pnpm db:purge:booking:apply');
    err('');
    process.exit(1);
  }

  // 2. Connect ─────────────────────────────────────────────────────────────────

  log('');
  log('  Connecting to database…');
  const displayUrl = DATABASE_URL.replace(/:([^@/]+)@/, ':***@');
  log(`  Target: ${displayUrl}`);

  const pgClient = postgres(DATABASE_URL, {
    max: 1,
    idle_timeout: 300,
    connect_timeout: 30,
  });

  // Import the @aeroops/api package functions dynamically.
  // These are CommonJS/ESM compiled packages — import from the built dist.
  // The purgeExpiredBookingRequestsForOrg function is the internal helper
  // that takes (db, orgId, { dryRun }) — no session required.
  let purgeExpiredBookingRequestsForOrg;
  let withPlatformAdminContext;

  try {
    // Import drizzle-orm sql tag and withPlatformAdminContext.
    const dbPkg = await import('@aeroops/db');
    withPlatformAdminContext = dbPkg.withPlatformAdminContext;

    // Import the purge function.
    // We use the relative built path since we're in the scripts dir.
    const apiPkg = await import('@aeroops/api');
    purgeExpiredBookingRequestsForOrg = apiPkg.purgeExpiredBookingRequestsForOrg;
  } catch (importErr) {
    err('');
    err('  ERROR: Failed to import @aeroops/api or @aeroops/db packages.');
    err('  Ensure packages are built: pnpm --filter @aeroops/api build');
    err(`  ${importErr.message}`);
    err('');
    process.exit(1);
  }

  const db = drizzle(pgClient);

  try {
    // 3. Enumerate org IDs via a single platform read. ──────────────────────────
    // withPlatformAdminContext sets app.platform_admin = 'on', bypassing RLS
    // for this one enumeration query. This is the only place we need a
    // cross-org read — to get the list of org IDs to iterate.
    log('');
    log('  Enumerating org IDs…');

    const orgRows = await withPlatformAdminContext(db, async (tx) => {
      return tx.execute({ sql: 'SELECT id FROM org ORDER BY id', params: [] });
    });

    const orgIds = orgRows.rows.map((r) => r.id);
    log(`  Found ${orgIds.length} org(s).`);

    if (orgIds.length === 0) {
      log('');
      log('  No orgs found. Nothing to do.');
      log('');
      await pgClient.end();
      return;
    }

    // 4. Mode banner ─────────────────────────────────────────────────────────────

    if (!isApplyMode) {
      log('');
      log('  DRY RUN — no rows will be deleted, no audit rows written.');
    } else {
      log('');
      log('  APPLY MODE — expired booking_request rows will be deleted.');
    }

    // 5. Purge per org ───────────────────────────────────────────────────────────

    let totalEligible = 0;
    let totalDeleted  = 0;
    let skippedDisabled = 0;

    log('');
    log('  Processing orgs:');

    for (const orgId of orgIds) {
      try {
        const result = await purgeExpiredBookingRequestsForOrg(db, orgId, {
          dryRun: !isApplyMode,
        });

        if (result.retentionDisabled) {
          log(`    ${orgId}  →  retention disabled (days=0) — skipped`);
          skippedDisabled++;
        } else {
          const verb = isApplyMode ? 'deleted' : 'eligible';
          const count = isApplyMode ? result.deletedCount : result.eligibleCount;
          log(`    ${orgId}  →  ${count} row(s) ${verb}`);
          totalEligible += result.eligibleCount;
          if (isApplyMode) totalDeleted += result.deletedCount;
        }
      } catch (orgErr) {
        err(`    ${orgId}  →  ERROR: ${orgErr.message}`);
        // Continue to next org — one org failure should not block others.
      }
    }

    // 6. Summary ─────────────────────────────────────────────────────────────────

    log('');
    banner('Purge summary');
    log('');
    log(`  Orgs processed:        ${orgIds.length}`);
    log(`  Orgs skipped (days=0): ${skippedDisabled}`);

    if (!isApplyMode) {
      log(`  Eligible rows:         ${totalEligible}`);
      log('');
      log('  DRY RUN — no changes made.');
      log('  To delete eligible rows:');
      log('    CONFIRM_APPLY=1 pnpm db:purge:booking:apply');
      log('');
      log('  REMINDER: review per-org counts above before applying.');
      log('  Audit rows (booking_request.purged) are written ONLY on apply.');
      log('');
    } else {
      log(`  Rows deleted:          ${totalDeleted}`);
      log('');
      log('  Audit: ONE booking_request.purged row written per org that had');
      log('  eligible rows (counts only — no requester PII logged).');
      log('');
      log('  All purge operations completed.');
      log('');
    }
  } finally {
    await pgClient.end();
  }
}

main().catch((e) => {
  err('');
  err('  FATAL: purge script crashed.');
  err(`  ${e.message}`);
  err('');
  process.exit(1);
});
