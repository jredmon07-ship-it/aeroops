# The FBO SaaS Bible

A complete build manual for **AeroOps** (working name): a multi-tenant SaaS that
matches everything Flight Schedule Pro does — scheduling, dispatch, billing/POS,
training records, maintenance, reporting, and a native mobile app — and adds an
integrated public booking website, an FBO fuel/line-ops module, and a runtime AI
layer. Built by an org chart of Claude Code agents driven from a single conductor
session.

---

## 0. How to read this — the operating model

This document is the single source of truth. Two things use it:

- **Claude Code agents** that build the product (the "company" below).
- **You, the founder**, who approves every gate.

### The honest mechanics (read once, internalize)

The "agent company" is a way to organize prompts and responsibilities — not a
literal autonomous hierarchy. In Claude Code, subagents are one level deep: they
can't spawn or command each other, and they report only back to the main session.
So:

- **You + the main conductor session = the executive function.** The conductor is
  the only thing that can sequence work. It invokes one specialist at a time and
  hands each the context it needs (subagents start with a fresh context window —
  the only channel in is the prompt string).
- **The "CEO," "CTO," "builders," etc. are role-scoped subagents the conductor
  calls.** The CEO agent doesn't deploy the builders; the conductor does, after you
  approve the CEO's plan.
- For genuinely autonomous multi-agent orchestration (agents coordinating across
  sessions), graduate to the Claude Agent SDK / agent teams. Keep the same roster;
  change the runtime. This bible is written so that move is a swap, not a rewrite.

Everything below respects that. When it says "the CEO prioritizes," it means: the
CEO subagent produces a prioritized plan; the conductor and you act on it.

---

## 1. Product vision and scope

**Vision.** The modern operating system for flight schools, flying clubs, and
FBOs. Feature parity with Flight Schedule Pro on web and mobile, a public booking
site bolted to the same data, and the operations FSP doesn't touch (fuel/line
service, CRM, charter, AI assistance).

**Who the tenant is.** One tenant = one operator (a flight school, club, or FBO).
Multi-base operators are one tenant with many locations. The platform itself is
the SaaS; each operator is an org.

**The three product surfaces.**

- **Web app** — full ops console for staff (schedule, dispatch, bill, train,
  maintain, report).
- **Mobile app** — iOS + Android (React Native/Expo): book, check in/out, grade
  lessons, pay, push notifications, digital logbook.
- **Public website + portal** — per-tenant marketing site, online booking funnel,
  and a renter/student self-service portal.

**Build discipline.** Parity is the goal; vertical slices are the method. We never
build a Hub half-deep across the board — we ship one Hub working end-to-end, then
the next. Scope creep is the enemy and the agents will happily indulge it; the CEO
agent's first job is to say no.

---

## 2. Full feature spec (parity + beyond)

Organized by Hub, matching FSP's structure. ✅ = FSP parity target. ➕ = beyond FSP.

### 2.1 Scheduling Hub

- ✅ Resources: aircraft (by tail #), instructors/staff, simulators, classrooms,
  crew cars, ground equipment.
- ✅ Calendar views: day/week/month, per-resource and combined dispatch board.
- ✅ Conflict detection across aircraft + instructor + student + room (no
  double-booking).
- ✅ Recurring reservations; drag-and-drop reschedule.
- ✅ Booking policies: who can book what, advance-booking limits, max duration,
  blackouts, required ratings.
- ✅ Civil-twilight-aware scheduling (day/night windows) using field GPS data.
- ✅ Intelligent/optimized auto-scheduling: define lesson requirements (aircraft
  type, lesson content, instructor availability), generate an optimized schedule
  across the fleet within business hours, then hand staff drag-and-drop adjustment.
- ✅ Unlimited users self-book on web + mobile.
- ✅ Check-out / check-in (dispatch) that feeds billing.
- ➕ Standby/waitlist with auto-promote; calendar sync (Google/iCal); SMS + email
  confirmations and reminders; weather-aware "at-risk" flags on bookings.

### 2.2 Dispatch

- ✅ Pre-flight gate before release: pilot currency, account balance, aircraft
  airworthiness/open squawks.
- ✅ Hobbs/Tach out and in → billable time.
- ✅ Squawk entry on return.
- ➕ Configurable dispatch rules per operator; weather-minimums + personal-minimums
  check; fuel ticket capture.

### 2.3 Billing & POS Hub

- ✅ Invoice generated at check-in, billed hours auto-populated from recorded
  Hobbs/tach ("billing autopilot").
- ✅ Pricing models: wet/dry hourly rental, block-time tiers, instruction rates
  (primary/advanced/multi), packages/bundles.
- ✅ Special pricing groups (loyalty, VA, staff, prepaid, club members).
- ✅ Online payments, card-on-file, card-present swipe via reader; money-on-account/
  prepaid balances; auto-recurring membership dues.
- ✅ Dispatch restrictions: block scheduling/dispatch on outstanding or
  below-minimum balance.
- ✅ QuickBooks Online sync; integrated merchant processing.
- ➕ Stripe-native rails, statements, automated dunning, credits/gift balances,
  scholarship tracking, VA Part 141 billing exports, refunds/adjustments (fully
  audited).

### 2.4 Training Hub

- ✅ Syllabi/courses for Part 61 and Part 141; lessons and stages.
- ✅ Student progress tracking, stage checks, checkride outcomes, instructor
  sign-offs, lesson grading.
- ✅ Logbook standardization / digital logbook; LogTen-style logbook integration.
- ✅ Part 141 audit-ready training records and FSDO reporting; training course
  outlines.
- ✅ Graduation/progress-to-certificate visibility.
- ✅ Document & certificate tracking with expiry (medical, photo ID, renter
  insurance, currency, TSA citizenship).
- ➕ Student portal, mobile lesson grading against ACS standards, AI progress
  summaries, predicted time-to-checkride, endorsement library with templates.

### 2.5 Maintenance Hub

- ✅ Inspection tracking: annual, 100-hr, ELT, transponder, pitot-static, AD
  compliance — hours-based and calendar-based due dates with advance alerts.
- ✅ Auto-block aircraft approaching a maintenance window in the scheduler.
- ✅ Squawk management workflow (open → defer/MEL → resolve) with grounding logic.
- ➕ Work orders, parts, labor; shop portal; engine-monitor/ADS-B ingestion hooks;
  predictive-maintenance flags.

### 2.6 Reporting Hub

- ✅ Customizable interactive reports and dashboards.
- ✅ Aircraft and instructor utilization, revenue, AR aging, student throughput,
  Part 141 compliance.
- ➕ Funnel/cohort analytics (lead → enrollment → checkride), churn,
  natural-language query over the operator's data.

### 2.7 Mobile app

- ✅ Native iOS + Android: view/book schedule, dispatch check-in/out, lesson
  grading, pay, digital logbook, push notifications.

### 2.8 Public website + online booking ➕ (the new wedge)

- Per-tenant themed marketing site (reuse the website-builder workflow), with an
  online booking funnel for intro flights, rentals, and discovery flights.
- Lead capture / quote requests routed into the CRM.
- Renter/student login portal: account, schedule, balance, pay, documents.
- Embeddable booking widget for an operator's existing site.
- Per-service / per-aircraft / per-location SEO pages.

### 2.9 Beyond-FSP modules ➕

- **FBO fuel & line ops:** Jet-A/100LL fuel sales, fuel-farm inventory, into-plane
  fueling tickets, ramp/parking/hangar/tie-down, GPU/lav/water line services.
- **Charter (Part 135):** quote requests, trip + crew management, flight following,
  AOG.
- **CRM + marketing automation:** lead pipeline, broadcast email/SMS, drip
  campaigns.
- **Open platform:** REST API + webhooks, Zapier, document e-sign (rental
  agreements, waivers), SSO for enterprise academies.

### 2.10 Cross-cutting

- Auth + RBAC (owner, manager, dispatcher, CFI, mechanic, renter, student,
  accountant).
- Multi-tenant isolation: `org_id` on every tenant row + Postgres RLS backstop.
- Notifications: email + SMS + push.
- Weather: AWC METAR/TAF + civil-twilight service.
- Audit logging on financial, dispatch, and training records.
- File storage (docs, logbooks); platform-wide search.
- Control plane: onboard new operators, plans/subscriptions, white-label domains,
  usage metering.

---

## 3. Architecture and stack

- **Web:** Next.js (App Router) + TypeScript.
- **Mobile:** React Native + Expo (shared TS domain logic with web via a
  `packages/core`).
- **DB:** Postgres (Neon/Supabase) + Drizzle (typed schema + migrations). RLS on
  for tenant isolation.
- **Auth:** Auth.js or Clerk with orgs + roles.
- **Payments:** Stripe (Connect for multi-tenant payouts); never store raw card
  data.
- **Accounting:** QuickBooks Online API.
- **UI:** Tailwind + shadcn/ui; design tokens per tenant for white-label.
- **Jobs/queues:** for reminders, dunning, maintenance alerts, schedule
  optimization.
- **AI runtime:** Claude Agent SDK / Messages API for the in-product agents (§7).
- **Repo shape:** monorepo — `apps/web`, `apps/mobile`, `packages/core` (domain
  types + business rules), `packages/db` (schema/migrations), `packages/api`.

Pick this and commit. Ambiguity is where agents produce their worst work.

---

## 4. Core data model (the spine)

**Tenant-scoped entities** (all carry `org_id`): Org, Location, User,
Membership(role), Resource (subtype Aircraft, Instructor, Sim, Room, Vehicle),
Aircraft (tail #, type, meters, rates, maintenance status), Reservation,
DispatchTicket (hobbs/tach out/in, squawks, fuel), Squawk,
MaintenanceItem/Inspection, Invoice/LineItem/Payment/Refund,
PricingGroup/Rate/Package, AccountBalance,
Course/Syllabus/Lesson/Enrollment/LessonRecord/StageCheck/Endorsement, Document
(with `expires_at`), Lead/Opportunity, FuelTicket/FuelInventory, AuditLog,
BookingWidgetConfig.

**Platform-scoped** (control plane, not `org_id`-scoped): Plan, Subscription,
Domain, PlatformUser.

**Rule:** every tenant query is filtered by `org_id`, and RLS enforces it even if a
query forgets.

---

## 5. The agent org chart (the company)

Each agent is a `.claude/agents/*.md` file: YAML frontmatter (name, description,
optional tools, optional model) + a system prompt. The description drives
auto-delegation; **MUST BE USED** / **use proactively** make it fire reliably.
Scope tools tightly — read-only agents get no write/Bash.

| Agent | Role | Tools (scope) | Model |
|---|---|---|---|
| ceo | Product owner: vision, roadmap, prioritization, scope guard, writes PRDs/tickets | Read, Grep, Glob, WebFetch | Opus |
| cto | Principal architect: system design, stack/ADR decisions, cross-cutting standards | Read, Grep, Glob, WebFetch | Opus |
| architect | Per-feature spec: data model delta, API contracts, UI states, edge cases, test list | Read, Grep, Glob | Opus |
| product-designer | UX flows, screen specs, component states, design tokens | Read, Grep, Glob | Sonnet |
| schema-engineer | Drizzle schema + migrations + RLS policies | Read, Edit, Bash | Sonnet |
| backend-engineer | Server actions / API / business logic | Read, Edit, Bash | Sonnet |
| frontend-engineer | Next.js pages, components, forms, states | Read, Edit, Bash | Sonnet |
| mobile-engineer | Expo/React Native parity app | Read, Edit, Bash | Sonnet |
| scheduling-engineer | The hard core: conflict detection, recurrence, optimized/civil-twilight scheduling | Read, Edit, Bash | Opus |
| integration-engineer | Stripe, QuickBooks, weather, SMS/email, logbook, card reader | Read, Edit, Bash, WebFetch | Sonnet |
| test-writer | Unit/integration/e2e per slice | Read, Edit, Bash | Sonnet |
| reviewer | Security + tenant-isolation pass; MUST run pre-commit | Read, Grep, Glob, Bash | Opus |
| compliance-officer | Part 61/141/135 correctness, audit records, FSDO reporting, [VERIFY] enforcement | Read, Grep, Glob, WebFetch | Opus |
| devops-engineer | CI/CD, env, migration runner, observability, backups | Read, Edit, Bash | Sonnet |
| data-analyst | Reporting Hub queries, dashboards, utilization metrics | Read, Edit, Bash | Sonnet |
| docs-writer | User/API docs, changelog, onboarding & migration guides | Read, Edit | Haiku |

Add agents as new modules demand them (e.g. `fuel-ops-engineer`,
`charter-engineer`). The roster is meant to grow.

The full agent files live in `.claude/agents/`. They follow the same shape: tight
description, scoped tools, a system prompt that says "read CLAUDE.md first," states
invariants, and forbids drifting outside the current slice.

---

## 6. CLAUDE.md (master project memory — repo root)

See `CLAUDE.md` at the repo root. It declares what we're building, the current
phase/slice (updated every session), the stack, the domain glossary, the
non-negotiable guardrails, and the per-slice Definition of Done.

---

## 7. In-product AI agents (runtime — Claude Agent SDK)

These ship **inside** AeroOps, not in the build pipeline. Each is a tool-using
agent over one org's data only, with a human-approve step before anything
customer-facing sends.

- **Billing autopilot assistant** — at check-in, reconciles Hobbs/tach to the rate
  model, drafts the invoice, flags anomalies.
- **Intelligent scheduler** — generates the optimized fleet schedule (the engine in
  §5 exposed conversationally to staff).
- **Dispatch assistant** — checks currency + balance + squawks + weather minimums,
  drafts the dispatch ticket or the reason for hold.
- **Weather go/no-go advisor** — METAR/TAF + personal minimums → plain-English call
  with the numbers.
- **Student-progress summarizer** — turns logged lessons into a syllabus-progress +
  predicted-checkride snapshot.
- **Squawk triage** — classifies discrepancies (ground vs monitor) and drafts the
  maintenance note.
- **Lead/quote triage** — parses website inquiries, drafts structured replies,
  routes to CRM.
- **Reporting copilot** — natural-language questions over the operator's data
  (utilization, AR aging, throughput).

---

## 8. Slash commands (`.claude/commands/*.md`)

- `/roadmap` — invoke `ceo` to (re)prioritize and print the next tickets.
- `/spec <ticket>` — invoke `architect` (in plan mode) to produce the build spec.
- `/build` — run the slice in dependency order: schema → backend → frontend →
  (mobile) → integration.
- `/qa` — run `test-writer` then `reviewer` then `compliance-officer`.
- `/ship` — run `devops` (migrate/CI) and `docs-writer` (changelog), then summarize
  the diff for human review.

---

## 9. The orchestration protocol (how the company runs)

A "sprint" is one slice. The conductor (main session) runs this loop; you approve
the **bolded** gates.

1. **Plan.** `/roadmap`. The `ceo` proposes the next slice + tickets. **You approve
   priorities.** Update CLAUDE.md "Current slice."
2. **Spec.** `/spec <ticket>` → `architect` (and `cto` for anything cross-cutting)
   returns data model delta, API contracts, UI states, edge cases, test list. **You
   approve the design.**
3. **Build.** `/build`. The conductor invokes builders in order, passing each a
   context packet (the ticket + the architect's spec + relevant file paths +
   acceptance criteria) because subagents start fresh. `scheduling-engineer` owns
   anything touching the calendar engine.
4. **Quality.** `/qa`. `test-writer` covers happy path + the architect's edge cases;
   `reviewer` runs the security/tenant pass; `compliance-officer` checks any
   records/regs. Fix what they flag.
5. **Ship.** `/ship`. `devops` reviews the migration (**human approves
   migrations**), runs CI; `docs-writer` updates the changelog.
6. **Human gate.** **You read the diff, run it locally, merge, demo.** Then back to
   step 1.

**Ticket format (CEO output):** Title · User story ("As a `<role>`, I want `<x>` so
that `<y>`") · Acceptance criteria · Primary action · Dependencies · Definition of
Done.

**Context-packet rule:** every delegation carries everything the subagent needs in
the prompt. No subagent is assumed to remember the last one's work.

**Restart Claude Code after adding/editing agent files** — they load at startup.

---

## 10. Build roadmap (phased, sliced)

**Phase 0 — Foundation.** Monorepo, CLAUDE.md, the agent roster, auth + RBAC,
multi-tenant `org_id` + RLS, control-plane skeleton (orgs, plans), CI/CD. **DoD:** a
logged-in user in an isolated org sees only their org's empty app.

**Phase 1 — Scheduling + Dispatch (the core).**

- Slice 1: resources + reservations + conflict detection.
- Slice 2: booking policies, recurrence, drag-and-drop, dispatch board.
- Slice 3: dispatch check-out/in (Hobbs/tach), squawk-on-return, pre-flight gate.
- Slice 4: civil-twilight + optimized auto-scheduler.

**Phase 2 — Billing & POS.** Rates/pricing groups/packages → invoice-at-check-in
(billing autopilot) → Stripe payments + card-on-file → account balances + dispatch
restrictions → QuickBooks sync → refunds/adjustments (audited).

**Phase 3 — Training Hub.** Syllabi/lessons/stages → progress + grading + stage
checks + endorsements → document/cert expiry tracking → Part 141 audit records +
FSDO reports → logbook + LogTen integration.

**Phase 4 — Maintenance Hub.** Inspections (hours + calendar) + alerts → scheduler
auto-block → squawk workflow + grounding → work orders/parts/labor.

**Phase 5 — Reporting Hub.** Utilization, revenue, AR aging, throughput, compliance
dashboards → funnel/cohort → NL query copilot.

**Phase 6 — Public website + booking + portal.** Per-tenant marketing site (reuse
the website-builder workflow) → online booking funnel + embeddable widget →
renter/student portal → lead capture → CRM.

**Phase 7 — Mobile app.** Expo parity: schedule, book, dispatch, grade, pay,
logbook, push.

**Phase 8 — Beyond FSP.** FBO fuel/line ops → Part 135 charter → marketing
automation → open API/webhooks/e-sign/SSO → full runtime AI layer (§7).

Ship each phase before starting the next. Within a phase, ship each slice before
the next.

---

## 11. Guardrails and non-negotiables (repeat them)

- **Tenant isolation is the whole game.** One un-scoped query leaks one operator's
  customers to another. RLS backstop; `reviewer` checks every diff.
- **Don't fabricate regulation.** Part 61/141/135 hour requirements, currency
  windows, and audit rules change and vary — `[VERIFY]` against the FAR/AIM, route
  through `compliance-officer`.
- **Money and records are audited, not editable.** Invoices, Hobbs/tach,
  endorsements, stage checks, maintenance sign-offs.
- **PCI stays with Stripe.** Never store raw card data.
- **Human gates:** migrations, anything irreversible, anything customer-facing that
  sends, anything touching payments.
- **The CEO agent's prime directive is "no."** Parity is reached by finishing
  slices, not by widening them.

---

## 12. Quick-start

1. `npx @anthropic-ai/claude-code` in an empty monorepo.
2. Add `THE-BIBLE.md` + `CLAUDE.md` + the `.claude/agents/*` roster +
   `.claude/commands/*`. Restart.
3. `/roadmap` → approve Phase 0 → build the foundation → demo isolated multi-tenant
   auth.
4. `/roadmap` → Phase 1, Slice 1 (conflict detection) → `/spec` → `/build` → `/qa`
   → `/ship` → merge.
5. Repeat slice by slice. Update CLAUDE.md "Current slice" every session. Never
   widen scope until the slice meets its DoD.
