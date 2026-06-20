# Slice AV1 — Resource availability windows + additive availability gate — build spec

**Additive frozen-gate dimension (mirrors grounding ADR-0008 + twilight 4a). Migration 0014 human-gated. Operator
scheduling data — NOT an FAA duty/rest/Part-117 determination ([VERIFY-AV1-*]). Sub-slice AV1.1 schema+core gate →
AV1.2 api integration → AV1.3 web.** LOCKED decisions (founder-away; architect's 10 adopted):
1 time=integer minutes-since-midnight; 2 forbid wrap — overnight = TWO rows (end>start), UI auto-splits; 3 reuse
`dispatch_config` for the flags; 4 precedence `conflict_and_policy > policy > conflict > twilight > availability > INSERT`
(availability evaluated LAST, AFTER twilight); 5 API pre-resolves weekly windows → UTC `[open,close)`, core does pure UTC
containment (twilight `events` parallel); 6 CRUD cap = `schedule:manage_resources`; 7 config-flag cap =
`dispatch:manage_requirements`; 8 natural-key UNIQUE, NO EXCLUDE (overlaps allowed, gate unions them); 9 auto-scheduler =
block-mode-only planning intersection (mirror buildTwilightBoundaries); 10 DST: nonexistent open snaps FORWARD / close to
gap-start, ambiguous → earlier instant (property-tested).

## INERT default (critical): availability_constraint_enabled=false OR a resource with zero windows → byte-identical create
path (the frozen arms + twilight arm unchanged). Existing demo data unaffected.

## AV1.1 — Schema (packages/db, migration 0014) + pure core gate (packages/core)
**Table `resource_availability_window`** (new schema file; mirror dispatch-requirement/resource-blackout byte-pattern;
add/remove-only, NO updated_at): id uuid PK; org_id NOT NULL (FK→org CASCADE + Drizzle ref); resource_id NOT NULL (composite
FK `(resource_id,org_id)→resource RESTRICT`, no .references); day_of_week int (CHECK 1–7); start_minute int (CHECK 0–1439);
end_minute int (CHECK 1–1440 AND end_minute > start_minute — forbids wrap); tz text NOT NULL (IANA); created_by (composite FK
RESTRICT); created_at defaultNow(). UNIQUE(id,org_id) + natural-key UNIQUE(resource_id,day_of_week,start_minute,end_minute);
index (org_id,resource_id). ENABLE+FORCE RLS + 4 fail-closed policies + grant. **dispatch_config**: ALTER ADD
`availability_constraint_enabled` bool NOT NULL DEFAULT false + `availability_mode` text NOT NULL DEFAULT 'warn' (CHECK in
block/warn). Migration 0014 + .down (human-gated banner, prereq 0000–0013, strictly additive — only ALTERs dispatch_config +
the new table). Add 0014 to all db test MIGRATION_SQL arrays. Schema tests: RLS isolation + composite-FK cross-org + each
CHECK (dow range, minute ranges, end>start) + UNIQUEs + the 2 config columns + down.
**Pure gate `evaluateAvailabilityGate` in `@aeroops/core`** (mirror `evaluateTwilightGate`; DISTINCT type names —
`ResourceAvailabilityWindow`/`AvailabilityHit` to avoid colliding with the auto-scheduler's existing core `AvailabilityWindow`):
input = a candidate `{startUtcMs,endUtcMs}` + the resource's resolved UTC `[openUtcMs,closeUtcMs)` windows for the candidate's
span (API pre-resolves DST per decision 10) + mode; output `ok` | `{kind:'warn',hits}` | `{kind:'block',hits}`. INERT when
windows null/empty → ok. A booking must be FULLY CONTAINED in the UNION of windows; else warn/block per mode; strict half-open.
**Property tests (HARD requirement, 10 invariants):** INERT-no-windows (always ok); fully-within→ok; outside/partial→warn or
block per mode (mutually exclusive); union-of-overlapping-windows; half-open boundary (exact open included, exact close
excluded); DST spring-forward (gap) + fall-back (ambiguous) correctness; multi-window same day; pure/deterministic/total.

## AV1.2 — API integration (packages/api)
`loadAvailabilityContext` (reads the resource's windows + the org config inside the tx, RLS-scoped; pre-resolves each weekly
window to UTC `[open,close)` for the candidate's date span using the injected tz resolver — decision 10 DST handling) +
`runAvailabilityGate`. ADDITIVE **Step D3** in `gatedCreateOccurrence` AFTER the twilight step: warn → attach
`availabilityWarnings` to the ok:true arm (additive, like twilight); block → a NEW `{ok:false, reason:'availability', availability}`
arm evaluated LAST (after conflict/policy/grounding/twilight). FROZEN arms + twilight arm BYTE-IDENTICAL; INERT when
disabled/no-windows. createSeries/reschedule/auto-schedule inherit it. CRUD: `listAvailabilityWindows`/`createAvailabilityWindow`/
`deleteAvailabilityWindow` (cap `schedule:manage_resources`; validate resource visible/active; dow/minute/tz validation →
ValidationError; 23505→duplicate). Extend `updateDispatchConfig` with the 2 availability fields (cap
`dispatch:manage_requirements`, the no-op guard + audit incl. the new fields). `previewAvailability(session,{resourceIds,start,end})`
(advisory, enabled-flag-independent, cap `schedule:create_reservation`, read-only). Auto-scheduler: block-mode-only planning
intersection (mirror buildTwilightBoundaries). types.ts result-arm additions. Tests: **byte-equivalence when inert**
(gatedCreateOccurrence unchanged), precedence ordering (a booking violating conflict AND availability → conflict wins;
twilight-block + availability → twilight is earlier in chain... actually availability LAST so a twilight-block returns twilight),
the warn/block arms, all 4 write paths inherit, T-ISO, CRUD/config/preview, overnight two-row, multi-resource (one resource
outside its window → block), DST.

## AV1.3 — Web (apps/web)
Availability editor on Fleet detail (add/remove weekly windows per resource, auto-split overnight); board Gate Settings toggle
(enable + warn/block mode, with the [VERIFY-AV1] disclaimer); new-reservation "outside operating hours" indicator (via
previewAvailability, like the twilight day/night indicator). States loading/empty/populated/error/permission-denied. Match
design system; apps/web imports @aeroops/api only; Dates serialized.

## Compliance [VERIFY-AV1-A..D]: availability windows = OPERATOR scheduling/operating-hours data, NOT an FAA duty-time/rest/
Part-117/flight-time-limit or currency determination; the disclaimer (verbatim, compliance-supplied) says so; no money; no
duty-time schema (no pilot duty/rest tracking — just resource operating hours). Route to compliance-officer.
