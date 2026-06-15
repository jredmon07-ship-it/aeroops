# Changelog

All notable changes to AeroOps are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); the project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased] — Phase 0 (Foundation)

### Slice 0.1 — Tenant data spine + RLS backstop

**Added**

- **Tenant data spine (`@aeroops/db`, Drizzle + Postgres).** Tables, all
  `org_id`-scoped: `org`, `location`, `app_user`, `membership`. RBAC roles are
  encoded as the `membership_role` enum (owner, manager, dispatcher, cfi, mechanic,
  renter, student, accountant), single-sourced from `@aeroops/core`. Control-plane
  tables (not tenant-scoped): `plan`, `subscription`. Reserved append-only
  `audit_log`.
- **Tenant isolation via Postgres RLS (the backstop).** `ENABLE` + `FORCE`
  row-level security on every tenant table; fail-closed policies keyed on the
  `app.current_org_id` session GUC
  (`NULLIF(current_setting(..., true), '')::uuid` → unset/empty yields zero rows,
  never a cross-org read). `org` self-keys on `id`; org creation is gated behind
  `app.platform_admin = 'on'`. `plan`/`subscription` carry no tenant RLS and the
  app role is SELECT-only on them.
- **`withOrgContext(db, orgId, fn)` choke-point.** The only sanctioned path to
  tenant tables — opens a transaction and sets the GUC transaction-LOCAL, so context
  cannot leak across pooled connections. `withPlatformAdminContext` is the
  control-plane equivalent.
- **Client factory.** `createProdClient` (postgres-js; reads `DATABASE_URL` from
  `.env`, throws if unset, and asserts the connecting role is non-superuser) vs
  `createTestClient` (`@electric-sql/pglite`, in-process Postgres for tests).
- **`@aeroops/core`.** Canonical `MEMBERSHIP_ROLES` tuple + role types/labels.

**Security (hardening from QA review)**

- `set_config` calls are parameterized (bound values, no `sql.raw` string
  interpolation) — closes a stacked-query injection surface on the postgres-js
  simple query protocol.
- `createProdClient` refuses a superuser connection (FORCE RLS only binds
  non-superusers).
- `audit_log` UPDATE/DELETE revoked from the app role in addition to the
  policy-absence (immutability enforced at two layers).
- Session-scope GUC primitives are no longer part of the public package surface;
  `withOrgContext` / `withPlatformAdminContext` are the public API.

**Tests**

- Tenant-isolation suite on `@electric-sql/pglite` (no Docker), including
  property-based isolation tests and injection regression tests. Tests `SET ROLE`
  to the non-superuser app role so RLS is actually exercised (superusers bypass it).

**Migration**

- One human-gated migration (`packages/db/migrations/0000_loud_prodigy.sql`) with a
  staged rollback (`0000_loud_prodigy.down.sql`). Not auto-applied; no database is
  provisioned yet.

**Deferred** (tracked for later slices)

- `audit_log` tamper-evidence (hash chain / WORM) — Phase 2/3, before the first real
  audit writer.
- Dedicated `control_plane_role` owning `plan`/`subscription` writes; real-Postgres
  CI smoke test — Slice 0.4.
- Auth.js + session→`org_id` binding, platform-admin caller gating — Slice 0.2.
