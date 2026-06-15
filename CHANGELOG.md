# Changelog

All notable changes to AeroOps are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/); the project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased] — Phase 0 (Foundation)

### Slice 0.3 — Isolated empty app shell + server-side RBAC gating

**Added**

- **RBAC capability model (`@aeroops/core`).** Single-source `ROLE_CAPABILITIES`
  matrix maps 8 roles (owner, manager, dispatcher, cfi, mechanic, renter,
  student, accountant) to capabilities: all roles can `app:access` (gates entry
  to the app shell); owner + manager can `org:manage_settings` (edit org config,
  deferred to future slices). Pure `can(role, capability)` and
  `capabilitiesForRole(role)` helpers with fail-closed, prototype-chain-safe
  semantics (unknown role/capability → false/[], never throw). `isMembershipRole`
  guard validates the role at the session boundary to catch malformed/external
  roles (degrades to clean deny).
- **Server-side enforcement (`@aeroops/api`).** `requireCapability(session,
  capability)` is the canonical RBAC gate, called at the top of every protected
  data fetch and mutation. Throws `UnauthenticatedError` (no/incomplete session)
  or `ForbiddenError` (role lacks capability); returns the narrowed session on
  success. `hasCapability` and `filterNavForSession` are UX/nav predicates only
  and never the sole gate (hiding a nav item is cosmetic; direct-URL access is
  blocked server-side).
- **App shell (`apps/web`, `(shell)` route group).** Authenticated landing wraps
  the dashboard and settings pages. Header includes org name (tenant-scoped via
  `getSessionOrg(session)` + RLS), user email, and role badge (ROLE_LABELS,
  never raw enum). Desktop sidebar + mobile drawer nav show role-filtered items:
  Dashboard (all roles, `app:access`); Org settings (owner + manager only,
  `org:manage_settings`, nav item hidden for other roles). Layout calls
  `filterNavForSession()` (UI only) to build the nav; the actual gate is
  `requireCapability()` in the page handler.
- **Org settings page (`/o/[slug]/settings`).** Read-only display of org name,
  slug, and status. Server-side gate: `requireCapability(session,
  'org:manage_settings')` throws `ForbiddenError` for renter/student/dispatcher/
  cfi/mechanic/accountant roles; catch block converts error to a redirect via
  `mapAuthErrorToResponse()` (pure helper, unit-testable). Non-owner hitting the
  URL directly is redirected to `no-access?reason=insufficient_role`, not merely
  absent from nav. Future slices add form fields + mutations.
- **Dashboard page (`/o/[slug]` or `/o/[slug]/`).** Greeting by org name,
  status banner (org active, Hubs coming later), and non-interactive placeholder
  cards for Scheduling, Billing, Training Hub stubs (marked "Not yet available",
  reduced opacity). Displays `locationCount` from `getDashboardSummary(session)`
  — the first real, tenant-scoped data point visible, proving RLS + session
  identity work end-to-end. All queries scoped to `session.orgId` (JWT, RLS
  backstop).

**Phase 0 DoD (Definition of Done)**

- A logged-in user in an isolated org sees only their org's empty app with
  role-appropriate navigation and read-only Org settings page, gated
  server-side.

**Security & boundaries**

- `apps/web` imports only `@aeroops/core` + `@aeroops/api`; never `@aeroops/db`.
  All DB access funneled through `@aeroops/api` helpers.
- Every protected entrypoint calls `requireCapability(session, cap)` before any
  data fetch; `ForbiddenError`/`UnauthenticatedError` are converted to redirects
  (no JSON error responses in Phase 0).
- Role-capability matrix is compile-time-checked (TypeScript `satisfies`) for
  exhaustiveness; adding a new role to `MEMBERSHIP_ROLES` without updating the
  matrix produces a compile error.
- Session `orgId` and `role` are immutable per token lifetime (8 hours). RLS
  scopes every row by `orgId` regardless of RBAC, so a stale role can at worst
  over/under-grant within the user's own org, never cross-org.

**Tests**

- Capability matrix logic: role→capability lookup + prototype-key fail-closed +
  exhaustiveness.
- RBAC allow/deny per role (owner/manager + org:manage_settings).
- Dashboard tenant-isolation (org_id scoping, RLS + session identity).
- Nav filtering (filterNavForSession returns correct items per role).
- Auth error handling (mapAuthErrorToResponse pure, unit-testable).

**Deferred** (tracked for later slices)

- Instant role revocation (membership-epoch check / session-revocation list) —
  Slice 0.4+ (stale role is bounded by JWT lifetime; RLS prevents cross-org
  leak).
- Browser e2e tests + live-DB demo — Slice 0.4.
- Audit logging for nav/access attempts — Phase 2+.

### Slice 0.2 — Auth + session-bound org context

**Added**

- **Auth.js (NextAuth v5) with Credentials provider.** Email + password login,
  argon2id hashing, JWT session strategy (`maxAge: 8 hours`). Credentials
  validated at two layers: (1) input shape via zod; (2) cross-org access
  rejected by Postgres RLS (tenant-scoped `verifyCredential`). Password never
  stored in JWT, token, or session; argon2id hash never returned to callers or
  logged.
- **Session field projection.** JWT carries `{ userId, orgId, slug, role, email
  }` (set by `jwtCallback` on sign-in, same function reference used by both
  full auth config + edge config). Session callback projects these onto the
  `AppSession` shape (`@aeroops/api/auth/types.ts`) used by all server-side
  code.
- **Tenant resolution by URL slug.** Login is org-scoped (`/o/[slug]/login`).
  `resolveOrgBySlug` is the ONLY platform-admin-scoped read in the auth path
  (SELECT on org table before any session exists). Resolves org.id, then
  `verifyCredential` runs under `withOrgContext(orgId)` — so cross-org password
  attacks are rejected at the RLS layer, never reaching credential verification.
- **Middleware (`apps/web/middleware.ts`) gates `/o/[slug]/*`.** Fail-closed:
  missing session → redirect to login; slug mismatch (session.slug ≠ URL slug)
  → redirect to correct org's login. Sessions are decoded+verified at Edge
  Runtime (no DB query), using `auth-edge.ts` + `buildEdgeAuthConfig`
  (JWT+session callbacks only, zero db/argon2 imports, safe for Vercel Edge).
- **Anti-enumeration (auth path).** `verifyCredential` runs constant-time
  password verification (argon2id) on all failure paths: missing user, missing
  credential, wrong password, missing membership. Errors return null uniformly;
  no "user not found" vs "password wrong" leakage.
- **AUTH_SECRET validation.** `buildAuthConfig` (full) + `buildEdgeAuthConfig`
  (edge) throw at call time if `AUTH_SECRET` is unset. `apps/web/auth.ts`
  performs runtime assertion: reject the build-phase placeholder
  `build-time-placeholder-not-a-real-secret-replace-me` at runtime (outside
  `next build` phase), so production cannot boot with a known secret (JWT
  forgery risk). Placeholder allowed only during `next build`.
- **`withSessionOrgContext` (request→org context).** Framework-agnostic seam in
  `@aeroops/api/auth/session.ts`. Accepts `AppSession | null | undefined`;
  throws `UnauthenticatedError('UNAUTHENTICATED')` if missing/incomplete. Calls
  `withOrgContext(db, session.orgId, fn)` — so the org_id for every tenant
  query comes ONLY from the verified JWT, never client input, never URL params.
  Two calling forms: app code (no db argument, uses `getDb()`) + tests (explicit
  `withSessionOrgContextWithDb`).

**Schema**

- **`auth_credential` table** (`packages/db/migrations/0001_auth_credential.sql`).
  Tenant-scoped, one-per-user credential row. Composite FK
  `(user_id, org_id) → app_user(id, org_id)` structurally prevents cross-org
  rows. Indexes on `org_id`. RLS enabled + forced; no platform-admin policy
  branch (auth_credential always accessed under `withOrgContext`, never by the
  control plane).
- **Human-gated migration.** `0001_auth_credential.sql` + rollback
  (`0001_auth_credential.down.sql`); NOT auto-applied. Staged for manual review
  + human sign-off before run.

**UI (apps/web)**

- **Next.js App Router with Tailwind + hand-rolled shadcn-compatible
  components.** Login screen, authenticated landing (minimal: "signed in to
  {org} as {role}"), no-access/bounce (no membership, suspended org), sign-out.
  All routes gated by middleware; session checked by `auth()` helper in
  server-side code only.

**Security hardening**

- **Edge bundle safety.** `auth-edge.ts` imports from
  `@aeroops/api/src/auth/edge-callbacks.ts` directly (not via the `@aeroops/api`
  barrel) to avoid pulling native deps (argon2, pglite, drizzle) into the Edge
  bundle. `edge-callbacks.ts` has zero DB/argon2 imports — pure field-copy
  logic, verified at module load.
- **Boundary invariant.** `apps/web` NEVER imports `@aeroops/db`. All DB access
  goes through `@aeroops/api` (which obtains the prod client via `getDb()`
  internally, memoized).
- **No db/argon2 at module load.** `buildAuthConfig` and `buildEdgeAuthConfig`
  do not require a db argument; the prod client is obtained lazily via `getDb()`
  inside the authorize callback (first request only). Test code injects an
  explicit db (pglite) via `withSessionOrgContextWithDb`.

**Deferred** (tracked for later slices)

- Auth event auditing (login/logout/mfa/password-change), signed audit trail —
  Slice 0.4+.
- Auth rate-limiting + WAF config — ops/Slice 0.5 (flagged `[VERIFY]` with ops).
- Instant JWT revocation (logout → invalidate existing tokens) — Phase 2, when
  first-class session table is introduced.
- Browser e2e tests + live-DB demo — Slice 0.4.

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
