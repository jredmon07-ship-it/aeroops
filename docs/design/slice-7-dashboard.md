# Slice 7 — Reporting / Ops Dashboard — screen spec (product-designer)

Route: `/o/[slug]` (REPLACES the Phase-0 placeholder `(shell)/page.tsx`). The first screen
after login + the demo's hero landing. Must read as a premium ops console, not a card grid.
Build with the existing shadcn primitives (Card/Badge/Alert/Skeleton/Separator/Button) + the
shipped design tokens (`brand`/`brand-ink`/`danger`, `.nums`, `.hairline`, hairline `shadow-xs`,
tight radii). Never hardcode color.

## LOAD-BEARING IDEA — two-tier grammar (range vs. snapshot)
The 7 metrics answer two different questions and MUST look different so a grounded count is
never misread as a 30-day figure:
- **Snapshot ("As of now"):** grounded, open squawks, active aircraft, active members →
  rendered as ONE white panel subdivided by hairline `divide-x` (an instrument cluster).
- **Range ("Last N days"):** flights, flight hours, reservations → SEPARATE cards in a
  `grid-cols-3 gap-3`. "One panel = now. Three cards = over time."

## Layout (top → bottom, inside the existing shell `max-w-screen-xl` main)
- **A. Heading row** — `<h1>` = org name (`tracking-tightish`), subline "Operations overview";
  right-aligned **range selector** (server-driven `?range=` links 7/30/90, default 30; active =
  `bg-brand-ink text-white`, `aria-current="page"`; `<nav aria-label="Report range">`). A is
  OUTSIDE Suspense (always interactive/instant).
- **B. Snapshot strip** — label "As of now" (`text-[0.625rem] uppercase tracking-[0.1em]
  text-slate-400`); one `rounded-md border bg-white shadow-xs divide-x` panel of 4 tiles. Tile =
  label (`text-[0.6875rem] uppercase`) + big `.nums` value (`text-2xl font-bold`) + sublabel.
  Grounded >0 → value `text-danger`, sublabel "aircraft — see fleet"; =0 → `text-slate-400`
  "none operator-grounded". Open squawks >0 → `text-amber-700` "open"; =0 → `text-slate-400`
  "all clear". Active aircraft/members =0 → `text-slate-400` "none yet". Tiles are NOT links.
  Mobile: 2×2 grid.
- **C. KPI row** — label "Last {rangeLabel}"; `grid-cols-3 gap-3` of cards. Card = label + big
  `.nums` value (`text-3xl font-bold`) + unit sublabel + a reserved empty 16px `aria-hidden`
  trend slot (future sparkline, prevents reflow). Flights / Flight hours (`toFixed(1)`, "utilization
  hrs") / Reservations. Zero → value `text-slate-300` (faded, NOT blank/—) + unit "no … in period".
  If org has data but window empty → subline "No completed flights in the selected period." Mobile:
  `grid-cols-1`.
- **D. Utilization table (centerpiece)** — label "Fleet utilization — last {rangeLabel}";
  `rounded-md border bg-white shadow-xs overflow-hidden`. Columns: Tail # (link to `/fleet/[id]`,
  `font-bold .nums`), Flights (`.nums`), Hours (`.nums` right-aligned, `toFixed(1)` + "h"),
  **Utilization proportion bar**, Status (hidden on mobile). Proportion bar: `w-24 h-1.5
  rounded-full bg-slate-100` track + `bg-brand` fill, `width = (flightHours/maxHours)*100`
  (clamp; if maxHours=0 → 0%), **`aria-hidden="true"`** (the numeric Hours cell is the accessible
  truth — do NOT add role=progressbar). Order hours DESC, tail ASC (workhorses on top, sat tails
  at 0.0 bottom). Status cell reuses fleet-table's GroundedChip + squawk chip (links to
  `/maintenance/squawks?resourceId=`); none → `—`. Empty fleet → `colspan` row "No active
  aircraft" + link to Resources admin. All-zero fleet → bars render empty (visible track). Footnote
  (mandatory copy, `text-[0.6875rem] text-slate-400`): "* Utilization hours derived from recorded
  Hobbs at check-in. Operational figure only — not a billing or airworthiness statement."
- **E. At-a-glance** — label "On the board"; `grid-cols-1 sm:grid-cols-3 gap-3` of 3 cards, each a
  `hairline` header (title + deep-link) + scrollable body (`max-h-52 overflow-y-auto`):
  1. **Today's flights** (from `listReservations` today window; row = start time `.nums` + tail +
     pilot truncated; header link → schedule; use UTC-day fallback + label per [VERIFY-7-TZ]).
  2. **Grounded** (from `listAircraft` filtered `grounded`; row = tail link → `/fleet/[id]` + reason
     truncated / "No reason given"; header gets a `bg-danger` pip if count>0; link → fleet).
  3. **Open squawks** (from `listSquawks({status:'open',limit:10})`; row = title + tail + severity
     chip; header amber pip if >0; rows link → `/maintenance/squawks?resourceId=`; link → maintenance).
  Each empty state: centered `text-xs text-slate-400` ("No flights today." / "No aircraft grounded."
  / "No open squawks.").

## States (B+C+D+E wrapped in ONE Suspense boundary; A outside it)
- **Loading:** `DashboardSkeleton` mirroring the exact populated layout (no layout shift);
  `aria-busy` + `aria-label="Loading dashboard"`.
- **Populated:** as above.
- **Empty brand-new org** (0 aircraft + 0 members): snapshot tiles show "0" (legible, not faded);
  KPI cards faded 0 + "no … yet"; table empty-fleet row; lists empty copy; PLUS a one-time nudge
  strip under D (`border-brand/20 bg-brand/5`): "Getting started — Add aircraft in Resources, then
  add members in People to start dispatching." (shown only when activeAircraft=0 AND activeMembers=0).
- **Range-with-no-data:** snapshots unaffected (not range-filtered); range cards faded 0 +
  "No completed flights in the selected window. Try a wider range."; table shows all tails at 0/0.
- **Error:** destructive `Alert` + Retry link preserving `?range=`, replacing B–E; A stays.
- **Permission-denied (no `reporting:access`):** NO redirect (Dashboard is `app:access`). Use
  `hasCapability(session,'reporting:access')`; if false render heading A + a tasteful panel
  "Reporting isn't available for your role. / Contact your administrator if you need access." in
  place of B–E. (May hide the range selector when denied.)

## A11y
Native `<a>` for range (navigates) with `aria-current`; section `aria-label`s ("Operational
snapshot", "Throughput — last {rangeLabel}", utilization table `aria-label`, "Today's operations");
`<h1>` = org name; proportion bar `aria-hidden` (numeric Hours is the truth); KPI/snapshot values
AAA contrast; danger/amber counts AA; brand links reinforce with `hover:text-brand-ink` + the
global focus ring.

## Why it reads premium (not generic)
Hairline-divided snapshot panel (instrument cluster) vs. gap-separated KPI cards (the two-tier
grammar); `.nums` monospaced tabular numerals at large sizes (cockpit gauges, and they align in the
table); brand-ink active state threads the range selector to the command rail; faded-`0` zero-states
read as "checked, nothing to report" not "broken"; proportion bars make hours scannable in one pass;
read-only, one obvious affordance (the grounded deep-link). No new component libraries.

## Build target
Replace `apps/web/app/o/[slug]/(shell)/page.tsx`. Reuse `fleet/_components/fleet-table.tsx` chips
(copy or extract). Backend (Slice 7.1): `getOrgDashboardMetrics`, `getAircraftUtilization`; lists via
`listReservations`/`listAircraft`/`listSquawks`. Read `docs/specs/slice-7-reporting.md` for the API
contract + the [VERIFY-A]/[VERIFY-7-TZ] copy.
