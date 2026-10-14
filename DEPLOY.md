# AeroOps — Deploy Guide

Step-by-step instructions for standing up a real Postgres-backed deployment
and optionally hosting a public demo.

> **Audience:** operators who want a running instance. For a shorter,
> tested walk-through (local run, creating your operation, staff logins,
> Vercel + Neon), start with [`SELF-HOSTING.md`](./SELF-HOSTING.md). This file
> is the reference: roles, migrations, environment variables, demo mode,
> rollback. The migration step is explicitly human-gated — you review the SQL
> and confirm before anything touches the database.

---

## Prerequisites

- A GitHub account (to push the repo and trigger CI).
- A [Neon](https://neon.tech) or [Supabase](https://supabase.com) free-tier
  account (for managed Postgres), or a self-hosted Postgres 14+.
- A [Vercel](https://vercel.com) account (for hosting the Next.js app).
- Node 20+ and pnpm 9.12.0 installed locally (`npm i -g pnpm@9.12.0`).

---

## Step 1 — Push to a GitHub remote

```bash
# One-time: add the remote and push
git remote add origin https://github.com/YOUR_ORG/aeroops.git
git push -u origin main
```

The CI workflow (`.github/workflows/ci.yml`) runs automatically on every push:
typecheck → test → build. It never connects to a real database and never runs
migrations. Watch the Actions tab; it must be green before you merge anything.

---

## Step 2 — Provision a Postgres database

### Option A: Neon (recommended for a free-tier demo)

1. Sign in to [neon.tech](https://neon.tech) → New Project → name it `aeroops`.
2. Copy the **Owner connection string** (looks like
   `postgres://neondb_owner:PASS@HOSTNAME/neondb?sslmode=require`).
   This is the **DDL role** — used only for migrations and seeding.
3. Keep this string secret. You pass it on the command line when running
   migrations; it never goes in the app's environment or the repo.

### Option B: Supabase

1. New Project → copy the **Connection string** under
   Project Settings → Database → Connection string (URI format).
   Use the `postgres` (owner) role for migrations.

### Option C: Self-hosted Postgres

Use any Postgres 14+ instance. The owner role must have `CREATE EXTENSION` and
`CREATE TABLE` privileges on the target database.

---

## Step 3 — Understand the two connection strings

This project uses **two distinct Postgres roles**:

| Role | Purpose | Who uses it |
|---|---|---|
| **Owner / DDL role** | Run migrations and the demo seed. Has `SUPERUSER` or `CREATE` privileges. | `pnpm db:migrate:apply` and `pnpm db:seed:demo` only |
| **`aeroops_app` (non-superuser)** | The running application. Created by migration `0000`. | `apps/web` at runtime |

**Why two roles?**
Migration `0000` creates the `aeroops_app` role and sets `FORCE ROW LEVEL
SECURITY` on every tenant table. `FORCE RLS` only binds non-superuser roles —
a superuser bypasses it unconditionally. The app MUST connect as `aeroops_app`
so tenant isolation is enforced. `createProdClient()` in `packages/db/src/client.ts`
checks this at startup and throws immediately if the connecting role is a
superuser, so a misconfiguration fails loud rather than silently exposing data.

After running migrations (step 4), you set `aeroops_app`'s password and use
that connection string for the application:

```bash
# Run once, with the owner/DDL connection string, after migrations are applied.
# Migration 0000 creates the role NOLOGIN, so LOGIN is required here too:
psql "$OWNER_DATABASE_URL" -c "ALTER ROLE aeroops_app WITH LOGIN PASSWORD 'choose-a-strong-password';"
```

Then the **app** `DATABASE_URL` is:
```
postgres://aeroops_app:choose-a-strong-password@HOSTNAME:5432/DBNAME?sslmode=require
```

---

## Step 4 — Run migrations (human-gated)

### 4a. Set your environment

The migration runner reads `DATABASE_URL` from the shell only (it does not load
any `.env` file). Pass the **owner/DDL** string on the command line, as in 4b
and 4c. Prefer the inline `DATABASE_URL='...' pnpm ...` form over `export`: an
exported owner string also overrides `apps/web/.env.local` if you start the app
from the same terminal.

### 4b. Preview the pending migrations (dry run — safe default)

```bash
DATABASE_URL='postgres://neondb_owner:PASS@HOSTNAME/neondb?sslmode=require' pnpm db:migrate
```

This prints the list of pending migration files and exits **without applying
anything**. Review the output carefully:

```
  Found 12 migration file(s) in migrations/:
    0000_loud_prodigy.sql
    0001_auth_credential.sql
    0002_scheduling.sql
    ...
    0011_optimizer_run.sql

  Pending: 12 migration(s)
    + 0000_loud_prodigy.sql
    ...

  DRY RUN — no changes made.
  To apply these migrations:
    CONFIRM_APPLY=1 pnpm db:migrate:apply
```

Read each `.sql` file in `packages/db/migrations/` before proceeding.
The corresponding `.down.sql` files are the manual rollback path if needed —
they are **never run automatically**.

### 4c. Apply migrations (requires explicit confirmation)

Only after reviewing the SQL:

```bash
DATABASE_URL='postgres://neondb_owner:PASS@HOSTNAME/neondb?sslmode=require' CONFIRM_APPLY=1 pnpm db:migrate:apply
```

Both the `--apply` flag (in the script) and `CONFIRM_APPLY=1` are required.
Each migration runs in its own transaction with an atomic `schema_migrations`
record — a failed migration rolls back and is not marked as applied.

### 4d. Let aeroops_app log in and set its password

Migration `0000` creates the `aeroops_app` role with no password and **without
LOGIN**. Grant both now (letters and digits only keep the URL simple —
`openssl rand -hex 24`):

```bash
psql 'OWNER_CONNECTION_STRING' -c "ALTER ROLE aeroops_app WITH LOGIN PASSWORD 'choose-a-strong-password';"
```

Without `LOGIN` the app fails with `role "aeroops_app" is not permitted to log in`.

Now build your **app** `DATABASE_URL` (aeroops_app role, not owner):
```
postgres://aeroops_app:choose-a-strong-password@HOSTNAME:5432/DBNAME?sslmode=require
```

Keep this; you need it in step 6.

---

## Step 5 — Seed demo data (optional — hosted demo only)

Skip this step if you are deploying a real customer instance.

```bash
# DATABASE_URL here is the OWNER string (not aeroops_app)
DATABASE_URL=postgres://neondb_owner:PASS@HOSTNAME/neondb?sslmode=require \
  ALLOW_DEMO_SEED=1 pnpm db:seed:demo
```

The `ALLOW_DEMO_SEED=1` guard prevents accidentally seeding demo data into a
real customer database. The seed connects as the owner role (DDL access needed
for platform-admin inserts), then the running app connects as `aeroops_app`.

**What is seeded** (identical to `pnpm demo` local experience):
- Org: Alpha Flight School (login URL: `/o/alpha/login`)
- 5 users (one per role), each with a real password credential
- 4 aircraft (N172SP, N152AB, N28K, N66RG) + 1 instructor resource
- Today's reservations, dispatch tickets, booking policies, weekly series
- Squawks, grounded Cirrus (N66RG), dispatch gate requirements, twilight config

**Demo logins** (password for all: `demo1234`) — see `DEMO.md` for the full
click-through walkthrough:

| Email | Role |
|---|---|
| `owner@alpha.aero` | owner (full access — start here) |
| `manager@alpha.aero` | manager |
| `dispatch@alpha.aero` | dispatcher |
| `cfi@alpha.aero` | instructor |
| `student@alpha.aero` | student |

The seed is **not idempotent** — do not run it twice on the same database.

---

## Step 6 — Set environment variables

For a Vercel deployment, go to Project → Settings → Environment Variables.
For a local run, set these in `apps/web/.env.local` (never commit it). The app
does not read a `.env.local` in the repo root.

### Required

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://aeroops_app:PASSWORD@HOST/DB?sslmode=require` | The **aeroops_app** (non-superuser) role. NEVER the owner/DDL role. |
| `AUTH_SECRET` | `openssl rand -base64 32` output | A real secret. Never use the build-time placeholder. |

### Optional

| Variable | Value | Notes |
|---|---|---|
| `ALLOW_SIGNUP` | `true` | Turns on self-serve `/signup` (creates a new operation and its owner). Only the exact string `true` enables it; unset = off. Enforced in the server action, not just the page. Turn it on to create your operation, then remove it and redeploy. Never set it on the public demo. |
| `AUTH_TRUST_HOST` | `true` | Not needed: the Auth.js config already sets `trustHost: true`. Harmless if set. |
| `AEROOPS_SESSION_REVALIDATE_TTL_MS` | `15000` (default) | How long each server instance reuses its check that a signed-in session is still valid (password unchanged, still a member, org active, current role). A password reset or role change reaches a signed-in browser within this many ms. `0` = check on every request; capped at `300000`. See `packages/api/src/auth/session-revalidation.ts`. |

### Optional (mobile)

| Variable | Value | Notes |
|---|---|---|
| `EXPO_PUBLIC_API_BASE_URL` | `https://your-domain.com` | Set this in the Expo app (`apps/mobile`) once the web API is deployed. Required for the mobile client to reach the API. |

### Public-demo "reset-on-open" (DEMO DEPLOYMENT ONLY)

Set these **only** on the throwaway public-demo deployment (the one behind
`/o/alpha/login`). **Never** set them on a deployment that serves real customer
data — they authorize wiping a tenant.

| Variable | Value | Notes |
|---|---|---|
| `AEROOPS_DEMO_RESET_ENABLED` | `1` (or `true`/`yes`/`on`) | Turns the feature on. Unset/empty = never resets. When on, a **successful** login to an allowlisted demo slug (`alpha` **or** `bravo`) wipes + re-seeds **both** demo tenants to their clean seeded baseline **before** the session is issued, so nothing a visitor does persists. Throttled to at most one reset per 60s and guarded by a Postgres advisory lock. **Note:** the seed now backfills ~a month of flights per org, so a reset does more work than before — expect the login that triggers it to take a few extra seconds. For a fast demo where you don't mind visitor edits sticking until the next manual `db:seed:demo`, leave this **off**. |
| `AEROOPS_DEMO_OWNER_URL` | `postgres://neondb_owner:PASS@HOST/DB?sslmode=require` | The **owner/DDL** connection string used ONLY to perform the wipe + re-seed (a scoped `DELETE FROM org` + control-plane re-inserts need elevated rights the runtime role lacks). This is the **owner** role — NOT the `aeroops_app` role in `DATABASE_URL`. Note: on Neon this owner is a non-superuser, so FORCE RLS still applies to it — the reset code scopes the org GUCs itself; no extra grants are needed beyond ownership. |

How it works: the reset deletes and recreates the `alpha` org (a **new** `org_id`
each time); the seed recreates `owner@alpha.aero` / `demo1234`, so the just-submitted
login still succeeds and lands on fresh data. If the feature flag is off, the slug
is not allowlisted, or the reset errors, login proceeds normally with no reset.

**Migration prerequisite:** apply `0020_demo_reset_state.sql` (the throttle
bookkeeping table) to the demo database before enabling this — run it with the
**owner/DDL** connection string, the same way as every other migration in
"Step 4 — Run migrations (human-gated)".

**Caveat (concurrent visitors):** because a reset can fire on login, two visitors
active at the same time can reset each other's data mid-session. The other visitor's
session points at the deleted org, so their next page sends them back to the sign-in
page (sessions are re-checked against the database). This is acceptable
for a single-visitor sales/QA demo; it is **not** a multi-tenant isolation mechanism.

### Must NOT be set in production

| Variable | Reason |
|---|---|
| `AEROOPS_DEMO` | This activates the in-memory PGlite demo mode, which is incompatible with serverless/Vercel (each function instance gets a separate ephemeral in-memory DB — no shared state). Remove or leave unset. |

### Security MUST-DOs

1. **`DATABASE_URL` must use `aeroops_app`, not the owner role.** The app
   throws at startup if the connecting role is a superuser
   (`createProdClient` in `packages/db/src/client.ts`).

2. **`AUTH_SECRET` must be a real secret.** Generate it with:
   ```bash
   openssl rand -base64 32
   ```
   `apps/web/auth.ts` rejects the build-time placeholder at request time and
   returns a 500 if the placeholder is detected — so a misconfigured deploy
   fails loud rather than signing JWTs with a known placeholder.

3. **Never commit `.env.local` or any file containing real secrets to git.**
   Use `.env.example` (the contract) and `.gitignore` (already configured).

---

## Step 7 — Deploy to Vercel

1. In the Vercel dashboard: New Project → Import from GitHub → select this repo.
2. Framework Preset: **Next.js** (auto-detected).
3. Root Directory: `apps/web`.
4. Add the environment variables from step 6.
5. Deploy.

### Important Vercel settings

- **Node.js Runtime** (not Edge): The app uses `@node-rs/argon2` (native
  binary) and `postgres-js` which cannot run in Edge Runtime. The Next.js
  config in `apps/web/next.config.mjs` marks these as `serverExternalPackages`
  so they are required at Node.js runtime rather than bundled. Vercel's default
  Node.js runtime handles this correctly.

- **`AEROOPS_DEMO` must be absent or unset**: Do not set it in Vercel env vars.
  The in-memory PGlite demo mode does not work on serverless — each function
  invocation gets its own ephemeral in-memory database with no shared state.

- **Build command**: `next build` (Vercel auto-runs this from `apps/web`).
  No `DATABASE_URL` is needed at build time — no DB connection is made during
  build. `AUTH_SECRET` placeholder is injected by `next.config.mjs` if absent
  at build time; the real secret is only needed at runtime.

---

## Rollback plan

If a migration causes issues:

1. Do NOT run `.down.sql` files automatically — review them first.
2. Connect with the owner role:
   ```bash
   psql "$OWNER_DATABASE_URL"
   ```
3. Manually apply the relevant `.down.sql` file:
   ```bash
   psql "$OWNER_DATABASE_URL" -f packages/db/migrations/NNNN_name.down.sql
   ```
4. Delete the `schema_migrations` row for the rolled-back migration:
   ```sql
   DELETE FROM schema_migrations WHERE id = 'NNNN_name.sql';
   ```
5. Fix the migration file, re-review, re-apply.

---

## RPO / RTO assumptions

- **RPO (recovery point objective):** depends on your provider's backup cadence.
  Neon and Supabase both offer point-in-time recovery on paid plans; free tiers
  have daily snapshots. For a demo/pilot, daily RPO is acceptable. Before
  customer data is stored, configure automated backups at the provider level.

- **RTO (recovery time objective):** for a Vercel + Neon deployment, a
  re-deploy from the last green commit takes under 5 minutes. Schema rollback
  (above) is manual and takes 15–30 minutes depending on complexity.

- **These assumptions are for a prototype/demo stage.** Before storing real
  customer data or taking payments, set up automated provider-native backups
  with a tested restore path and document a production RTO/RPO target.

---

## Quick-reference command sequence

```bash
# 1. Push to GitHub (CI runs automatically)
git push origin main

# 2. Preview pending migrations (dry run — safe, no changes)
DATABASE_URL="postgres://owner:pw@host/db?sslmode=require" pnpm db:migrate

# 3. Apply migrations (human-gated — review SQL first)
DATABASE_URL="postgres://owner:pw@host/db?sslmode=require" CONFIRM_APPLY=1 pnpm db:migrate:apply

# 4. Let aeroops_app log in and set its password
psql "postgres://owner:pw@host/db?sslmode=require" \
  -c "ALTER ROLE aeroops_app WITH LOGIN PASSWORD 'strong-password';"

# 5. (Demo only) Seed demo data
DATABASE_URL="postgres://owner:pw@host/db?sslmode=require" ALLOW_DEMO_SEED=1 \
  pnpm db:seed:demo

# 6. Deploy to Vercel (set DATABASE_URL=aeroops_app URL in Vercel env vars)
#    Visit your-domain.vercel.app/o/alpha/login (demo)
```

---

## Maintainer notes: redeploying the public demo

These steps are for whoever runs the public demo (the `alpha` and `bravo`
sample orgs). Do not use them on a deployment with real data: step 3 deletes
those two orgs and everything in them.

```bash
# 1. Apply any new migrations with the demo database's OWNER string.
#    Dry-run first — it applies nothing.
DATABASE_URL='OWNER_CONNECTION_STRING' pnpm db:migrate
DATABASE_URL='OWNER_CONNECTION_STRING' CONFIRM_APPLY=1 pnpm db:migrate:apply

# 2. Remove the old sample orgs (fictional data only; org_id FKs cascade).
#    Or run the DELETE in the Neon SQL console.
psql 'OWNER_CONNECTION_STRING' -c "DELETE FROM org WHERE slug IN ('alpha','bravo');"

# 3. Reseed both sample orgs.
DATABASE_URL='OWNER_CONNECTION_STRING' ALLOW_DEMO_SEED=1 pnpm db:seed:demo

# 4. Deploy the code: Vercel builds when the branch it tracks updates.
git push origin main
```

Then `/o/bravo/login` (owner@bravo.aero / demo1234) and `/o/alpha/login`
(owner@alpha.aero / demo1234) show the fresh data. If a step errors, capture
the error text (never the connection string) and fix it before continuing.

