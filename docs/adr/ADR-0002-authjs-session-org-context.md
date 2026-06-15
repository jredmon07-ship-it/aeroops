# ADR-0002 — Auth.js + session-bound org context

**Status:** Accepted (Slice 0.2). **Owners:** CTO, architect. **Builds on:** ADR-0001.

## Context
Users must sign in and have every request bound to exactly one org, feeding
ADR-0001's `withOrgContext`. `app_user.email` is unique only *within* an org, so a
human may be a separate user in several orgs — login must be scoped to one org, and
tenant resolution + credential verification happen *before* any org context exists.

## Decision
- **Auth.js (NextAuth v5), JWT session strategy.** The signed token carries
  `{ userId, orgId, role, email, slug }`. No adapter/session tables. `AUTH_SECRET`
  from `.env` only; fail-loud if missing. Read server-side only via `auth()`.
- **Tenant resolution by path prefix `/o/[slug]`.** Doesn't foreclose white-label
  domains later (a future host→slug resolver feeds the same canonical path).
- **Credentials provider, email + password, argon2id.** Hashes live in a separate
  org-scoped `auth_credential` table (full RLS, composite FK to `app_user(id,org_id)`).
  Hash never returned/logged/in the token. Uniform failures + dummy-verify resist
  user enumeration.
- **Bootstrap vs RLS:** `resolveOrgBySlug` is the *only* platform-scoped read on the
  public login path — read-only, single row, `{id,name,slug,status}`. The credential
  check then runs inside `withOrgContext(orgId)`, so cross-org login is rejected by
  RLS, not app logic. No public path reaches `withPlatformAdminContext`.
- **org_id trust:** the authenticated org is whatever the verified JWT says. The
  URL slug / form fields feed *login resolution* only. Middleware gates `/o/[slug]/*`
  on a valid session and fails closed when the URL slug ≠ `session.slug`. JWT
  callbacks are single-sourced (`edge-callbacks.ts`) so the edge-runtime middleware
  instance and the full server instance can't drift.
- **Package boundaries:** `apps/web` → `@aeroops/api` + `@aeroops/core` only (never
  `@aeroops/db`). Auth logic + config live in `packages/api`; NextAuth instantiation,
  middleware, and `auth()` live in `apps/web`. The edge bundle is db/argon2-free.

## Consequences
- JWT revocation isn't instant (bounded by `maxAge`); hard revocation deferred.
- `AUTH_SECRET` placeholder is build-phase-only (`NEXT_PHASE`), with a runtime
  assertion refusing to boot on a missing/placeholder secret.

## Invariants (reviewer enforces)
1. Authenticated `org_id` always from the verified session, never request input.
2. No public/pre-auth path reaches platform-admin context except `resolveOrgBySlug`.
3. Passwords argon2id only; `password_hash` never leaves the DB layer.
4. `apps/web` never imports `@aeroops/db`; the session is read only via `auth()`.

## Deferred (tracked)
Auth-event auditing; rate-limiting + WAF; instant JWT revocation; full browser e2e
+ live-DB demo (Slice 0.4). See [[aeroops-tenant-isolation-invariants]].
