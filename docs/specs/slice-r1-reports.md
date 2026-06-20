# Slice R1 — Operational Reports deep-dive — build spec

**Reporting hub depth. NO schema/migration (read-only aggregates). NO money. NO computed FAA determination.
Sub-slice R1.1 backend → R1.2 web.** LOCKED decisions (founder-away; architect recommendations adopted):
(1) sub-slice R1.1→R1.2; (2) NEW `getHoursByTail` widened-range fn — do NOT mutate the FROZEN `getAircraftUtilization`;
(3) reservations created-trend INCLUDES cancelled (creation-activity metric, labeled); (4) NO new chart dependency —
CSS/SVG bars; (5) UTC bucketing ([VERIFY-R1-TZ], matches dashboard); (6) NO migration.

## Invariants
org_id ONLY from session; every aggregate inside one `withSessionOrgContextWithDb`; RLS (ENABLE+FORCE) is the only
org filter (NO `org_id = $input` predicate); read-only (zero writes/audit); additive (the 2 existing reporting files +
`resolveRange` are EXTENDED with new exports, behavior byte-unchanged for existing callers); bounded result sizes
(≤~53 buckets); NO money (reviewer greps rate/price/dollar/balance/invoice/Stripe → zero); hours = OPERATIONAL
utilization (Hobbs-derived flight_time_hours), NOT billing/airworthiness.

## R1.1 — Backend (packages/api/src/reporting/*, `*`+`*WithDb`, authz `reporting:access` FIRST, Zod range, then one tx)
Reuse cap `reporting:access` (owner/manager/dispatcher/cfi/accountant) — NO new capability.

**Pure helpers in `reporting/internal.ts` (EXTEND; keep `resolveRange` byte-identical; unit-tested):**
- `ReportRangeKey = '7d'|'30d'|'90d'|'180d'|'365d'`; `BucketGranularity = 'day'|'week'`.
- `resolveReportRange(key, now) → {from,to}` rolling `[now-Nd, now)` UTC.
- `chooseGranularity(key)` → 7d/30d='day'; 90d/180d/365d='week' (bounds buckets ≤~53).
- `bucketStartUtc(d,g)` → floor to UTC midnight (day) / UTC Monday 00:00 (week). ALL UTC.
- `enumerateBuckets(from,to,g) → Date[]` → ordered bucket starts for zero-fill (empty bucket → 0 row, never a gap).
- `safeAvg(num,den)` → 0 when den=0, 1dp (the div-by-zero guard).

**5 reads (each its own tx; R1.2 fetches via Promise.all like DashboardContent; barrel-export from packages/api/src/index.ts):**
1. `getUtilizationTrend({range?}) → {range,granularity,buckets:[{bucketStart,flightCount,flightHours}],totalFlights,totalFlightHours,avgHoursPerFlight}`.
   ONE query: `date_trunc(unit, closed_at AT TIME ZONE 'UTC')` GROUP over `dispatch_ticket WHERE status='closed' AND closed_at>=from AND <to`; COALESCE(SUM(flight_time_hours),0); zero-fill in memory via enumerateBuckets; avg via safeAvg. Voided/open excluded; half-open.
2. `getHoursByTail({range?}) → AircraftUtilizationRow[]` ({resourceId,tailNumber,flightCount,flightHours} hours DESC,tail ASC) — NEW file, IDENTICAL query/isolation to the frozen `getAircraftUtilization` but widened `ReportRangeKey`. active-only; LEFT JOIN resource×dispatch_ticket — **the subtlest T-ISO spot (RLS scopes BOTH tables)**.
3. `getReservationsVsFlightsTrend({range?}) → {…,buckets:[{bucketStart,reservationsCreated,flightsClosed}],totalReservationsCreated,totalFlightsClosed}`. TWO queries (reservation.created_at incl. cancelled; dispatch_ticket closed.closed_at) zero-filled+merged.
4. `getTrainingThroughput({range?}) → {enrollmentsCreatedInRange(enrolled_at), enrollmentsCompletedInRange(status='completed'&status_changed_at), lessonsRecordedInRange(status='recorded'&completed_at, voided excluded), activeEnrollmentCount(snapshot)}`. ≤4 COUNTs. OPERATIONAL — NOT Part-141 graduation ([VERIFY-T1-B]).
5. `getMaintenanceTrend({range?}) → {squawksOpenedInRange(reported_at), squawksResolvedInRange(status='resolved'&resolved_at), workOrdersOpenedInRange(opened_at), workOrdersCompletedInRange(status='completed'&signed_off_at), openSquawkCount(snapshot), groundedAircraftCount(snapshot via loadGroundingProbe over active aircraft ids — reuse dashboard pattern)}`. OPERATIONAL — NOT airworthiness/Part-43 ([VERIFY-M1-A]).
Errors: null→Unauthenticated; missing reporting:access→Forbidden; bad range→ValidationError; reads throw (no refusal unions).

## R1.2 — Web (`(shell)/reporting/reports/`; match design system; NO new dep — CSS/SVG bars + numeric `.nums` truth)
Nav "Reports" (after Maintenance, requiredCapability reporting:access) + nav.test.ts. actions.ts mirrors reporting-actions.ts
(await auth, map Forbidden/Unauthenticated/Validation, serialize Dates→ISO, import @aeroops/api only). Page: heading + a
range selector (?range= links 7d/30d/90d/180d/365d default 30d, aria-current, OUTSIDE Suspense) → sections B utilization-
over-time (stat strip + bucket bar-rows + hours footnote), C hours-by-tail (the utilization-table reused, Tail#→/fleet/[id]),
D reservations-vs-flights (two-series bucket rows), E training throughput (compact stat group + operator-count caption),
F maintenance trend (stat group; grounded>0 → text-danger; caption). States (B–F in ONE Suspense, A outside): loading
skeleton (no layout shift) / populated / empty-org (faded-0 grammar text-slate-300, "checked, nothing to report") /
range-no-data (snapshots live; bucket metrics faded-0 + "try a wider range") / error (destructive Alert+Retry preserving
?range=) / permission-denied (no redirect — shell is app:access; render the dashboard's "Reporting isn't available for your
role" panel; real gate is the API cap). Bars aria-hidden, numeric `.nums` cell is the accessible truth (NO role=progressbar).

## Edge cases / tests (R1.1 via *WithDb + pglite 0000–0013, two orgs A & B; **org B seeded with MORE of every metric**)
Tenant isolation on EVERY aggregate (T-ISO-UTILTREND/HOURSBYTAIL[the LEFT-JOIN]/RESVFLIGHTS/TRAINING/MAINT — org-A session
NEVER counts org-B rows); empty range→zeroes (no NaN/null/throw); range-no-data→buckets 0 + live snapshots; range cap
(enum admits only 5 keys→≤53 buckets); UTC bucketing (date_trunc AT TIME ZONE 'UTC' + UTC enumerateBuckets); zero-flight
active tail→0/0; div-by-zero→safeAvg 0; voided+open dispatch excluded; half-open `>=from AND <to`; cancelled reservations
counted in created-trend (labeled); **accountant (reporting:access-only) gets FULL R1 data on all 5 — fixes the dashboard
fail-closed nit**; mechanic/renter/student denied. Pure-helper unit tests (resolveReportRange/chooseGranularity/
bucketStartUtc inc. a DST wall-clock date/enumerateBuckets/safeAvg). Web state tests + nav.test.ts. NO property tests
(aggregation is I/O — reserved for the frozen pure cores). Keep existing reporting/dashboard tests byte-green.

## Compliance (light, carry-forward)
Every number OPERATIONAL operator data — NO money/billing, NO airworthiness/Part-43/RTS, NO Part-141 graduation/currency,
NO computed FAA determination. Hours footnote verbatim (Slice-7 copy): "Utilization hours derived from recorded Hobbs at
check-in. Operational figure only — not a billing or airworthiness statement." Operator-count captions on training +
maintenance. [VERIFY] carry-forward (no new answer needed before build): [VERIFY-A] hours=operational; [VERIFY-T1-B]
enrollment/lesson counts=operator state; [VERIFY-M1-A] WO/squawk/grounded=operator data; [VERIFY-R1-TZ] UTC bucketing.
