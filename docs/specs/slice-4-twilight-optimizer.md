# Slice 4 — Civil-twilight constraints + intelligent auto-scheduler (build spec)

## Conductor decisions (2026-06-19) — RESOLVED, builders may proceed
- **Both sub-slices ADDITIVE.** Twilight is a new pure gate layered in `gatedCreateOccurrence` like
  grounding (ADR-0008); the optimizer is a pure PROPOSER routed through the FROZEN
  `gatedCreateOccurrence` — NO new write path, NO modification/bypass of conflict (ADR-0004) /
  policy (ADR-0005) / recurrence (ADR-0006). STOP-and-ask if a ticket drifts toward editing those.
- **Civil twilight = ASTRONOMY/operator-config, NOT an FAA night-currency/§61.57/§1.1 determination**
  ([VERIFY-4a-A], hard line). The `-6°` civil / `-0.833°` sunrise-sunset constants are standard astronomy.
- **"Night-qualified" exemption = FREE-TEXT operator tag** (reuse 3c). **Exemption wiring DEFERRED in
  4a**: ship the `twilight_exempt_tag` config column as a seam, but evaluate `pilotIsExempt=false`
  always (the reservation has no first-class "pilot" field — do NOT invent one). Document the seam.
- **Daylight anchor = the aircraft's `home_base_location_id` coordinates** ([VERIFY-4a-C], documented
  approximation). No coords / no home base → gate INERT for that resource (`events=null`).
- **Local civil day = solar-noon-anchored from longitude** (no tz column added to location in 4a).
- **Twilight config lives on `dispatch_config`** (extend, don't add a table). Defaults
  `enabled=false`, `mode='warn'` → 4a ships INERT; turning it on is a deliberate operator act.
- **Auth:** twilight config edits → `dispatch:manage_requirements`; location lat/long edits →
  `fleet:manage`; preview/auto-schedule commit → `schedule:create_reservation`. Mint NO new cap.
- **4b:** ship the audited `schedule_optimization_run` run-header table (migration 0011). Each
  committed reservation's audit row carries `metadata.optimizationRunId`.
- Migrations: **0010** (4a: location lat/long + dispatch_config twilight fields), **0011** (4b: run
  header). Both staged + HUMAN-GATED, NEVER applied (demo applies in-memory).
- Pure decision logic (`computeSolarEvents`, `evaluateTwilightGate`, `proposeSchedule`) gets
  PROPERTY tests (hard guardrail). NO money anywhere.

Sub-slices: **4a civil-twilight → 4b auto-scheduler**. Build 4a fully first (4b depends on 4a's twilight boundaries).

## SLICE 4a — Civil-twilight

### 4a.1 Data model (migration 0010, human-gated)
- `location` (`location.ts`): add `latitude numeric(8,5) NULL`, `longitude numeric(8,5) NULL`. CHECKs:
  `civil_twilight_lat_range_check (lat NULL OR BETWEEN -90 AND 90)`, `..._lon_range_check (lon NULL OR
  BETWEEN -180 AND 180)`, `civil_twilight_latlon_paired_check ((latitude IS NULL) = (longitude IS NULL))`.
  No new index. (location already RLS ENABLE+FORCE — columns inherit.)
- `dispatch_config` (`dispatch-config.ts`): add `twilight_constraint_enabled boolean NOT NULL DEFAULT
  false`, `twilight_mode text NOT NULL DEFAULT 'warn'` (CHECK `IN ('block','warn')`), `twilight_exempt_tag
  text NULL` (CHECK `NULL OR char_length(btrim())>0`). Absent row → `{enabled:false, mode:'warn',
  exemptTag:null}`.
- Regression gate: location/dispatch-config schema tests, fleet tests, ALL scheduling tests (create path
  byte-identical when twilight disabled — the Phase-1 default). Extend `*-schema.test.ts` MIGRATION_SQL to 0010.

### 4a.2 API
**Pure core (property-tested)** `packages/core/src/scheduling/civil-twilight.ts`:
- `computeSolarEvents({latitude, longitude, dateUtcMs}) → SolarEvents { sunriseUtcMs|null, sunsetUtcMs|null,
  civilDawnUtcMs|null, civilDuskUtcMs|null, classification: 'normal'|'polar_day'|'polar_night'|'no_civil_twilight' }`.
  NOAA/Meeus low-precision solar-position closed form; sunrise/sunset at geometric altitude -0.833°, civil
  dawn/dusk at -6°. PURE (no Date.now/random/tz lib; dateUtcMs injected). Local civil day = solar-noon-anchored
  from longitude. Extreme-latitude → null events + classification.
- `evaluateTwilightGate({candidateStartUtcMs, candidateEndUtcMs, events: SolarEvents|null, pilotIsExempt, mode})
  → { blocked: TwilightHit[]; warnings: TwilightHit[] }`, `TwilightHit { reason: 'ends_after_civil_dusk' |
  'starts_before_civil_dawn'; boundaryUtcMs; classification }`. Violation = booking ends after civilDusk OR
  starts before civilDawn (strict `<`/`>`, half-open — ending exactly at dusk does NOT violate). INERT when
  events=null OR classification≠'normal' (NEVER hard-block an undefined boundary — warn at most) OR pilotIsExempt.
  block→blocked, warn→warnings. PURE. Barrel from core.

**Orchestration (additive gate in `gatedCreateOccurrence`)** — model on grounding "Step G" (ADR-0008):
- New `loadTwilightContext(tx, resourceIds, candidateStartUtcMs)` in scheduling internal: loads org
  dispatch_config twilight fields + each aircraft's home-base `location` lat/long (via `home_base_location_id`)
  + (deferred: pilotIsExempt=false), computes `computeSolarEvents` per aircraft, runs `evaluateTwilightGate`.
  RLS-scoped by tx GUC.
- WARN mode (default): evaluate AFTER the refusal-precedence block (Step D), attach optional
  `twilightWarnings?: TwilightHit[]` to the `ok:true` result (additive — existing arms byte-identical, exactly
  like grounding). BLOCK mode: add a NEW standalone refusal arm `{ ok:false, reason:'twilight', twilight:
  TwilightHit[] }` evaluated LAST (precedence `conflict_and_policy > policy > conflict > twilight > INSERT`);
  do NOT combine with conflict/policy (existing four arms stay byte-identical). INERT when disabled/no-coords.
- `CreateReservationResult` additive: ok:true gains `twilightWarnings?`; new `{ok:false, reason:'twilight', twilight}` arm.
- `previewTwilight(session, {startAt, endAt, resourceIds})` (authz `schedule:create_reservation`, read-only, no
  audit) → `{ perResource: [{resourceId, events|null, wouldViolate, classification}] }`. Mirrors previewSeries.

### 4a.3 Web
- Twilight indicator on board + new-reservation form (via previewTwilight): no-coords hint ("set base
  coordinates", link to location admin if `fleet:manage`); normal-day day/night badge ("ends 14 min after civil
  dusk"); extreme-latitude explicit copy ("Polar day: sun does not set" / "No civil twilight on this date" — never
  a silent block); warn → "Book anyway"; block → refused with the dusk/dawn time (like conflict/policy UX).
- Twilight constraint config (on the board "Gate settings" alongside eligibility mode, `dispatch:manage_requirements`):
  enabled toggle + warn/block mode + free-text exempt-tag field. **Block-mode copy MUST carry the disclaimer:**
  "This is an operator scheduling rule based on astronomical civil-twilight times. It is NOT an FAA night-currency
  or §61.57 determination. 'Night-qualified' is a label you assign; the system attaches no regulatory meaning."
- Location lat/long edit on Fleet/location admin (`fleet:manage`).

### 4a.4 Edge cases
Polar/|lat|≥66.5° → null events + classification, inert. Equator/equinox ~12h sanity. DST irrelevant (UTC calc).
±180 longitude / date boundary → solar-noon-anchored local day. No coords/home base/config → inert, byte-identical
create. Tenant isolation (coords+config RLS-scoped). Rounding: exact-ms for gate comparison, round-to-minute for
display; strict half-open so a boundary booking never flips ambiguously. No new concurrency (pure fn, no write).

### 4a.5 [VERIFY] (compliance)
[VERIFY-4a-A] astronomy not FAA night/§61.57/§1.1 — confirm copy/framing. [VERIFY-4a-B] -6°/-0.833° standard
constants. [VERIFY-4a-C] home-base coords as the daylight anchor (documented approximation). [VERIFY-4a-D]
night-qualified = free-text tag, exemption wiring DEFERRED (no computed currency).

### 4a Tests
PROPERTY: computeSolarEvents vs known USNO/NOAA sunrise/sunset/civil values (≤1–2 min tol; incl. southern hemisphere,
equator@equinox, solstice); extreme-latitude classification + null events; purity/determinism. evaluateTwilightGate
invariants (mutually-exclusive block/warn; exempt→empty; events=null→empty; half-open boundary; classification≠normal
→never blocked). Integration: create byte-identical when disabled/no-coords (existing scheduling tests pass unchanged);
warn attaches warning without changing arm; block returns `{ok:false,reason:'twilight'}` writing nothing; tenant
isolation; migration 0010 shape (cols+CHECKs; paired-presence rejects half-set; down reverts).

## SLICE 4b — Intelligent auto-scheduler (build AFTER 4a)

### 4b.1 Data model (migration 0011, human-gated)
`schedule_optimization_run` (new): id; org_id (RLS ENABLE+FORCE + 4 policies + grant); requested_by (composite FK
RESTRICT); input_jsonb; seed; created_count; skipped_count; created_at; UNIQUE (id, org_id). Audited run header.
Each committed reservation's audit row gets `metadata.optimizationRunId`.

### 4b.2 API
**Pure core (property-tested)** `packages/core/src/scheduling/optimizer.ts`: `proposeSchedule({demands:
DemandRequest[], availability: AvailabilityWindow[], twilightBoundaries?, objective:'maximize_utilization'|
'maximize_sessions_scheduled', seed, now}) → { proposals: ProposedOccurrence[], unschedulable: [{demandId,
reason:'no_feasible_window'|'over_constrained'}] }`. `DemandRequest {id, requiredResourceIds[], durationMinutes,
earliestStartUtcMs?, latestEndUtcMs?, priority?}`. **Deterministic greedy + bounded backtracking** (sort by
priority desc, duration desc, demandId asc; earliest feasible non-overlapping placement; bounded backtrack + hard
placement cap → termination). PURE (injected seed+now). ADVISORY — proposes a self-consistent set (no two emitted
proposals share a resource-overlap, half-open); NOT the authoritative gate.
**Orchestrator** `packages/api/src/scheduling/auto-schedule.ts` `runAutoSchedule(session, input)` — structurally
identical to `createSeries`: authz `schedule:create_reservation` FIRST; capture now+seed once; build availability
(RLS-scoped existing bookings/blackouts/grounding subtracted from business hours) + twilightBoundaries (4a); call
proposeSchedule; ONE outer tx, per-proposal SAVEPOINT, each proposal → `gatedCreateOccurrence` (SINGLE write path,
reuse the OccurrenceRaceError→ROLLBACK-TO-SAVEPOINT→re-probe loop); refused proposal → skipped+reason; commit
accepted atomically. Audit run-header + per-reservation `metadata.optimizationRunId`. Result: `{ok:true, runId,
proposals:[{demandId,startAt,endAt,resourceIds,result:'created'|'skipped',reservationId?,reason?,conflicts?,
violations?}], unschedulable, createdCount, skippedCount}`. `previewAutoSchedule` (read-only probe, no INSERT/audit,
same authz) mirrors previewSeries.

### 4b.3 Web
Auto-scheduler input (Scheduling Hub): demand builder → previewAutoSchedule → board preview (would_create count +
would_skip reasons + unschedulable list) → **Commit** (single deliberate action, never auto-commits) → created/skipped
summary; staff hand-off to drag-drop board adjustment.

### 4b.4 Edge cases / 4b.5 [VERIFY]
No feasible solution → ok:true all-unschedulable (not an error). Refusal AT COMMIT (reality drifted / race) → skipped
+reason, rest commits. Concurrency → EXCLUDE 23P01 → skip (reuse series race). Determinism (input+seed→identical).
Tenant isolation. NO money (schedules time, never prices). Optimizer never proposes a conflicting pair (property +
EXCLUDE backstop). [VERIFY-4b-A] no regulatory determination in the demand model; [VERIFY-4b-B] every proposal routes
through FROZEN gatedCreateOccurrence, no bespoke INSERT.

### 4b Tests (PROPERTY): never-conflicting-pair; respects availability+twilight+bounds; determinism; total accounting
(every demand proposed or unschedulable); termination. Integration: every proposal commits via gatedCreateOccurrence
(no bespoke INSERT); refused-at-commit → skip+rest-commit; concurrent race → skip no-double-book; previewAutoSchedule
writes nothing + agrees with commit; authz; tenant isolation; no-feasible → ok:true.

## Invariants (both)
org_id from session only + RLS on every new column/table; every created reservation audited + optimizer run audited;
NO money; FROZEN engines untouched (additive only — STOP if a ticket drifts to editing them or a 2nd write path);
pure logic property-tested; civil twilight = astronomy+operator-config, night-qualified = free-text (no computed
currency); migrations 0010/0011 staged + human-gated, NEVER applied.
