# AeroOps — Zero-Setup Demo

A clickable prototype of the AeroOps scheduling + dispatch surface. It runs the
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

One operator — **Alpha Flight School** (`/o/alpha`). Password for **everyone**: `demo1234`

| Email | Role | What they can do |
|---|---|---|
| `owner@alpha.aero` | owner | **Everything** — best for a full tour |
| `manager@alpha.aero` | manager | Full scheduling + dispatch + settings |
| `dispatch@alpha.aero` | dispatcher | Schedule + dispatch board |
| `cfi@alpha.aero` | instructor | Schedule + dispatch |
| `student@alpha.aero` | student | App access only (the locked-down view) |

Sign in as **`owner@alpha.aero`** for the full walkthrough below.

## What's seeded

- **5 users** (one per role above), each a real credentialed login.
- **4 aircraft** by tail #: `N172SP` (Cessna 172SP), `N152AB` (Cessna 152),
  `N28K` (Piper Archer), `N66RG` (Cirrus SR20) — plus **1 instructor** resource
  (Casey Reed, CFI).
- **Today's flights:** a morning dual already flown (`N172SP`), a solo currently
  **checked out** (`N152AB`), and an afternoon stage-check (`N28K` + instructor).
- **Tomorrow:** a transition lesson on the Cirrus (`N66RG`).
- **A booking policy** on the Cirrus (max 3 h, ≤ 60 days out, ≥ 60 min lead).
- **A weekly recurring series** (Tue/Thu evenings, 8 sessions) on the Archer.
- **Dispatch tickets:** one **closed** (Hobbs/tach recorded, flight time
  derived) and one **open** (aircraft out now).

## 5-minute click-through (as owner)

1. **Dashboard** (`/o/alpha`) — the operator overview after login.
2. **Schedule** (sidebar → *Schedule*) — today's reservations across all
   aircraft + the instructor. Use the date arrows to move between days; the
   recurring lessons show up on future Tue/Thu.
3. **New reservation** (*Schedule → New*) — pick an aircraft + time. Overlap an
   existing booking to watch **conflict detection** refuse it; try a > 3 h or
   < 1 h-lead booking on the **Cirrus** to watch the **booking policy** refuse it.
4. **Dispatch board** (*Schedule → Board*) — the day's aircraft as rows.
   `N152AB` shows **checked out**; **check it in** (enter Hobbs/tach) to close
   the ticket and see derived flight time. **Check out** another aircraft, or
   **drag** a block to reschedule it.
5. **Resources** (*Schedule → Resources*) — the fleet + instructor; open the
   Cirrus's **booking rules** to see the policy that gated step 3.
6. **Roles** — sign out and back in as `student@alpha.aero` to see the
   capability-gated, locked-down view.

## How it works (and what it is *not*)

- `pnpm demo` (→ `scripts/demo.mjs`) sets `AEROOPS_DEMO=1` and starts `next dev`.
- In demo mode, the app's single DB accessor (`getDb()` in `packages/api`)
  returns an in-memory PGlite client instead of connecting to Postgres. It
  applies the **real, human-gated migrations** (`0000`–`0005`) and seeds through
  the **real write paths** (the same `createReservation` / `openDispatch` /
  … code the app uses), then drops to the non-superuser `aeroops_app` role so
  **row-level-security tenant isolation is enforced**, exactly as in production.
- **Everything is in memory.** State resets every time you restart `pnpm demo` —
  click freely. No real database is ever touched and **no migration is ever
  applied to one**. The production path (`createProdClient` + `DATABASE_URL`) is
  completely unchanged and never runs here.
- Out of scope for the demo (not yet built): payments/billing, the mobile app,
  squawks/grounding, and the optimizer — see `CHANGELOG.md`.

## Want a persistent (hosted) demo instead?

Provision a real Postgres (Neon/Supabase free tier or Postgres.app), set
`DATABASE_URL` + `AUTH_SECRET`, run the **human-gated** migration apply, seed,
and `pnpm dev`. See `DEPLOY.md`.
