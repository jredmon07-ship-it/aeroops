/**
 * demo/reset.ts — "reset-on-open" safety for the public demo tenant.
 *
 * PROBLEM: the deployed demo (Vercel + Neon) writes to a REAL database, so
 * anything a visitor does persists and pollutes the shared demo for everyone.
 *
 * SOLUTION: on a SUCCESSFUL login to an allowlisted demo tenant, wipe that
 * tenant and re-seed it back to its exact seeded baseline (via the existing
 * seedDemo logic — no duplicated seed data) BEFORE the session is established,
 * so the visitor lands on fresh data and nothing they do survives the next
 * reset. The owner@alpha.aero credential (password demo1234) is recreated by
 * the seed, so the just-submitted login still succeeds against the fresh org.
 *
 * ── SAFETY (a bug here could wipe a real customer) ──────────────────────────
 *   1. HARD ALLOWLIST: resetDemoTenant* REFUSE (throw) for any slug that is not
 *      in DEMO_RESET_ALLOWLIST. This assertion runs before ANY database work
 *      and cannot be bypassed by any code path.
 *   2. ENV FLAG: the whole feature is gated behind AEROOPS_DEMO_RESET_ENABLED.
 *      If it is not truthy, maybeResetDemoTenant never touches the database.
 *   3. PRIVILEGED, SEPARATE CONNECTION: the wipe/re-seed runs through a dedicated
 *      owner-role client (AEROOPS_DEMO_OWNER_URL), never the RLS-restricted
 *      aeroops_app runtime client. This connection is used ONLY here.
 *
 * ── THROTTLE + CONCURRENCY ──────────────────────────────────────────────────
 *   - A Postgres advisory lock (pg_try_advisory_xact_lock) ensures at most one
 *     reset runs at a time. If the lock is not acquired, we skip silently.
 *   - demo_reset_state.last_reset_at (migration 0020) records the last reset;
 *     we only reset if now() - last_reset_at > RESET_INTERVAL_MS. Otherwise we
 *     skip silently. Either way the login proceeds.
 *
 * These env vars are set ONLY on the demo deployment (see DEPLOY.md). On the
 * local `pnpm demo` (in-memory PGlite) path AEROOPS_DEMO_RESET_ENABLED is unset,
 * so nothing here runs — that database is already ephemeral per process.
 */
import { sql } from 'drizzle-orm';
import { createDemoOwnerClient } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { extractRows } from '../db-rows.js';
import { seedDemo } from './seed.js';

/**
 * Hard-coded allowlist of demo slugs that may be reset. NOTHING outside this
 * list can ever be wiped by this module — resetDemoTenant* throw otherwise.
 */
export const DEMO_RESET_ALLOWLIST = ['alpha'] as const;

/** Minimum time between resets of the same tenant (throttle window). */
export const RESET_INTERVAL_MS = 60_000;

/**
 * Advisory-lock key (bigint) for reset mutual-exclusion. Arbitrary but stable;
 * scoped to this feature so it cannot collide with other advisory-lock users.
 */
const RESET_ADVISORY_LOCK_KEY = 4_770_010_293;

/** Result of a reset attempt: whether a wipe/re-seed actually happened. */
export interface ResetResult {
  /** true if the tenant was wiped and re-seeded; false if skipped (throttled/locked). */
  reset: boolean;
}

/**
 * Hard safety guard. THROWS unless `slug` is in the allowlist. Runs before any
 * database work so a non-allowlisted org can never be reset under any path.
 */
function assertResettableSlug(slug: string): void {
  if (!(DEMO_RESET_ALLOWLIST as readonly string[]).includes(slug)) {
    throw new Error(
      `[demo-reset] refusing to reset non-allowlisted slug "${slug}". ` +
        `Only [${DEMO_RESET_ALLOWLIST.join(', ')}] may be reset.`,
    );
  }
}

/** Whether the reset feature is enabled via env flag (truthy values only). */
function resetFeatureEnabled(): boolean {
  const v = (process.env['AEROOPS_DEMO_RESET_ENABLED'] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * isDemoResetCandidate — true when the reset feature is live for this slug
 * (flag on AND slug allowlisted). Exported for the login path: when this is
 * true, a CONCURRENT login's reset may swap the org (new org_id) at any
 * moment, so callers must re-resolve claims rather than trust ones issued
 * moments earlier — even when their own maybeResetDemoTenant call was
 * throttled or lost the advisory lock ({ reset: false }).
 */
export function isDemoResetCandidate(slug: string): boolean {
  return (
    resetFeatureEnabled() &&
    (DEMO_RESET_ALLOWLIST as readonly string[]).includes(slug)
  );
}

/**
 * resetDemoTenantWithDb — the core wipe + re-seed, on an injected client.
 *
 * The `db` MUST be a PRIVILEGED client (owner role): the reset deletes the org
 * (cascading its tenant rows) and re-inserts control-plane rows, which the
 * RLS-restricted aeroops_app role cannot do. Tests inject a PGlite superuser
 * client.
 *
 * Wrapped in a single transaction:
 *   1. pg_try_advisory_xact_lock — skip if another reset holds it.
 *   2. throttle check against demo_reset_state.last_reset_at — skip if too soon.
 *   3. DELETE FROM org WHERE slug = <slug> — SCOPED wipe of only the target org;
 *      the ON DELETE CASCADE FKs remove all of that org's tenant rows and its
 *      subscription. Cannot affect any other tenant. The global `plan` row is
 *      left in place and re-used by the seed.
 *   4. seedDemo(tx) — recreates the org (a NEW org_id) and all seeded data via
 *      the exact same seed logic used by `pnpm demo` and db:seed:demo.
 *   5. record last_reset_at = now().
 *
 * @returns { reset: true } if a wipe/re-seed ran; { reset: false } if skipped.
 * @throws  if `slug` is not allowlisted, or on infrastructure/seed failure.
 */
export async function resetDemoTenantWithDb(
  db: AnyDb,
  slug: string,
): Promise<ResetResult> {
  // (1) HARD GUARD — before any DB work.
  assertResettableSlug(slug);

  const intervalSeconds = Math.ceil(RESET_INTERVAL_MS / 1000);

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as AnyDb;

    // (2) Concurrency: only one reset at a time. The xact lock auto-releases
    // when this transaction commits or rolls back.
    const lockRows = extractRows<{ locked: boolean }>(
      await txDb.execute(
        sql`select pg_try_advisory_xact_lock(${RESET_ADVISORY_LOCK_KEY}) as locked`,
      ),
    );
    if (!lockRows[0]?.locked) {
      return { reset: false };
    }

    // (3) Throttle: skip if the tenant was reset within the interval window.
    const throttleRows = extractRows<{ throttled: boolean }>(
      await txDb.execute(
        sql`select (now() - last_reset_at) < make_interval(secs => ${intervalSeconds})
              as throttled
            from demo_reset_state
            where slug = ${slug}`,
      ),
    );
    if (throttleRows[0]?.throttled) {
      return { reset: false };
    }

    // (4) Wipe — SCOPED to the single target org, so this can NEVER affect any
    // other tenant even if more than one org exists in the database. Deleting the
    // org row cascades (org_id FKs are ON DELETE CASCADE) to every tenant table
    // AND to that org's subscription. The global, non-org-scoped `plan` row is
    // intentionally left in place (the seed re-uses it idempotently), and
    // demo_reset_state references nothing here, so both are untouched.
    //
    // RLS: the production owner role (e.g. Neon's neondb_owner) is a
    // NON-superuser WITHOUT BYPASSRLS, and `org` has FORCE ROW LEVEL SECURITY —
    // which binds even the table owner. The org_delete policy's only arm is
    // `id = current_org_id` (no platform-admin arm), so an unscoped DELETE is
    // silently filtered to 0 rows there (empirically verified on PG16; the
    // PGlite test client is a true superuser and cannot catch this). Sequence:
    // resolve the org id under the platform-admin read arm, scope the GUC to
    // that id so the DELETE passes org_delete, then clear both GUCs before the
    // re-seed (seedDemo's withOrgContext/withPlatformAdminContext manage their
    // own). The ON DELETE CASCADE fan-out is a referential action, which
    // Postgres exempts from RLS once the org DELETE itself is allowed.
    await txDb.execute(sql`select set_config('app.platform_admin', 'on', true)`);
    const orgRows = extractRows<{ id: string }>(
      await txDb.execute(sql`SELECT id FROM "org" WHERE "slug" = ${slug}`),
    );
    const targetOrgId = orgRows[0]?.id;
    if (targetOrgId) {
      await txDb.execute(
        sql`select set_config('app.current_org_id', ${targetOrgId}, true)`,
      );
      await txDb.execute(sql`DELETE FROM "org" WHERE "id" = ${targetOrgId}::uuid`);
    }
    await txDb.execute(sql`select set_config('app.current_org_id', '', true)`);
    await txDb.execute(sql`select set_config('app.platform_admin', '', true)`);

    // (5) Re-seed to the exact baseline (reuses the canonical seed logic).
    await seedDemo(txDb);

    // (6) Record the reset time (DB clock) for the throttle.
    await txDb.execute(
      sql`insert into demo_reset_state (slug, last_reset_at)
          values (${slug}, now())
          on conflict (slug) do update set last_reset_at = now()`,
    );

    return { reset: true };
  });
}

// ─── Memoized privileged owner client ───────────────────────────────────────
// Cached on globalThis (like getDemoDb) so Next.js dev's multiple module
// registries share ONE owner connection pool within the process.

declare global {
  // eslint-disable-next-line no-var
  var __aeroopsDemoOwnerDb: AnyDb | undefined;
}

function getDemoOwnerDb(): AnyDb {
  if (!globalThis.__aeroopsDemoOwnerDb) {
    globalThis.__aeroopsDemoOwnerDb = createDemoOwnerClient() as unknown as AnyDb;
  }
  return globalThis.__aeroopsDemoOwnerDb;
}

/**
 * resetDemoTenant — production entry point. Resolves the privileged owner
 * client (AEROOPS_DEMO_OWNER_URL) and runs the wipe/re-seed.
 *
 * @throws if `slug` is not allowlisted, if AEROOPS_DEMO_OWNER_URL is unset,
 *         or on infrastructure/seed failure. Callers on the login path use
 *         maybeResetDemoTenant, which swallows these so a real login never
 *         fails because of a demo-reset problem.
 */
export async function resetDemoTenant(slug: string): Promise<ResetResult> {
  // Defense in depth: guard here too (resetDemoTenantWithDb asserts again).
  assertResettableSlug(slug);
  return resetDemoTenantWithDb(getDemoOwnerDb(), slug);
}

/**
 * maybeResetDemoTenant — the login-path trigger. BEST-EFFORT and non-throwing.
 *
 * Returns { reset: false } — without touching the database — when the feature
 * flag is off or `slug` is not allowlisted. On an allowlisted demo slug with
 * the flag on, it attempts the (throttled, lock-guarded) reset and returns
 * whether one actually ran. Any error is logged and swallowed so the login
 * proceeds regardless.
 *
 * Call this ONLY after a login has been verified (see auth-config.ts) so email
 * scanners / failed attempts cannot spam resets.
 */
export async function maybeResetDemoTenant(slug: string): Promise<ResetResult> {
  if (!isDemoResetCandidate(slug)) {
    return { reset: false };
  }
  try {
    return await resetDemoTenant(slug);
  } catch (err) {
    // Never break a login because the demo reset failed. Surface for ops.
    // eslint-disable-next-line no-console
    console.error(
      `[demo-reset] reset of "${slug}" failed; proceeding with login without reset.`,
      err,
    );
    return { reset: false };
  }
}
