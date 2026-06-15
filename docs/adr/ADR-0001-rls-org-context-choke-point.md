# ADR-0001 — Multi-tenant isolation: `org_id` + Postgres RLS via a `withOrgContext` choke-point

**Status:** Accepted (Slice 0.1). **Owners:** CTO, architect.

## Context
AeroOps is one app shared by many operators (one tenant = one operator/org).
A single un-scoped query leaking one operator's data to another is the one
failure we never permit (CLAUDE.md guardrail; THE-BIBLE §11). We need isolation
that survives application-code mistakes.

## Decision
Shared database, shared schema. Every tenant table carries `org_id uuid NOT NULL
REFERENCES org(id)` (the `org` table self-keys on `id`). Postgres **Row-Level
Security** is `ENABLE`d **and** `FORCE`d on every tenant table, with SELECT/INSERT/
UPDATE/DELETE policies keyed on a session GUC:
`org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid`
(`missing_ok` + `NULLIF` ⇒ unset/empty context yields zero rows — **fail-closed**).

Org context is set **transaction-LOCAL** (`set_config(..., true)`, parameterized —
never `sql.raw`), through a single sanctioned choke-point `withOrgContext(db,
orgId, fn)` in `packages/db`. Session-level GUCs are forbidden (pooled-connection
leak hazard). Control-plane tables (`plan`, `subscription`, …) carry no tenant RLS;
the runtime app role is SELECT-only on them. Org creation is gated by a separate
`app.platform_admin` GUC.

Production connects as a **non-superuser, non-owner** role (`aeroops_app`);
`FORCE` is what makes RLS bind the owner too, and what makes the proof real under
pglite (which connects as superuser). Tests run on `@electric-sql/pglite` and
`SET ROLE aeroops_app` so RLS is genuinely exercised. Migrations are human-gated.

## Consequences
- Logical isolation enforced by the database engine; a forgotten `WHERE org_id=`
  degrades to "returns nothing", not a cross-tenant leak.
- Every authenticated tenant query runs in a transaction via `withOrgContext`.
- Promoting a whale tenant to its own DB later remains possible (the `org_id`
  boundary is exactly the extraction seam). Turning RLS off is a one-way door — don't.

## Invariants (reviewer enforces on every diff)
1. New tenant table ⇒ `org_id` NOT NULL + `ENABLE`+`FORCE` RLS + 4 policies + grant to `aeroops_app`.
2. No tenant query outside `withOrgContext`; `apps/web` never imports `@aeroops/db`.
3. Org context is transaction-LOCAL, parameterized; never session-level, never `sql.raw`.
4. Authenticated `org_id` comes from the trusted server session, never client input.
5. Platform tables carry no tenant RLS; app role SELECT-only there.
6. Every slice adding a tenant table ships a cross-org read+write isolation test.

Implemented in `packages/db/src/org-context.ts`, `packages/db/migrations/0000_loud_prodigy.sql`,
`packages/db/README.md`. See also [[aeroops-tenant-isolation-invariants]].
