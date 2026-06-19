# Slice 7 — Reporting / utilization dashboard (build spec)

## Conductor decisions (2026-06-19) — RESOLVED, builders may proceed

- **D1 — New `packages/api/src/reporting/` module.** Leave `dashboard/get-dashboard-summary.ts`
  and all its consumers byte-untouched. New metrics functions live beside it.
- **D2 — REPLACE the content of `apps/web/app/o/[slug]/(shell)/page.tsx`** (still the Phase-0
  placeholder). Dashboard nav stays `/o/[slug]` gated `app:access`; the metrics SECTION is
  independently gated by `reporting:access` — a role without it still gets the landing, minus metrics.
- **D3 — New capability `reporting:access`** → owner, manager, dispatcher, cfi, accountant. NOT
  mechanic/renter/student. (accountant gets it — utilization is the closest pre-Phase-2 thing to
  their domain and carries zero money.)
- **D4 — NO property tests.** Aggregation is I/O; the only pure helper `resolveRange(key, now)`
  gets ordinary unit tests.
- **D5 — Hours = OPERATIONAL utilization, never billable/airworthiness.** UI labels all hours as
  utilization with the 3a `[VERIFY-A]` footnote.
- **E5/[VERIFY-7-TZ] — Range = rolling `[now-Nd, now)` in UTC** (tz-neutral); the "today's flights"
  at-a-glance list is tz-sensitive → reuse the board's existing "today" tz handling, UTC-day
  fallback with an explicit label is acceptable for the demo.
- **NO schema change, NO migration 0009, NO money** (no rate/price/balance/dollar anywhere).

Sub-slices: **7.1 backend → 7.2 web**.

## 1. Data model
**NO schema change.** Read-only aggregation over existing tables (all already org_id + ENABLE/FORCE RLS). Only additive artifact: `reporting:access` in core capabilities (TS, not DB). **Range-scoped** metrics: flights, hours, reservations, per-tail utilization. **Point-in-time snapshots** (NOT range-filtered): open squawks, grounded count, active-aircraft count, active-member count — UI must label these "now", not "in the last N days".

## 2. API (`packages/api/src/reporting/`) — both `fn` + `fnWithDb`, authz FIRST, `withSessionOrgContextWithDb`, org_id from session only, one parameterized query per metric (independently org-auditable), no N+1. Barrel-export from index.ts.

- **`getOrgDashboardMetrics(session, { range })` → `OrgDashboardMetrics`** (authz `reporting:access`). `range: '7d'|'30d'|'90d'` (default '30d', Zod; bad → ValidationError). `resolveRange(range, now)` → `{from,to}`. Output: `{ range:{key,from,to}, totalFlights, totalFlightHours(1dp,0 when none), reservationsInRange, openSquawkCount, groundedAircraftCount, activeAircraftCount, activeMemberCount }`. Queries: flights+hours `COUNT(*)::int, COALESCE(SUM(flight_time_hours),0) FROM dispatch_ticket WHERE status='closed' AND closed_at>=from AND closed_at<to` (voided/open excluded); reservations `COUNT(*) WHERE start_at<to AND end_at>from AND status<>'cancelled'`; open squawks `COUNT(*) WHERE status='open'`; active aircraft `COUNT(*) FROM resource WHERE kind='aircraft' AND active`; grounded via `loadGroundingProbe(tx, activeAircraftIds)` count grounded; active members `COUNT(*) FROM app_user WHERE status='active'`. Throws Unauthenticated/Forbidden/Validation; no refusal unions.
- **`getAircraftUtilization(session, { range })` → `AircraftUtilizationRow[]`** (authz `reporting:access`). `{ resourceId, tailNumber, flightCount, flightHours(1dp) }` ordered hours DESC, tail ASC. ONE query: `resource r LEFT JOIN dispatch_ticket d ON d.resource_id=r.id AND d.status='closed' AND d.closed_at>=from AND d.closed_at<to WHERE r.kind='aircraft' AND r.active GROUP BY r.id, r.tail_number`. LEFT JOIN so zero-flight active aircraft appear (0/0). **Org scope = RLS on BOTH tables** (no d.org_id=r.org_id needed; cross-org ticket invisible to the scoped session — the subtlest spot; test it).
- **At-a-glance lists (7.2): REUSE existing reads** — today's flights via `listReservations` (today window), currently-grounded via `listAircraft` filtered `grounded`, open squawks via `listSquawks({status:'open',limit:10})`. No new list endpoints.

New cap in `capabilities.ts` (alphabetical, keep `satisfies` exhaustive + update test): `reporting:access` per D3.

## 3. Web (7.2 — replace `(shell)/page.tsx` content)
RSC at `/o/[slug]`; heading → range selector (searchParam `?range=`, validate→fallback 30d, RSC re-fetch) → 7 metric cards → utilization table → 3 at-a-glance lists. Design system (architectural corners, brand tokens, `.nums` on EVERY number/hour, Suspense skeleton like fleet). States: loading skeleton / populated / empty-brand-new-org (cards show 0, table empty-state link to Resources, lists "No …") / range-no-data (range metrics 0, snapshots live, "No flights in last N days") / error (destructive Alert + Retry, scoped to metrics section) / permission-denied (no redirect — render landing heading + "Reporting not available for your role" in place of metrics). Utilization table: Tail# bold, Flights, Hours(1dp), proportion bar (width=hours/maxHours, decorative). Hours footnote (shipped copy): "* Utilization hours derived from recorded Hobbs at check-in. Operational figure only — not a billing or airworthiness statement."

## 4. Edge cases
**Tenant isolation on EVERY aggregate is THE risk** (SUM/COUNT/GROUP BY/LEFT-JOIN drop org scope easily) — every query in `withSessionOrgContextWithDb`, org_id never from input, the utilization LEFT JOIN relies on RLS scoping both tables. Zero-aircraft/zero-flight/zero-member org → 0 (COALESCE), never null/NaN/throw, utilization []. Range with no closed tickets → SUM NULL → COALESCE 0. Voided + open excluded from flights/hours (status='closed' only) — test closed+voided+open same tail → count 1. Half-open `closed_at>=from AND <to`. Inactive aircraft excluded from utilization (active-only). Pure reads — no write races, eventually-consistent ok. NO money/rate/price anywhere (reviewer greps the diff).

## 5. Tests (all backend via *WithDb + pglite, TWO seeded orgs A & B with overlapping-looking data)
**getOrgDashboardMetrics:** happy (hand-computed); **per-metric isolation T-ISO-{FLIGHTS,HOURS,RESV,SQUAWK,GROUNDED,AC,MEMBERS}** (org B has MORE of each → org-A session counts ONLY org A — the load-bearing suite); empty org → zeros no-NaN; range-filter (in/out window across all 3 keys); voided-excluded; default 30d; invalid range → ValidationError; authz (null→Unauth; renter/mechanic/student→Forbidden; owner/manager/dispatcher/cfi/accountant→ok). **getAircraftUtilization:** happy (order + sums); T-ISO-UTIL (org-B high-util tails NOT seen — the LEFT-JOIN cross-org assertion); zero-flight active tail → 0/0; voided/open excluded; inactive excluded; empty → []. **resolveRange** unit (each key → `[now-Nd, now)`, to exclusive, deterministic w/ injected now). **Capability** exhaustiveness + reporting:access granted to {owner,manager,dispatcher,cfi,accountant} denied {mechanic,renter,student}. **Web** state tests mirror fleet (loading/populated/empty/no-data-range/error/permission-denied/range-selector).

## 6. [VERIFY] (compliance — light, carry-forward)
- **[VERIFY-A] (carry-forward):** summed Hobbs-derived `flight_time_hours` shown as OPERATIONAL utilization, NOT billable/logbook-authoritative/airworthiness. Confirm the §3 footnote suffices.
- **[VERIFY-7-TZ] (narrow):** "today's flights" calendar-day is tz-sensitive; UTC-day fallback with label acceptable for demo (rolling-window metrics are tz-neutral and unaffected).

## 7. Invariants
org_id from session only; RLS backstop on every aggregate (no exception for "just a count"); read-only (writes nothing); NO money/card/dollar; additive-only (getDashboardSummary + frozen engines + existing reads untouched; new module + new cap only); NO new migration.
