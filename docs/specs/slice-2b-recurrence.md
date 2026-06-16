# BUILD SPEC — Slice 2b: Recurring Reservations (SCHED-2b)

**Status:** Approved-pending. Implements ADR-0006. Builds on ADR-0004 (FROZEN conflict engine) + ADR-0005 (FROZEN policy gate). All decisions in ADR-0006 §"Resolved decisions" are BINDING here.

**Scope:** weekly recurrence (by weekday[s], interval, count XOR until, ≤52 cap), each occurrence a `reservation` row linked to a `reservation_series`, `createSeries`/`cancelSeries` reusing the single-create gated logic per occurrence (savepoints), and a "Repeat" UI. **OUT (STOP+ask):** series edit, drag-drop, dispatch, optimizer, civil-twilight, monthly/yearly/RRULE, overnight occurrences.

## 0. Invariants (builders hold)
1. `reservation_series` carries `org_id` + ENABLE+FORCE RLS + 4 fail-closed policies + `aeroops_app` grant + composite FKs (byte-pattern of 0002/0003). `apps/web` imports only `@aeroops/api`.
2. **One write path, reused not forked:** each occurrence commits via the shared `gatedCreateOccurrence` extracted from single-create. No hand-assembled occurrence INSERT. EXCLUDE + conflict probe + policy probe + 23P01 catch stay the single definition of bookability.
3. Audited: `series.created`, per-occurrence `reservation.created` (as today), `series.cancelled`. No silent mutation.
4. The frozen single-create result shape + `ConflictHit`/`PolicyViolationView` are reused as-is; all new types additive.
5. Pure core: expansion is I/O-free, clock-free (injected `now`) and tz-lib-free (injected `resolveZoned`). `@aeroops/core` gains NO runtime dep.
6. Half-open `[start,end)` everywhere.
7. No past occurrences created (start < now omitted).

## 1. Data model + migration 0004
### 1.1 `reservation_series` (new — `packages/db/src/schema/reservation-series.ts`)
`id` uuid PK; `org_id` uuid NOT NULL (FK→org CASCADE); `freq` enum `recurrence_freq` ('weekly'); `weekdays` smallint[] NOT NULL (CHECK cardinality 1..7, elements 1..7); `interval_weeks` int NOT NULL DEFAULT 1 (CHECK ≥1); `end_kind` enum `recurrence_end_kind` ('count'|'until'); `count` int (CHECK 1..52); `until_date` date; `local_start_time` time NOT NULL; `duration_minutes` int NOT NULL (CHECK >0); `iana_tz` text NOT NULL; `resource_ids` uuid[] NOT NULL (CHECK length ≥1); `notes` text; `status` enum `reservation_series_status` ('active'|'cancelled') DEFAULT 'active'; `created_by` uuid NOT NULL (composite FK `(created_by,org_id)→app_user(id,org_id)` RESTRICT); `cancelled_at` timestamptz; `cancelled_by` uuid (composite FK `(cancelled_by,org_id)→app_user(id,org_id)` SET NULL); `created_at`/`updated_at` timestamptz.
Constraints: `UNIQUE (id, org_id)` (candidate key for the reservation FK); `end_shape_check` (count-only XOR until-only). New enums sourced from core tuples `RECURRENCE_FREQS`/`RECURRENCE_END_KINDS`/`RESERVATION_SERIES_STATUSES` (mirror RESOURCE_KINDS). The ≤52 cap for `until` mode is app-enforced (single choke-point).

### 1.2 ALTER `reservation` ADD `series_id`
`series_id uuid NULL`; composite FK `(series_id, org_id) → reservation_series(id, org_id)` **ON DELETE SET NULL** (preserve audited occurrence rows); `CREATE INDEX reservation_series_id_idx ON reservation(series_id)`. Single-create never sets `series_id` (stays NULL → unchanged behavior).

### 1.3 Migration `0004_recurrence.sql` (+ `.down.sql`)
Human-gated banner like 0002/0003 (prereqs 0000–0003). Up: 3 enum types → CREATE `reservation_series` (+constraints) → ALTER `reservation` add col+FK+index → ENABLE+FORCE RLS on `reservation_series` → 4 named RLS policies (same GUC predicate) → grant. btree_gist already present. Down: reverse (drop policies → un-force/disable RLS → revoke → drop index → drop FK+col → drop table → drop 3 enums).

### 1.4 Schema tests (`packages/db/src/__tests__/recurrence-schema.test.ts`)
RLS isolation + fail-closed on `reservation_series`; cross-org `created_by` FK rejection; `reservation.series_id` cross-org composite-FK rejection; `end_shape_check` (both/neither set rejected); `count<=52`/`interval_weeks>=1`/`duration_minutes>0`/`weekdays` cardinality+bounds CHECKs; ON DELETE SET NULL leaves occurrence rows with NULL series_id.

## 2. Core expansion (`packages/core/src/scheduling/recurrence.ts`, pure)
Injected resolver keeps core dep-free:
`type ZonedToUtc = (p:{year,month,day,hour,minute,tz}) => {utcMs:number; status:'valid'|'nonexistent'|'ambiguous'}`.
`expandRecurrence(rule: RecurrenceRule, opts:{now:number; resolveZoned:ZonedToUtc; hardCap?=52}) → { occurrences: Occurrence[]; truncatedByCap:boolean; skippedLocalDates:{date,reason:'nonexistent_local_time'}[] }`. `Occurrence = { localDate, startUtcMs, endUtcMs }`, chronological, ≤cap, all ≥ now. Algorithm: anchor first qualifying week; step `interval_weeks`; per active week emit selected weekdays at `local_start_time`; resolve→UTC; end=start+duration; stop on count|until|cap. Drop start<now (no-past). DST: nonexistent→drop+report; ambiguous→earlier instant; everyday→wall-clock fixed across DST.
**Property tests (`recurrence.test.ts`, hard guardrail):** count-correctness, until-correctness (incl. zero when until<first), weekday-correctness, interval-correctness, cap-enforcement (+truncatedByCap), no-past, **DST-stability** (real DST zone, wall-clock fixed across transition), idempotence/determinism; unit: DST-nonexistent drop+report, DST-ambiguous→earlier.

## 3. API
### 3.0 Refactor (prerequisite): extract `gatedCreateOccurrence`
From `create-reservation.ts`, extract the per-occurrence gated body (resource validation → conflict probe → policy probe → refusal precedence → INSERT reservation+joins+audit → 23P01 catch-and-requery) into `internal.ts` as `gatedCreateOccurrence(tx, sess, db, {startAt,endAt,resourceIds,notes?,seriesId?}, now) → CreateReservationResult`. Runs INSIDE a provided tx/savepoint; does not open its own. `createReservation` becomes a thin wrapper (own tx, one call). **Acceptance: existing `scheduling.test.ts` + `booking-policy-api.test.ts` pass byte-for-byte unchanged** (proves single-create not forked).

### 3.1 `createSeries(session, input)` / `createSeriesWithDb(db, session, input, opts?)`
authz `schedule:create_reservation` FIRST. Input (Zod, throws ValidationError): `{ weekdays:number[], intervalWeeks:number, end:{kind:'count',count}|{kind:'until',untilDate:'YYYY-MM-DD'}, localStartTime:'HH:MM', durationMinutes, tz, resourceIds:string[], notes? }`. Reject (ValidationError): empty/out-of-range weekdays, interval<1, count<1|>52, duration≤0, unknown IANA tz, malformed time/date, zero resources. Zero future occurrences is NOT an error (clean empty result).
Flow: authz→validate→capture `now` (opts.now in WithDb)→`expandRecurrence`→**open ONE outer `withSessionOrgContext` tx**→INSERT series row (status active) + `series.created` audit→for each occurrence run `gatedCreateOccurrence` inside a **SAVEPOINT** (`tx.transaction`), mapping its `CreateReservationResult` to a report entry; a skip/23P01 rolls back only that savepoint→commit outer tx. (Fallback Option A per-occurrence tx only if savepoints unworkable in harness — report if used.)
Output `CreateSeriesResult = { ok:true; series:{id,orgId,status,...rule}; occurrences: SeriesOccurrenceReport[]; truncatedByCap; skippedLocalDates; createdCount; skippedCount }` where `SeriesOccurrenceReport = { index, startAt:Date, endAt:Date, result:'created'|'skipped', reservationId?, reason?:'conflict'|'policy'|'conflict_and_policy', conflicts?:ConflictHit[], violations?:PolicyViolationView[], dstAdjusted? }`. Always `ok:true` (partial-create normal); auth/validation/cap thrown.

### 3.2 `cancelSeries(session, {seriesId})` (+WithDb)
authz `schedule:create_reservation`. One tx: load series (RLS; not visible→`{ok:false,reason:'not_found'}`); already cancelled→idempotent `{ok:true,cancelledCount:0}`; else set series cancelled (cancelled_at/by), `UPDATE reservation SET status='cancelled',... WHERE series_id=$1 AND status='booked' AND start_at>now()`, flip those join rows to cancelled (frees windows), one audit row per cancelled reservation + one `series.cancelled` (metadata cancelledCount). Output `{ok:true,cancelledCount}|{ok:false,reason:'not_found'}`. Single-occurrence cancel = existing `cancelReservation` (unchanged).

### 3.3 `listSeriesOccurrences(session, {seriesId})` (+WithDb)
authz `schedule:access`. Returns series row + its occurrence `ReservationRow[]` ordered by start_at, RLS-scoped. Backs the series view + cancel confirmation.

### 3.4 Preview (read-only) `previewSeries(session, input)` (+WithDb)
authz `schedule:create_reservation`. Runs `expandRecurrence` + per-occurrence `checkConflicts` (writes nothing) → same report shape with `result:'would_create'|'would_skip'`. Powers the form's live preview in ONE round-trip (server owns tz math).

Barrel-export all + additive types from `packages/api/src/index.ts`. Audit actions: `series.created`, `series.cancelled` (+ existing `reservation.created`/`.cancelled`).

## 4. Web UI (extend, don't fork)
New server actions in `schedule/actions.ts`: `createSeriesAction`, `cancelSeriesAction`, `listSeriesOccurrencesAction`, `previewSeriesAction` (map ForbiddenError/UnauthenticatedError/ValidationError; pass results through).
- **new-reservation form:** a "Repeat" toggle. OFF→existing single-create unchanged. ON→reveal weekday picker (default = start date's weekday), interval, end (count|until), and a **timezone field defaulted from `Intl…resolvedOptions().timeZone`, operator-confirmable**. Primary action "Preview & create series". Debounced `previewSeriesAction` → summary "Will create X of Y (Z skipped)" + per-date badges (would-create/conflict/policy/DST-skip) + cap/DST notices. Submit→`createSeriesAction`→**create-result screen**: created-vs-skipped with reasons (reuse ConflictHit/PolicyViolationView rendering from 2a's conflict-banner). States: empty/preview-loading/preview-populated/submitting/result/validation-error(inline)/server-error/permission-denied(hide Repeat).
- **reservations list:** occurrences with `series_id` show a "repeats" badge linking to the series view.
- **series view** (`schedule/series/[seriesId]/page.tsx`, read gate `schedule:access`): rule summary + status + occurrence list (booked/cancelled/past); states loading/empty/populated/error/permission-denied.
- **cancel-series dialog** (mirror cancel-reservation-dialog): "cancels N future occurrences (past kept)"→`cancelSeriesAction`; success toast cancelledCount; states idle/confirming/submitting/success/error/not_found/permission-denied. Single-occurrence cancel unchanged.

## 5. Edge cases
DST stability (no skip); DST nonexistent (drop+`skippedLocalDates`); until<first (zero occ, clean, series row still created); cap→truncate+flag; fully-conflicting (all skipped, ok:true, series row created); tenant isolation (cross-org resource → thrown ValidationError fails whole request like single-create; series/occurrence RLS+composite-FK scoped); multi-resource occurrence all-or-nothing per occurrence; race → skip via 23P01 catch; self-overlap within a series → later occurrence skipped by EXCLUDE.

## 6. Test list
Core: §2 property suite (hard guardrail). API integration (`recurrence-api.test.ts`, pglite migrations 0000–0004): happy count=4; partial-create skip-report (seed collision/blackout on one occ → that one skipped, others created, counts correct, both-gates→conflict_and_policy); savepoint poison-isolation (skip doesn't roll back committed siblings); zero-future; cap=52; no-past; DST-nonexistent; cancelSeries future-only + freed windows + idempotent + audit; listSeriesOccurrences; tenant isolation; authz matrix; validation thrown; **no-regression (existing scheduling + booking-policy suites unchanged after the §3.0 refactor)**. Schema: §1.4.

## 7. Build order + flags
1. Core enums + `recurrence.ts` + property tests. 2. Schema + migration 0004 + schema tests. 3. API: §3.0 refactor (prove green) → create-series/cancel-series/list/preview + additive types + barrel + integration tests. 4. Web. 5. QA (reviewer invariants §0; compliance).
**[VERIFY] (compliance):** Part-141 — does series-level create/cancel need a retained record beyond per-occurrence audit? (belief: per-occurrence suffices). **Resolved (ADR-0006):** Option B savepoints; series_id SET NULL; per-series tz defaulted on form (no org change); future-only cancel; zero-occ still creates series; dedicated listSeriesOccurrences.
