# AeroOps

**Multi-tenant SaaS for flight schools, clubs, and FBOs** — scheduling, dispatch,
maintenance, fleet, people, reporting, and an intelligent auto-scheduler, with a
native-app foundation. Built as a modern alternative to Flight Schedule Pro /
Pilotbase.

> One operator = one tenant. Every byte of one operator's data is isolated from
> every other operator's at the database level (Postgres Row-Level Security),
> not just in application code.

---

## Try it in 30 seconds (no setup)

```bash
pnpm install
pnpm demo          # → http://localhost:3000/o/alpha/login
```

The whole app boots against an **in-process Postgres** (PGlite/WebAssembly) — no
Docker, no database to install, no cloud account — seeded with a believable
flight school ("Alpha Flight School"). Log in as **`owner@alpha.aero` / `demo1234`**
and click through scheduling, the dispatch board, the fleet, people, the ops
dashboard, and the auto-scheduler. See **[`DEMO.md`](./DEMO.md)** for the logins and
a 5-minute tour. State resets on each restart — click freely.

---

## What's built

A complete operational spine, every feature reviewed for correctness, tenant
isolation, and FAA-compliance posture, with **~2,260 automated tests** (unit,
integration against a real Postgres engine, and property-based tests for the
critical algorithms):

| Area | What it does |
|---|---|
| **Scheduling** | Resource booking with a race-safe **no-double-book engine** (Postgres `EXCLUDE` constraint), operator booking policies, weekly recurrence (DST-correct), drag-and-drop reschedule. |
| **Dispatch** | Aircraft check-out/in, write-once Hobbs/tach meters, derived flight time, and a layered **pre-flight gate**: grounded → ineligible (operator-set requirements) → balance (Phase-2 seam). |
| **Maintenance** | Squawks (discrepancy reports) + operator-set **grounding** — surfaced *before* booking and enforced at check-out (a thing the incumbents hide until after you book). |
| **Fleet** | Per-aircraft detail aggregating grounding, open squawks, dispatch history, last-recorded meters, and upcoming reservations. |
| **People** | Members + roles + free-text tags; the anchor for every future hub. |
| **Reporting** | An ops dashboard: flights/hours/utilization, reservations, open squawks, grounded count — the landing screen. |
| **Civil twilight** | A pure astronomical sunrise/sunset/civil-twilight calculator powering an operator-configurable day/night booking constraint. |
| **Auto-scheduler** | "Build my schedule" — a deterministic optimizer that proposes a complete schedule, then routes every proposal through the same safety gates. |
| **Mobile (foundation)** | Token-based mobile auth + a read-only schedule API, with the *identical* org-isolation/RLS/auth posture as the web (the Expo app is the next step). |

**Status:** Phase 1 (Scheduling + Dispatch + the breadth hubs + the optimizer) is
**feature-complete**. It has **not been deployed yet** — database migrations are
staged and human-gated (never auto-applied), and a hosted environment is the next
step (see **[`DEPLOY.md`](./DEPLOY.md)**).

---

## How it's built

A TypeScript **pnpm monorepo** with a strict dependency direction:

```
packages/core   Pure domain logic — conflict detection, booking policy, recurrence,
                flight-time, the civil-twilight calc, the scheduler optimizer.
                Zero runtime deps; property-tested; safe to share with the mobile app.
packages/db     Drizzle schema + Postgres migrations + Row-Level-Security policies.
packages/api    The only thing that talks to the database. Auth, the gated write
                paths, the per-tenant read surface. Node-only (argon2, postgres).
apps/web        Next.js (App Router) ops console. Talks to packages/api server-side.
apps/mobile     Expo / React Native (foundation: shares packages/core + the mobile API).
```

Stack: **Next.js · Drizzle + Postgres · Auth.js · Tailwind + shadcn/ui · Expo**.
Designed for Stripe + QuickBooks (Phase 2) and weather/civil-twilight integrations.

### The engineering disciplines that hold it together

- **One sanctioned write path.** Every reservation — single, recurring, rescheduled,
  or auto-scheduled — goes through one gated function. New constraints (grounding,
  eligibility, civil-twilight) are layered onto it *additively*; the core conflict /
  policy / recurrence engines are **frozen** and only extended, never modified.
- **Property-based tests** on the algorithms where correctness is non-negotiable:
  conflict detection, booking-policy evaluation, flight-time derivation, the
  grounding/eligibility gates, the civil-twilight calc, and the optimizer.
- **An ADR per cross-cutting decision** (`docs/adr/`) and a build spec per slice
  (`docs/specs/`).

---

## Security & compliance model

- **Tenant isolation above all.** Every tenant table carries `org_id` and has
  Postgres RLS `ENABLE + FORCE`. The app connects as a **non-superuser role**
  (`aeroops_app`) so RLS cannot be bypassed — the client even refuses to start if it
  detects a superuser connection. `org_id` is *always* taken from the signed session,
  never from client input. This was adversarially audited (a reviewer agent actively
  tried to break cross-org isolation and couldn't).
- **Auth.** Org-scoped credentials, argon2id hashing, anti-enumeration timing, and a
  capability-based RBAC gate checked server-side on every protected action. The mobile
  app reuses the *exact same* verification pipeline via short-lived signed tokens — no
  second crypto, no secret in the app bundle.
- **Records integrity.** Hobbs/tach meters, squawks, grounding events, and audit rows
  are write-once / append-only — no silent mutation.
- **Compliance posture.** The software never invents or computes FAA determinations.
  Grounding and pilot-eligibility are *operator data* (free-text), and civil twilight
  is surfaced as *astronomy*, never as an FAA night-currency/§61.57 ruling — every
  regulation-adjacent decision was reviewed by a compliance pass.
- **Money boundary.** No payment code in Phase 1 — the balance check ships as an
  inert, clearly-labeled stub. Stripe arrives in Phase 2.
- **Human-gated migrations.** Every schema migration is staged for human review and
  never auto-applied to a real database.

---

## Design priorities

Focus areas: **true multi-tenant isolation from
day one**, **grounding/squawk status surfaced before booking** (not hidden until
after), **cross-platform mobile** with full feature parity as the goal (the leader is
iOS-only with a thin app), an **intelligent auto-scheduler**, and a **civil-twilight**
seam the incumbents don't expose.

---

## Where to look

- **[`DEMO.md`](./DEMO.md)** — run it locally, logins, the click-through.
- **[`DEPLOY.md`](./DEPLOY.md)** — stand up a real Postgres + deploy a hosted demo.
- **[`CHANGELOG.md`](./CHANGELOG.md)** — what shipped, slice by slice.
- **[`CLAUDE.md`](./CLAUDE.md)** — project memory, current phase, and the guardrails.
- **[`THE-BIBLE.md`](./THE-BIBLE.md)** — the full product spec.
- **`docs/adr/`** — architecture decisions · **`docs/specs/`** — per-slice build specs.

---

## What's next

The Expo mobile app (the API foundation is done), a hosted deployment for live
demos, then Phase 2 Billing (Stripe/QuickBooks), Phase 3 Training (syllabi,
endorsements, stage checks), and Phase 4 Maintenance (work orders, inspections).
