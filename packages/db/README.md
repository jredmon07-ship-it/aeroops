# @aeroops/db

Drizzle schema + Postgres migrations + Row-Level-Security policies. Owned by the
`schema-engineer`.

---

## Non-negotiables

- Every tenant-scoped table carries a non-null `org_id` and an RLS policy.
- Control-plane tables (`plan`, `subscription`) are NOT org-scoped for RLS —
  they are platform-level and intentionally kept separate.
- Audited records (invoices, payments, Hobbs/tach, endorsements, stage checks,
  maintenance sign-offs) are append-only / change-logged. `audit_log` has
  ENABLE + FORCE RLS and SELECT + INSERT policies only (no UPDATE, no DELETE).
- Money is integer minor units (cents).
- **Migrations are human-gated** — generate the SQL, then a human reviews before it
  runs. Never auto-apply to a real database. The `migrate` script is an informational
  echo stub.

See `THE-BIBLE.md` §4 for the data-model spine.

---

## GUC Contract

AeroOps uses Postgres session/transaction configuration parameters (GUCs) to
communicate the current tenant context to RLS policies.

| GUC | Purpose |
|---|---|
| `app.current_org_id` | UUID of the authenticated org; set before every tenant query |
| `app.platform_admin` | Set to `'on'` only by platform/control-plane code |

### Policy predicate (all tenant tables except `org`)

```sql
org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
```

- `current_setting('app.current_org_id', true)` — the `true` (missing\_ok) means
  the function returns `NULL` when the GUC is unset, rather than raising an error.
- `NULLIF(…, '')` converts an empty-string value to `NULL`.
- `NULL = NULL` evaluates to `false` in SQL → **0 rows returned** when the GUC is
  unset or empty. **Fail-closed by design.**

### `org` table (self-keyed)

The `org` table's SELECT/UPDATE/DELETE policies use `id = NULLIF(…)::uuid` (its PK
*is* the tenant key). The INSERT policy uses `current_setting('app.platform_admin', true) = 'on'`
— tenants can never create orgs; only the platform/control-plane can.

---

## FORCE ROW LEVEL SECURITY — the critical nuance

Every tenant table has both `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.

**Why FORCE?** `ENABLE` alone grants a bypass to the table owner. `FORCE` removes
that bypass so even the role that owns the table is subject to the policies.

**Critical limitation:** Postgres superusers (`is_superuser = on`) bypass RLS
**unconditionally** — `FORCE` does not override the superuser exemption. It only
overrides the table-*owner* exemption for non-superuser owners.

### Production requirement

**The application tier MUST connect as a non-superuser role (`aeroops_app`).**
Connecting as `postgres` or any other superuser makes RLS a no-op.

```
# .env
DATABASE_URL=postgresql://aeroops_app:PASSWORD@HOST:PORT/DBNAME
```

### Test environment (PGlite)

PGlite runs as the `postgres` superuser internally. To enforce RLS in tests:

1. Apply the migration (as superuser — needed for DDL and seeding).
2. Seed test data (as superuser — RLS is bypassed during setup).
3. Call `setTestAppRole({ pglite })` to `SET ROLE aeroops_app`.
4. All queries after step 3 are subject to RLS.

See `src/client.ts` and the smoke test for the pattern.

---

## withOrgContext — the only sanctioned tenant query path

```typescript
import { withOrgContext } from '@aeroops/db';

const locations = await withOrgContext(db, req.session.orgId, (tx) =>
  tx.select().from(location).execute()
);
```

- Opens a transaction.
- Sets `app.current_org_id` **LOCAL** (transaction-scoped) — the GUC is
  automatically cleared when the transaction ends.
- Runs your callback with the typed transaction.
- Commits on success, rolls back on error.

**Never** run tenant queries outside `withOrgContext` unless you have explicitly
set the GUC session-wide and understand the lifetime implications (e.g. clearing
context after each HTTP request in a long-lived connection pool).

---

## Platform-admin context

```typescript
import { withPlatformAdminContext } from '@aeroops/db';

const org = await withPlatformAdminContext(db, (tx) =>
  tx.insert(org).values({ name, slug }).returning()
);
```

Sets `app.platform_admin = 'on'` LOCAL, allowing the `org_insert_platform_admin`
RLS policy to pass. Call only from control-plane / onboarding code, never from
tenant application code.

---

## Migrations

```bash
# Generate DDL (safe — doesn't touch the database)
pnpm --filter @aeroops/db generate

# Apply to real DB — HUMAN-GATED (read the migration first!)
pnpm --filter @aeroops/db migrate   # echoes a reminder; does NOT auto-apply
```

The migration includes the `aeroops_app` role creation and grants. On a fresh
Postgres instance, run the migration once as a superuser (`postgres`), then
revoke the superuser connection from the application.

---

## Environment

See `.env.example` for the required variables. Never create a `.env` file with
real secrets in version control.

| Variable | Description |
|---|---|
| `DATABASE_URL` | `postgresql://aeroops_app:PASSWORD@HOST:PORT/DBNAME` |

[VERIFY] Review with devops/compliance: does the platform control-plane (org
creation, subscription management) use the same `aeroops_app` role with elevated
GUC context, or a separate `control_plane_role` with different table grants?
