# AeroOps

Multi-tenant flight-operations software for flight schools, flying clubs, and FBOs —
scheduling, dispatch, maintenance, training records, reporting, a student/renter
portal, and a public booking flow, with tenant isolation enforced in the database.

Built over about seven weeks (June–July 2026) by orchestrating 17 role-scoped Claude
Code agents against specs and merge gates defined up front. It was built to sell;
operators would not migrate off the tools they already used, so it is released under
the MIT license instead. A public demo runs at
[aeroops-web.vercel.app](https://aeroops-web.vercel.app).

---

## What it does

| Area | What's there |
|---|---|
| **Scheduling** | Reservations with conflict detection, recurrence, and an operator-configurable civil-twilight day/night constraint |
| **Dispatch** | Aircraft check-out/in, write-once Hobbs/tach meters, derived flight time, and a layered pre-flight gate (grounded → ineligible) |
| **Maintenance** | Squawks and operator-set grounding (surfaced *before* booking, enforced at check-out), work orders, and operator-defined maintenance items with due tracking |
| **Training** | Operator-defined courses and lessons, enrollments, write-once lesson records entered by the instructor, optional instructor attestation (not an FAA e-signature), optional stage-check enforcement |
| **Fleet & People** | Per-aircraft detail (grounding, open squawks, dispatch history, meters, upcoming reservations); members, roles, tags |
| **Reporting** | Utilization over time, hours by tail, reservations vs flights, training and maintenance trends |
| **Portal** | Student/renter self-service: own schedule, training progress, logbook, documents, and calendar feed; each read and write scoped to that user's own data |
| **Public booking** | Unauthenticated request capture → staff triage inbox → conversion to a real reservation through the same gated path every booking uses |
| **Mobile** | Expo app: sign-in, schedule, fleet, squawks, and alerts (read-only), against a token-authenticated mobile API |

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
apps/mobile     Expo / React Native app (shares packages/core).
```

**Tenant isolation is the design centre.** Every tenant query is scoped by `org_id`
in the API layer, with Postgres row-level security as an independent backstop — so a
bug in application code cannot leak across tenants. Eight membership roles
(owner, manager, dispatcher, CFI, mechanic, renter, student, accountant) map onto 21
capabilities that gate what each user can see and do. The accountant role is a
read-only reporting viewer (Dashboard, Reports, Activity).

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

Self-serve signup (`/signup`, which creates a new operation and its owner) is off
by default so the public demo can't be used to create real operations. On your own
deployment, set `ALLOW_SIGNUP=true` to create your first operation, or skip it and
sign in to the orgs created by `pnpm db:seed:demo`.

Checks: `pnpm typecheck` · `pnpm test` · `pnpm build`

> **Note:** `apps/mobile` is intentionally outside the pnpm workspace — its
> React Native React-18 types conflict with `apps/web`'s React 19. Install it
> separately with `cd apps/mobile && pnpm install`.

---

## How it was built

The repo carries its own build system. `.claude/agents/` holds 17 role-scoped
subagents (architect, schema-engineer, backend-engineer, frontend-engineer,
scheduling-engineer, test-writer, reviewer, compliance-officer, devops-engineer, and others),
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
- No fabricated regulation — Part 61/141/135 claims get flagged `[VERIFY]` and routed
  to the compliance agent
- Human gates on migrations, anything irreversible, anything customer-facing
- Finish slices, don't widen them

---

## Status

The live site at
[aeroops-web.vercel.app](https://aeroops-web.vercel.app) is a public demo with seeded
sample data, not a hosted service. It has no production users and no support is implied.

The repo has 51 forward migrations (`packages/db/migrations/0000`–`0050`, each with a
`.down.sql`) and about 125 test files (`*.test.ts`/`*.test.tsx` across `packages/` and
`apps/web`). Money features (billing, payments, dues, QuickBooks) were removed on
2026-10-10; their tables remain in the migration history but no application code uses
them. See [`DEPLOY.md`](./DEPLOY.md) for deployment and [`CHANGELOG.md`](./CHANGELOG.md)
for what landed when.

## License

MIT — see [`LICENSE`](./LICENSE).
