# AeroOps: project guide

This file is read by Claude Code at the start of every session, and it is the
short version of the rules for human contributors too. The full product spec is
[`THE-BIBLE.md`](./THE-BIBLE.md); design decisions are in [`docs/adr/`](./docs/adr),
and per-slice build specs are in [`docs/specs/`](./docs/specs).

## What AeroOps is

Multi-tenant flight-operations software for flying clubs, flight schools, and FBOs:
scheduling, dispatch, maintenance squawks and grounding, training records,
reporting, a student/renter portal, and a public booking-request page. Do not add
billing or payment features. One tenant is one operator
(an "org"). Eight roles (owner, manager, dispatcher, cfi, mechanic, renter,
student, accountant) map onto 21 capabilities; accountant is a read-only
reporting viewer. It was built as a commercial product and did not find
operators willing to migrate off their existing tools. A public demo runs at https://aeroops-web.vercel.app.

## Layout and stack

TypeScript pnpm monorepo (Node 20+, pnpm 9). Dependencies point one way:

```
packages/core   Pure domain logic (conflict detection, booking policy, recurrence,
                flight-time math, civil twilight, auto-scheduler). No I/O.
packages/db     Drizzle schema, Postgres migrations (each with a .down.sql), RLS policies.
packages/api    The only layer that talks to the database: auth, gated writes,
                per-tenant reads.
apps/web        Next.js App Router ops console (Auth.js, Tailwind, shadcn).
apps/mobile     Expo app. Kept OUT of the pnpm workspace on purpose (its React 18
                types clash with apps/web's React 19); run `pnpm install` inside it.
site/           Static project site.
```

Common commands: `pnpm dev`, `pnpm typecheck`, `pnpm lint`, `pnpm test`,
`pnpm db:migrate` (dry run), `pnpm db:migrate:apply`, `pnpm db:seed:demo`.

## Domain glossary (use these terms exactly)

- **Tail #** = aircraft N-number; aircraft are scheduled by tail #.
- **Hobbs/Tach** = engine meters; flight time derives from them.
- **Wet/dry** = with/without fuel.
- **Dispatch** = releasing an aircraft; produces a ticket.
- **Squawk** = reported discrepancy.
- **Currency** = pilot legal recency (medical, flight review, IPC, 90-day).
- **Stage check** = milestone eval.
- **Part 61 vs 141** = two training regimes (141 has stricter record/audit rules).
- **FBO** = the operator/tenant.

## Non-negotiable guardrails

- **Tenant isolation above all.** Every tenant table has `org_id` with RLS
  ENABLEd and FORCEd. Tenant queries run inside `withOrgContext`
  (`packages/db/src/org-context.ts`, ADR-0001), which sets the org for the
  transaction so RLS is an independent backstop. `org_id` always comes from the
  session or a server-side lookup, never from client input. Never write a query
  that can read across orgs.
- **Secrets** live in `.env` files only. Never hardcode or commit keys.
- **Records integrity.** Hobbs/tach readings, training records,
  endorsements, stage checks, and maintenance sign-offs are audited and never
  silently mutated. Corrections are append-only (e.g. dispatch meter corrections,
  voided lesson records).
- **Compliance.** Never invent FAR / Part 61 / 141 / 135 rules. Anything that
  depends on a regulation gets flagged `[VERIFY]`. The app stores operator data
  (grounding, tags, lesson grades, sign-offs); it does not compute FAA currency,
  airworthiness, or return-to-service determinations, and UI disclaimers that say
  so are load-bearing.
- **Tests.** Every change ships with tests. Conflict detection, booking-policy
  evaluation, flight-time derivation, the grounding and twilight gates, and the
  auto-scheduler get property-based tests (fast-check). Tenant-isolation and
  authorization paths get integration tests.
- **Migrations.** A human reviews every migration before it runs against a real
  database. `db:migrate` is a dry run; `db:migrate:apply` is the deliberate step.
- **Nothing destructive or irreversible** without explicit human confirmation.

## Frozen engines (extend additively only)

These are the core write paths. New behaviour is added as new arms or new
dimensions; existing behaviour stays byte-identical.

| Engine | Decision record |
|---|---|
| Conflict engine | [ADR-0004](./docs/adr/ADR-0004-scheduling-conflict-engine.md) |
| Booking-policy gate | [ADR-0005](./docs/adr/ADR-0005-booking-policy-gate.md) |
| Recurrence / reschedule | [ADR-0006](./docs/adr/ADR-0006-recurring-reservations.md) |
| Dispatch records | [ADR-0007](./docs/adr/ADR-0007-dispatch-records.md) |

Every reservation, whether single, recurring, rescheduled, auto-scheduled, or
converted from a public booking request, is created through the one shared
`gatedCreateOccurrence` path in `packages/api/src/scheduling`. Do not add a
second INSERT path. Other ADRs cover auth/session (0002), the role-to-capability
permission model (0003), training records (0011), and work orders (0012).

## How the work was organised

The repo carries a set of role-scoped subagent prompts in `.claude/agents/`
(architect, schema-engineer, backend-engineer, frontend-engineer,
scheduling-engineer, test-writer, reviewer, compliance-officer, and others) and
slash commands in `.claude/commands/` that run them in order. It is a way to
organise prompts, not an autonomous system: a human approves each gate.

1. `/roadmap`: propose the next slice and its tickets. **Human approves priorities.**
2. `/spec <ticket>`: the architect writes the build spec (data model, API
   contracts, UI states, edge cases, test list). **Human approves the design.**
3. `/build`: builders run in dependency order: schema, backend, scheduling
   engine, frontend, mobile, integrations.
4. `/qa`: tests, then a security/tenant-isolation review, then a compliance
   review if records or regulations are touched.
5. `/ship`: CI and a staged migration with its rollback. **Human approves the
   migration**, reads the diff, and merges.

Each subagent starts with a fresh context, so every delegation carries the
ticket, the approved spec, the relevant file paths, and acceptance criteria. If a
task drifts outside the approved slice, stop and ask rather than widening it.
Restart Claude Code after editing agent files; they load at startup.

## Current slice

None in progress. `/roadmap` records the approved slice here.

## Definition of done (per slice)

Spec approved, then schema and migration, backend, web UI (plus mobile if in
scope), tests passing (`pnpm typecheck && pnpm lint && pnpm test`), review pass,
compliance pass if records or regulations are touched, human review of the diff,
merge.
