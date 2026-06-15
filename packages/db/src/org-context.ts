/**
 * org-context.ts — RLS session context helpers.
 *
 * GUC contract:
 *   app.current_org_id  — set to the authenticated org's UUID for tenant queries.
 *   app.platform_admin  — set to 'on' ONLY by the platform/control-plane code path.
 *
 * Policy predicate (every tenant table):
 *   org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
 *
 * The `true` (missing_ok) argument to current_setting means the function
 * returns NULL when the GUC is unset rather than raising an error.
 * NULLIF converts '' to NULL.
 * NULL = NULL is false in SQL → 0 rows (fail-closed by design).
 *
 * RECOMMENDED USAGE: always prefer withOrgContext() — it wraps work in a
 * transaction and sets the GUC LOCAL (visible only within that transaction).
 * Direct set/clear helpers are provided for edge-cases (e.g. long-lived
 * connection pools where you must clear context after each request).
 * These bare primitives are TEST/ADVANCED-INTERNAL USE ONLY — application
 * code should always use withOrgContext / withPlatformAdminContext.
 *
 * PRODUCTION REQUIREMENT: the app must connect as a non-superuser/non-owner
 * role. FORCE ROW LEVEL SECURITY is bypassed for the table owner (superuser).
 * See README for the full contract.
 *
 * INJECTION SAFETY (FIX 1): all set_config calls use Drizzle parameterized
 * template bindings so the GUC value is a bound parameter, never string-
 * concatenated. validateUuid is kept as defense-in-depth on org-id paths.
 * Note: PGlite uses the extended (parameterized) protocol and cannot itself
 * exercise the stacked-statement attack path that simple-query protocol on
 * postgres-js would allow with sql.raw; a real-Postgres CI smoke is tracked
 * for Slice 0.4 to verify the extended-protocol path on the wire.
 */
import { sql } from 'drizzle-orm';
import { PgDatabase } from 'drizzle-orm/pg-core';

// RFC-4122 UUID format (version-agnostic): 8-4-4-4-12 hex, any version/variant.
// FIX 7: relaxed from v4-only to accept any UUID version (gen_random_uuid()
// is v4 today, but parameterization is now the real injection defense).
// Still strict enough to reject obviously malformed / non-UUID input.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(
      `[org-context] ${label} must be a valid RFC-4122 UUID, got: "${value}"`,
    );
  }
}

// ─── AnyDb type ───────────────────────────────────────────────────────────────
// We use PgDatabase<any, any> so that both PgliteDatabase and PostgresJsDatabase
// are accepted. The transaction callback receives the same type as the db input
// so query results retain their inferred types from the schema.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDb = PgDatabase<any, any>;

// ─── Options ─────────────────────────────────────────────────────────────────

export interface OrgContextOpts {
  /**
   * Whether to use SET LOCAL (transaction-scoped, default true) or
   * SET (session-scoped). Always prefer LOCAL; session-scope is only
   * safe when you are certain no other tenant request can share the
   * session (e.g. PGlite tests).
   */
  local?: boolean;
}

// ─── Primitives ──────────────────────────────────────────────────────────────
// TEST/ADVANCED-INTERNAL USE ONLY. Prefer withOrgContext / withPlatformAdminContext
// for all application code paths. These bare set/clear primitives are safe only
// when the caller fully controls the connection lifecycle (e.g. single-session
// tests). On pooled connections, leaked session-scope GUCs cross tenant boundaries.

/**
 * Sets app.current_org_id for the current transaction (local=true, default)
 * or session (local=false). Validates that orgId is a UUID before sending.
 *
 * FIX 1: value is a bound parameter — never concatenated into the SQL string.
 */
export async function setOrgContext(
  db: AnyDb,
  orgId: string,
  opts: OrgContextOpts = {},
): Promise<void> {
  validateUuid(orgId, 'orgId');
  const local = opts.local !== false;
  if (local) {
    await db.execute(sql`select set_config('app.current_org_id', ${orgId}, true)`);
  } else {
    await db.execute(sql`select set_config('app.current_org_id', ${orgId}, false)`);
  }
}

/**
 * Clears app.current_org_id (sets to empty string → policy predicate → NULL → 0 rows).
 *
 * FIX 1: value is a bound parameter — never concatenated into the SQL string.
 */
export async function clearOrgContext(
  db: AnyDb,
  opts: OrgContextOpts = {},
): Promise<void> {
  const local = opts.local !== false;
  if (local) {
    await db.execute(sql`select set_config('app.current_org_id', ${''}::text, true)`);
  } else {
    await db.execute(sql`select set_config('app.current_org_id', ${''}::text, false)`);
  }
}

/**
 * Sets or clears app.platform_admin.
 * When on=true, sets 'on'; when on=false, sets '' (off/cleared).
 * MUST only be called from platform/control-plane code paths.
 *
 * FIX 1: value is a bound parameter — never concatenated into the SQL string.
 */
export async function setPlatformAdminContext(
  db: AnyDb,
  on: boolean,
  opts: OrgContextOpts = {},
): Promise<void> {
  const value = on ? 'on' : '';
  const local = opts.local !== false;
  if (local) {
    await db.execute(sql`select set_config('app.platform_admin', ${value}, true)`);
  } else {
    await db.execute(sql`select set_config('app.platform_admin', ${value}, false)`);
  }
}

// ─── Primary API — withOrgContext ─────────────────────────────────────────────

/**
 * withOrgContext — THE recommended tenant query choke-point.
 *
 * Opens a transaction, sets app.current_org_id LOCAL (visible only within
 * this transaction), runs fn(tx), then commits. On error, rolls back.
 *
 * Using LOCAL means the GUC is automatically cleared when the transaction
 * ends — no risk of context leaking to the next request on a pooled connection.
 *
 * The callback receives the transaction as TDb so typed queries work without
 * needing to re-cast.
 *
 * FIX 1: orgId is a bound parameter — never concatenated into the SQL string.
 *
 * Usage:
 *   const locs = await withOrgContext(db, orgId, (tx) =>
 *     tx.select().from(location).execute()
 *   );
 */
export async function withOrgContext<TDb extends AnyDb, T>(
  db: TDb,
  orgId: string,
  fn: (tx: TDb) => Promise<T>,
): Promise<T> {
  validateUuid(orgId, 'orgId');
  return db.transaction(async (tx) => {
    await (tx as AnyDb).execute(
      sql`select set_config('app.current_org_id', ${orgId}, true)`,
    );
    return fn(tx as unknown as TDb);
  });
}

/**
 * withPlatformAdminContext — runs fn with platform-admin privileges.
 *
 * Used ONLY by the control-plane (org creation, onboarding, plan management).
 * Never call from tenant application code.
 *
 * FIX 1: literal 'on' value is a bound parameter — never concatenated.
 */
export async function withPlatformAdminContext<TDb extends AnyDb, T>(
  db: TDb,
  fn: (tx: TDb) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await (tx as AnyDb).execute(
      sql`select set_config('app.platform_admin', ${'on'}, true)`,
    );
    return fn(tx as unknown as TDb);
  });
}
