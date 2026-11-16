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
| `student@alpha.aero` | student | The locked-down view: their portal, with the lessons booked for them and their training progress |

**Bravo Flying Club** (`/o/bravo`) — a small club in **club mode** (17 members,
2 aircraft and a club CFI; training, public booking, and auto-scheduler turned
off for a leaner nav):

| Email | Role | What they can do |
|---|---|---|
| `owner@bravo.aero` | owner | Full access; see Org settings → Modules to flip club/school mode |
| `admin@bravo.aero` | manager | Scheduling + dispatch + settings (the club's scheduler) |
| `member@bravo.aero` | renter | The member portal: the upcoming flights club staff booked for them, their logbook of past flights, and their account. |

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
- **Today's flights:** a morning dual cross-country (`N172SP` + instructor), a
  late-morning solo (`N152AB`) and an afternoon stage-check prep (`N28K` +
  instructor). The seed dates nothing after the moment it runs: a flight is
  checked out only once it has started and back in only once it is over. So
  the Board depends on when you start the demo: at 15:00 the two morning
  flights are checked in and the Archer is out; before 07:00 all three are
  still booked.
- **Tomorrow:** a transition lesson on the Cirrus (`N66RG`).
- **A booking policy** on the Cirrus (max 3 h, ≤ 60 days out, ≥ 60 min lead).
- **A weekly recurring series** (Tue/Thu evenings, 8 sessions) on the Archer.
- **Booked for the student:** today's three flights, the weekly series and the
  student's lessons and solos in the coming weeks are booked by the owner *for*
  Sam Student, so `student@alpha.aero`'s portal lists them under upcoming
  reservations ("Booked for you"), and the schedule shows "for Sam Student".
- **Dispatch tickets:** a **closed** one (Hobbs/tach recorded, flight time
  derived) for every flight in the history and each of today's that is over,
  and an **open** one (aircraft out) for a flight under way.
- **A grounded aircraft:** the Cirrus (`N66RG`) is **grounded** for a maintenance
  squawk (oil seep), plus a second minor open squawk on the 172.
- **A pre-flight requirement:** the Archer requires the free-text tag
  "Club checkout: complex" — the CFI has it (passes), the student doesn't (refused).
- **Civil-twilight** active in **warn** mode (base coordinates at KOSU).
- **Member tags** on the CFI + student (free-text).
- **A training course:** "Private Pilot — Part 61" (5 lessons); the student is
  **enrolled at 2/5 progress** (two lessons recorded by the CFI, each at the end
  of a dual flight in the 172 that is in the history).
- **No seeded profile photos:** every account shows the default silhouette;
  upload one from the portal.
- **The coming six weeks (both orgs):** after the hand-placed first days, a
  weekly pattern of lessons, solos and rentals out to six weeks, booked through
  the same gates as everything else, so every day you browse to on the schedule
  has flying.
- **Messages:** four announcements on Alpha (one to students only) and six on
  Bravo, sent over the last two weeks. Seeded without the e-mail fan-out.
- **A month of activity (both orgs):** ~56 flights over the last ~28 days on
  Alpha (37 on Bravo, across both aircraft), each a closed dispatch. So the
  **dashboard** shows a populated reservations-vs-flights **activity chart** +
  KPI **sparklines**, and **Fleet utilization** shows real per-tail hours. The
  **Reports** hub (`/reporting/reports`) charts utilization and
  reservations-vs-flights over time.

**Bravo Flying Club** (`/o/bravo`) is the **primary** demo on the marketing site
(the live-demo picker leads with the flying club). It seeds a working small club
in club mode:

- **17 members on People:** the three logins above, a mechanic (Pat Okafor), the
  club CFI (Morgan Ellis), renters, a student pilot, two new members part-way
  through their checkouts (one with no login yet), and two members who have left
  (under *Show inactive*). Each has tags (board roles, aircraft checkouts,
  ratings), a phone number and a "member since" date. Fictional people with
  `@example.com` addresses; only the three `@bravo.aero` logins are advertised.
- **2 aircraft and a club CFI:** `N735BW` (Cessna 172N Skyhawk), `N2189K` (Piper
  Warrior II), and Morgan Ellis as a bookable instructor. The Warrior has a
  booking policy (≤ 4 h, ≤ 45 days out, ≥ 60 min lead) and requires the free-text
  tag "Club checkout: N2189K" at check-out: Dana and Morgan pass, Riley (the
  member login) is refused, with a Warrior checkout booked for the day after
  tomorrow.
- **Four weeks of flying:** 37 flights over the last 27 days, on both aircraft,
  by eleven pilots, with Hobbs/tach that only climb, fuel and oil uplift,
  cross-country notes in the pilots' logbooks, and four cancellations with
  reasons (Reports → cancellations). Club staff book the flights: the scheduler
  for the members, the CFI for instruction. Each booking names the member it is
  for, so the schedule reads "for Riley Member" and the member's portal lists it.
- **Today:** Priya took the Skyhawk to Put-in-Bay overnight, so it is **checked
  out** until she is due back at 11:30. After that, a breakfast run in the
  Warrior, Riley's currency flight, Lena's scenic flight and a new member's
  checkout with the CFI, each checked out and in only as far as the clock had
  got when the demo was seeded: mid-afternoon, the morning's flights are
  checked in and Lena has the Skyhawk out. Tomorrow, Marcus flies his flight
  review with Morgan.
- **Every day has flying:** weekends, weekday evenings, a Tuesday morning and
  instruction on Thursdays, every day of the next six weeks.
- **Maintenance:** a work order in progress (the Warrior's tire) and a completed
  one (the Skyhawk's landing light), open, deferred and resolved squawks, and six
  maintenance-due items (two due soon, none overdue).
- **Expiration reminders** on members (medical, flight review, club checkout):
  three due soon and two lapsed (Marcus's flight review, and a medical on a
  member who is on leave). Warn-only operator dates, shown at check-out.
- **Six announcements** from the club's officers, to the 15 active members.

The member portal (`member@bravo.aero`) shows Riley's upcoming reservations,
logbook (past flights, running totals, cross-country notes) and account details.
Renters cannot book in the app, so club staff make the bookings and name the
member each one is for: Riley's upcoming reservations are the flights the
scheduler and the CFI booked for Riley (today's currency flight until it
starts, tomorrow's pattern work, the Warrior checkout with Morgan the day after,
then Riley's weekend and Wednesday-evening flying), each marked "Booked for you".

The hosted demo re-seeds both orgs every night at 03:00 Chicago time (DEPLOY.md,
"Public-demo daily refresh"), so its dates are always current. That is before
the day's first flight, so each day starts with today's flights booked, ready
to check out, and only Priya's overnight trip out.

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
   **day/night (civil-twilight)** indicator. Pick a member under **Booked for**
   and the booking shows up in that member's portal.
4. **Auto-scheduler** (*Schedule → Auto-schedule*) — define a few desired sessions,
   **Preview** the proposed schedule (what would be scheduled / skipped), then
   **Commit** — every proposed booking is routed through the same safety gates.
5. **Dispatch board** (*Schedule → Board*) — the day's aircraft as rows, today's
   flights checked out or in as far as the clock had got when the demo started.
   **Check out** a flight that is still booked (enter Hobbs/tach), then **check it
   in** to close the ticket and see derived flight time. Try to **check out** the
   **Cirrus** to hit the **grounded** block; **check out** the **Archer** as the
   student to hit the **eligibility** refusal (and as the CFI to pass). **Drag** a
   block to reschedule. Open **Gate settings** to see the eligibility + twilight
   controls.
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
  Part-61/141, or airworthiness ruling).
- Not in this demo: the native mobile app UI (the mobile **API** is built + tested).
  See `CLAUDE.md`.

## Want a persistent (hosted) demo instead?

Provision a real Postgres (Neon/Supabase free tier), run the **human-gated**
migration apply, seed the demo data, and deploy to Vercel — so you can share a live
link. The full step-by-step is in **[`DEPLOY.md`](./DEPLOY.md)**.
