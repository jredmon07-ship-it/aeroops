# AeroOps

Multi-tenant flight-operations software for flight schools, flying clubs, and FBOs —
scheduling, dispatch, maintenance squawks, billing, a student/renter portal, and a
public booking flow, with tenant isolation enforced in the database.

Built in a month by orchestrating 17 role-scoped Claude Code agents against specs and
merge gates defined up front. Released under the MIT license.

---

## What it does

| Area | What's there |
|---|---|
| **Scheduling** | Reservations with conflict detection, recurrence, and an operator-configurable civil-twilight day/night constraint |
| **Dispatch** | Aircraft check-out/in, write-once Hobbs/tach meters, derived flight time, and a layered pre-flight gate (grounded → ineligible → balance) |
| **Maintenance** | Squawks and operator-set grounding, surfaced *before* booking and enforced at check-out |
| **Fleet & People** | Per-aircraft detail (grounding, open squawks, dispatch history, meters, upcoming reservations); members, roles, tags |
| **Reporting** | Utilization over time, hours by tail, reservations vs flights, training and maintenance trends |
| **Portal** | Read-only student/renter self-service, each read locked to that user's own data |
| **Public booking** | Unauthenticated request capture → staff triage inbox → conversion to a real reservation through the same gated path every booking uses |
| **Billing** | Rate schedules and draft invoice generation with integer-cents math (no payment processing wired) |

## Architecture

A TypeScript pnpm monorepo with a strict dependency direction:

```
packages/core   Pure domain logic — conflict detection, booking policy, recurrence,
                flight-time math, civil-twilight calc, scheduler optimizer.
                Zero runtime deps, property-tested.
packages/db     Drizzle schema + Postgres migrations + Row-Level-Security policies.
packages/api    The only layer that talks to the database. Auth, gated writes,
                per-tenant reads.
apps/web        Next.js (App Router) ops console.
apps/mobile     Expo / React Native foundation (shares packages/core).
```

**Tenant isolation is the design centre.** Every tenant query is scoped by `org_id`
in the API layer, with Postgres row-level security as an independent backstop — so a
bug in application code cannot leak across tenants. Five permission-scoped roles
(owner, front desk, instructor, member, driver) gate what each user can see and do.

---

## Running it locally

Requires **Node 20+**, **pnpm 9**, and a **Postgres** database (a free
[Neon](https://neon.tech) project works; any local Postgres does too).

```bash
corepack enable
pnpm install
cp .env.example .env.local      # set DATABASE_URL, DIRECT_URL, AUTH_SECRET
pnpm db:migrate:apply           # applies migrations (human-gated by design)
pnpm db:seed:demo               # demo orgs, fleet, members, flight history
pnpm dev                        # http://localhost:3000
```

Generate `AUTH_SECRET` with `openssl rand -base64 32`. `DATABASE_URL` is the pooled
runtime connection; `DIRECT_URL` is the direct connection used by migrations (on a
single-endpoint local Postgres, set both the same).

Checks: `pnpm typecheck` · `pnpm test` · `pnpm build`

> **Note:** `apps/mobile` is intentionally outside the pnpm workspace — its
> React Native React-18 types conflict with `apps/web`'s React 19. Install it
> separately with `cd apps/mobile && pnpm install`.

---

## How it was built

The repo carries its own build system. `.claude/agents/` holds 17 role-scoped
subagents (architect, schema-engineer, backend-engineer, frontend-engineer,
scheduling-engineer, test-writer, reviewer, compliance-officer, devops, and others),
and `.claude/commands/` holds the pipeline that drives them:

```
/roadmap        propose the next slice + tickets
/spec <ticket>  return the build spec
/build          builders run in dependency order
/qa             test-writer → reviewer → compliance-officer
/ship           migrations, CI, changelog
```

Every gate was human-approved. The interesting part is not that agents wrote code —
it's the constraints they wrote it against, which are in [`CLAUDE.md`](./CLAUDE.md)
and [`THE-BIBLE.md`](./THE-BIBLE.md).

**Invariants that never bent:**

- Tenant isolation is the whole game — every query scoped by `org_id`, RLS as backstop
- PCI stays with the processor — no raw card data, ever
- No fabricated regulation — Part 61/141/135 claims get flagged `[VERIFY]` and routed
  to the compliance agent
- Human gates on migrations, anything irreversible, anything customer-facing
- Finish slices, don't widen them

---

## Status

Feature-complete through Phase 1 and deployed. Billing exists behind an off-by-default
flag with no payment processing wired — see [`DEPLOY.md`](./DEPLOY.md) for the full
deployment path and [`CHANGELOG.md`](./CHANGELOG.md) for what landed when.

This is a portfolio project, not a hosted service. It is not accepting production
users, and no support is implied.

## License

MIT — see [`LICENSE`](./LICENSE).
