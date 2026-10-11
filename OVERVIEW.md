# AeroOps — Overview

Open-source (MIT) flight-operations software for flying clubs, flight schools, and
FBOs: scheduling, dispatch, maintenance, training records, and reporting. It was
built to sell; operators would not migrate off the tools they already used. A public
demo with seeded sample data runs at
[aeroops-web.vercel.app](https://aeroops-web.vercel.app). There are no production users.

> One operator = one tenant. Every tenant table carries `org_id` and is isolated at
> the database level with Postgres row-level security, not only in application code.

---

## Run it locally with no setup

```bash
pnpm install
pnpm demo          # → http://localhost:3000/o/alpha/login
```

The app boots against an in-process Postgres (PGlite/WebAssembly), seeded with two
sample operations. Log in as `owner@alpha.aero` / `demo1234`. See
[`DEMO.md`](./DEMO.md) for all logins. State resets on each restart.

For a real Postgres setup, see [`README.md`](./README.md) and [`DEPLOY.md`](./DEPLOY.md).

---

## What's in the code

| Area | What's there |
|---|---|
| **Scheduling** | Conflict detection backed by a Postgres `EXCLUDE` constraint, booking policies, weekly recurrence, drag-and-drop reschedule, civil-twilight day/night constraint, an auto-scheduler |
| **Dispatch** | Check-out/in, write-once Hobbs/tach, derived flight time, a pre-flight gate (grounded → ineligible) |
| **Maintenance** | Squawks, operator-set grounding, work orders, maintenance items with due tracking |
| **Training** | Courses, lessons, enrollments, write-once lesson records entered by the instructor, optional instructor attestation (not an FAA e-signature) |
| **Fleet, people, reporting** | Per-aircraft detail, members/roles/tags, an ops dashboard and operational reports |
| **Portal & public booking** | Student/renter self-service; a public booking-request page with a staff triage inbox |
| **Mobile** | Expo app (sign-in, schedule, fleet, squawks, alerts; read-only) on a token-authenticated API |

---

## How it's built

A TypeScript pnpm monorepo:

```
packages/core   Pure domain logic (conflict detection, policy, recurrence,
                flight time, civil twilight, optimizer). Property-tested.
packages/db     Drizzle schema, Postgres migrations, row-level-security policies.
packages/api    The only layer that talks to the database.
apps/web        Next.js (App Router) ops console.
apps/mobile     Expo / React Native app (outside the pnpm workspace).
```

Stack: Next.js, Drizzle + Postgres, Auth.js, Tailwind + shadcn/ui, Expo.

Counts at this commit, and how they were taken:

- **Migrations:** 51 forward migrations, `0000`–`0050` (`packages/db/migrations/*.sql`
  excluding `*.down.sql`), each with a down migration.
- **Tests:** 125 test files (git-tracked `*.test.ts` / `*.test.tsx`: 59 in
  `packages/api`, 21 in `packages/core`, 20 in `packages/db`, 25 in `apps/web`).
  Each file holds many cases; property-based tests cover conflict detection, booking
  policy, flight time, the grounding/eligibility gates, civil twilight, and the optimizer.
- **Roles:** 8 (owner, manager, dispatcher, CFI, mechanic, renter, student,
  accountant — `packages/core/src/roles.ts`), mapped to 21 capabilities
  (`packages/core/src/capabilities.ts`). The accountant role is a read-only
  reporting viewer.
- **Agents:** 17 role-scoped Claude Code subagents in `.claude/agents/`.
- **Docs:** 9 ADRs in `docs/adr/`, 40 files in `docs/specs/`.

---

## Security and compliance model

- **Tenant isolation.** Every tenant table has `org_id` and RLS `ENABLE + FORCE`. The
  app connects as a non-superuser role (`aeroops_app`) and refuses to start on a
  superuser connection. `org_id` comes from the signed session, never from client input.
- **Auth.** Org-scoped credentials, argon2id hashing, anti-enumeration timing, and
  server-side capability checks on every protected action. The mobile API reuses the
  same verification pipeline via signed tokens.
- **Records integrity.** Hobbs/tach meters, lesson records, sign-offs, grounding
  events, and audit rows are write-once or append-only; corrections are appended.
- **Regulations.** The software does not compute FAA determinations. Grounding and
  pilot eligibility are operator data; civil twilight is astronomy, not a night-currency ruling.
- **Migrations.** Staged for human review; never auto-applied.

---

## Where to look

- [`README.md`](./README.md) — setup and how it was built.
- [`DEMO.md`](./DEMO.md) — local demo and logins.
- [`DEPLOY.md`](./DEPLOY.md) — deploying to Postgres + Vercel.
- [`CHANGELOG.md`](./CHANGELOG.md) — what shipped, slice by slice.
- [`THE-BIBLE.md`](./THE-BIBLE.md) — the original product spec (broader than what was built).
- `docs/adr/`, `docs/specs/` — architecture decisions and per-slice build specs.
