# AeroOps — Zero-Setup Demo

A clickable prototype of the full AeroOps operations platform. It runs the
**real Next.js app** against an **in-process database** (PGlite — Postgres
compiled to WebAssembly), seeded with a believable flight-school dataset. No
Docker, no Postgres install, no `DATABASE_URL`, no cloud account.

## Run it

```bash
pnpm install      # first time only
pnpm demo
```

Then open **http://localhost:3000/o/alpha/login**

> Port in use? `PORT=3030 pnpm demo` → http://localhost:3030/o/alpha/login

The first page load spins up the in-memory database (apply migrations → seed →
switch to the row-level-security app role); you'll see `[demo] database ready`
in the terminal. It takes a few seconds, then it's instant.

## Logins

Two seeded operators. Password for **everyone**: `demo1234`

**Alpha Flight School** (`/o/alpha`) — the full product, every module on:

| Email | Role | What they can do |
|---|---|---|
| `owner@alpha.aero` | owner | **Everything** — best for a full tour |
| `manager@alpha.aero` | manager | Full scheduling + dispatch + training + settings |
| `dispatch@alpha.aero` | dispatcher | Schedule, dispatch board, training (read) |
| `cfi@alpha.aero` | instructor | Schedule, dispatch, training (manage) |
| `student@alpha.aero` | student | App access only (the locked-down view) |

**Bravo Flying Club** (`/o/bravo`) — a small club in **club mode** (2 aircraft;
training, public booking, and auto-scheduler turned off for a leaner nav):

| Email | Role | What they can do |
|---|---|---|
| `owner@bravo.aero` | owner | Full access; see Org settings → Modules to flip club/school mode |
| `admin@bravo.aero` | manager | Scheduling + dispatch + settings |
| `member@bravo.aero` | renter | The member portal view (reservations, logbook) |

Sign in as **`owner@alpha.aero`** for the full walkthrough below, or
**`owner@bravo.aero`** to see club mode.

**Create a fresh operation** at **http://localhost:3000/signup** — enter a name,
accept the Terms + Privacy clickwrap, and you land on the setup checklist with
your new org. (Self-serve tenant creation; migration 0049 staged.)

## What's seeded

- **5 users** (one per role above), each a real credentialed login.
- **4 aircraft** by tail #: `N172SP` (Cessna 172SP), `N152AB` (Cessna 152),
  `N28K` (Piper Archer), `N66RG` (Cirrus SR20) — with make/model/year/serial +
  home base **KOSU** — plus **1 instructor** resource (Casey Reed, CFI).
- **Today's flights:** a morning dual already flown (`N172SP`), a solo currently
  **checked out** (`N152AB`), and an afternoon stage-check prep (`N28K` + instructor).
- **Tomorrow:** a transition lesson on the Cirrus (`N66RG`).
- **A booking policy** on the Cirrus (max 3 h, ≤ 60 days out, ≥ 60 min lead).
- **A weekly recurring series** (Tue/Thu evenings, 8 sessions) on the Archer.
- **Dispatch tickets:** one **closed** (Hobbs/tach recorded, flight time derived)
  and one **open** (aircraft out now).
- **A grounded aircraft:** the Cirrus (`N66RG`) is **grounded** for a maintenance
  squawk (oil seep), plus a second minor open squawk on the 172.
- **A pre-flight requirement:** the Archer requires the free-text tag
  "Club checkout: complex" — the CFI has it (passes), the student doesn't (refused).
- **Civil-twilight** active in **warn** mode (base coordinates at KOSU).
- **Member tags** on the CFI + student (free-text).
- **A training course:** "Private Pilot — Part 61" (5 lessons); the student is
  **enrolled at 2/5 progress** (two lessons recorded by the CFI).
- **Profile photos** on several accounts (avatars in the roster + header).
- **A month of activity (both orgs):** ~56 flights over the last ~28 days on
  Alpha (~26 on Bravo), each a closed dispatch. So the **dashboard** shows a
  populated reservations-vs-flights **activity chart** + KPI **sparklines**, and
  **Fleet utilization** shows real per-tail hours. The **Reports** hub (`/reporting/reports`) charts utilization and
  reservations-vs-flights over time.

> Bravo Flying Club seeds the same shape at small-club scale (2 aircraft, 3
> members, club mode) and is the **primary** demo on the marketing site (the
> live-demo picker leads with the flying club). Both orgs reset to baseline on
> the hosted demo.

## 8-minute click-through (as owner)

1. **Ops dashboard** (`/o/alpha`) — the operator console: an "as of now" snapshot
   (grounded aircraft, open squawks, active fleet, members) vs. "last N days" KPIs
   (flights, hours, reservations) with **sparklines**, a **reservations-vs-flights
   activity chart**, a per-tail utilization table, and at-a-glance lists (today's
   flights showing tail # + notes, grounded, open squawks).
2. **Schedule** (sidebar → *Schedule*) — today's reservations across all aircraft +
   the instructor. Date arrows move between days; the recurring lessons appear on
   future Tue/Thu.
3. **New reservation** (*Schedule → New*) — overlap an existing booking to watch
   **conflict detection** refuse it; try > 3 h or < 1 h-lead on the **Cirrus** to
   watch the **booking policy** refuse it; pick an evening time to see the
   **day/night (civil-twilight)** indicator.
4. **Auto-scheduler** (*Schedule → Auto-schedule*) — define a few desired sessions,
   **Preview** the proposed schedule (what would be scheduled / skipped), then
   **Commit** — every proposed booking is routed through the same safety gates.
5. **Dispatch board** (*Schedule → Board*) — the day's aircraft as rows. `N152AB`
   shows **checked out**; **check it in** (enter Hobbs/tach) to close the ticket and
   see derived flight time. Try to **check out** the **Cirrus** to hit the
   **grounded** block; **check out** the **Archer** as the student to hit the
   **eligibility** refusal (and as the CFI to pass). **Drag** a block to reschedule.
   Open **Gate settings** to see the eligibility + twilight controls.
6. **Fleet** (*Fleet*) — the aircraft list; open the **Cirrus** to see its grounding,
   open squawks, dispatch history, last meters, and upcoming reservations.
7. **People** (*People*) — the member roster; open a member to see role, tags,
   bookings, dispatch-as-pilot, and a **Training** card.
8. **Training** (*Training*) — the "Private Pilot — Part 61" course + its lessons;
   open **Enrollments → Sam Student** to see the **2 / 5 progress**, the per-lesson
   checklist, and **Record lesson** / **Void** (an instructor data-entry record, not
   an e-signature).
9. **Roles** — sign out and back in as `student@alpha.aero` to see the
    capability-gated, locked-down view (no Fleet/People/Training/Reporting).

## How it works (and what it is *not*)

- `pnpm demo` (→ `scripts/demo.mjs`) sets `AEROOPS_DEMO=1` and starts `next dev`.
- In demo mode, the app's single DB accessor (`getDb()` in `packages/api`) returns
  an in-memory PGlite client instead of connecting to Postgres. It applies the
  **real, human-gated migrations** (`0000`–`0012`) and seeds through the **real
  write paths** (the same `createReservation` / `openDispatch` / `recordLesson` / …
  code the app uses), then drops to the non-superuser `aeroops_app` role so
  **row-level-security tenant isolation is enforced**, exactly as in production.
- **Everything is in memory.** State resets every time you restart `pnpm demo` —
  click freely. No real database is ever touched and **no migration is ever applied
  to one**. The production path (`createProdClient` + `DATABASE_URL`) is unchanged
  and never runs here.
- **Compliance posture:** grounding, eligibility, and "night" are operator data /
  astronomy — the app computes **no** FAA determination (no currency, medical,
  Part-61/141, or airworthiness ruling). AeroOps has **no money features**
  (billing, payments, and QuickBooks were removed on 2026-10-10).
- Not in this demo: the native mobile app UI (the mobile **API** is built + tested).
  See `CLAUDE.md`.

## Want a persistent (hosted) demo instead?

Provision a real Postgres (Neon/Supabase free tier), run the **human-gated**
migration apply, seed the demo data, and deploy to Vercel — so you can share a live
link. The full step-by-step is in **[`DEPLOY.md`](./DEPLOY.md)**.
