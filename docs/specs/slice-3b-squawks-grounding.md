# Slice 3b — Squawks + operator-set grounding (build spec)

## Conductor decisions (2026-06-18) — RESOLVED, builders may proceed

The architect flagged several decisions for the conductor/founder. Resolved:

- **[DECISION-FREEZE] → Option A (approved).** Additively extend the FROZEN
  `gatedCreateOccurrence` (`packages/api/src/scheduling/internal.ts`) with a
  **warn-only** grounding step + an **optional** `groundingWarnings?: GroundingHit[]`
  field on the `ok:true` arm only. Every pre-existing refusal arm
  (conflict / policy / conflict_and_policy) MUST stay byte-identical — enforced by
  the no-regression suite (§6). Document in **ADR-0008**. This is permitted under
  the ADRs' explicit "additively-extended-only" clause.
- **[VERIFY-3b-G] / [DECISION-FOUNDER] → WARN at create (approved).** The grounding
  gate at reservation-create is **non-blocking (warn)**, hard-coded, with the
  `mode: 'block' | 'warn'` seam in `evaluateGroundingGate` for a future org-settings
  slice. **Do NOT build org-settings infrastructure in 3b.** At `openDispatch`,
  grounding is a **hard block** (new `grounded` refusal arm).
- **[VERIFY-3b-F] → capability matrix (approved as default):**
  - `maintenance:access` → owner, manager, dispatcher, cfi, mechanic
  - `maintenance:ground` → owner, manager, dispatcher, mechanic (**NOT cfi**)
  - `maintenance:squawk` → owner, manager, dispatcher, cfi, mechanic (**NOT renter/student in 3b** — deferred to the portal phase)
- **Scope → build 3b.1 (grounding) + 3b.2 (squawks) together** behind a single
  human-gated migration **0006**. **3b.3 (squawk-on-return at check-in)** is a fast
  follow within the slice if time permits.
- **Compliance [VERIFY-3b-A,B,C,D,E,H]** are routed to the **compliance-officer at
  the /qa gate** (standard DoD). The design posture is deliberately conservative —
  grounding & severity are **operator data only**, squawks never auto-ground, and the
  software makes **no FAR/Part-91/43 airworthiness determination** — so the build
  proceeds and compliance blesses these flags before merge.
- **Migration 0006 stays staged + HUMAN-GATED, NEVER applied to a real DB.** The
  zero-setup demo applies it **in-memory** (the demo bootstrap auto-includes any
  `NNNN_*.sql`), so the feature is clickable without touching a real database.

---

> The full architect analysis follows verbatim. Builders: follow it precisely; where
> it offered options, the Conductor decisions above are binding.

# BUILD SPEC — Slice 3b: Squawks + operator-set grounding

**Builds additively on** ADR-0004 (conflict — FROZEN), ADR-0005 (policy — FROZEN),
ADR-0006 (recurrence/reschedule — FROZEN), ADR-0007 (dispatch records — FROZEN).
This slice modifies none of those engines' behavior; it adds a third gate dimension
and new records tables. New **ADR-0008** documents it.

**Load-bearing finding:** the conflict gate, policy gate, and the reservation INSERT
all live in ONE shared function, `gatedCreateOccurrence`
(`packages/api/src/scheduling/internal.ts:558`), called by `createReservation`,
`createSeries`, AND `rescheduleReservation`. Adding the grounding gate as one additive
step inside that function gates all three create paths at once (Conductor: Option A).

## 0. Scope & sub-slicing

- **3b.1 — Grounding** (the competitive wedge): `aircraft_grounding` event table + RLS
  + migration 0006; `groundAircraft` / `unGroundAircraft` / `getGroundingStatus`; pure
  `evaluateGroundingGate`; gate wired into the shared create path (warn) + `openDispatch`
  (block); grounding badge on board + new-reservation flow + resource picker.
- **3b.2 — Squawks**: `squawk` table (status lifecycle + severity) + RLS (same migration
  0006); `reportSquawk` / `updateSquawkStatus` / `listSquawks` / `getOpenSquawkCounts`;
  squawk list + create + status-transition UI; open-squawk count on the board / picker.
  Squawks are **advisory only** in 3b (they do NOT block).
- **3b.3 — Squawk-on-return at check-in** (fast follow): optional squawk-capture step in
  the check-in dialog that calls `reportSquawk` after `closeDispatch` succeeds.

**Scope guard (STOP + ask):** OUT of 3b = computed airworthiness / Part-91/43 /
91.405 / 91.213 determinations; MEL / deferral-with-airworthiness logic; work orders /
parts / labor (Phase 4); inspection-interval computation; tach interpretation; balance /
Stripe / pricing (Phase 2); currency / medical (Phase 3); the `dispatch_ticket_correction`
table; civil-twilight / optimizer (Slice 4); fuel; mobile. **Grounding is operator data,
never a computed reg verdict.**

**Meter predecessor check ([[dispatch-correction-table-predecessor]]):** 3b does NOT read,
write, or mutate any recorded Hobbs/tach meter. Grounding/squawks reference an aircraft
(`resource_id`) and optionally a dispatch ticket (`dispatch_ticket_id`, FK only — no meter
access). **The correction-table dependency is NOT triggered by 3b.**

## 1. Data-model delta

### 1.1 Core enums (`packages/core/src/maintenance/enums.ts` — new; barrel from core index)
- `GROUNDING_STATES = ['grounded','released'] as const` + `GroundingState` + `isGroundingState`.
- `SQUAWK_STATUSES = ['open','deferred','resolved'] as const` + `SquawkStatus` + `isSquawkStatus`. **[VERIFY-3b-A]:** `deferred` is a plain operator status with a reason, NOT an MEL/airworthiness construct.
- `SQUAWK_SEVERITIES = ['low','medium','high','grounding'] as const` + `SquawkSeverity` + `isSquawkSeverity`. **[VERIFY-3b-B]:** severity is an operator triage label, not a computed airworthiness class. `'grounding'` is a UI hint only — it does NOT auto-ground.
- pgEnums `grounding_state`, `squawk_status`, `squawk_severity` derived FROM these tuples in `packages/db/src/schema/enums.ts` (same SoT pattern as `dispatch_status`), barrelled.

### 1.2 Table `aircraft_grounding` (3b.1) — `packages/db/src/schema/aircraft-grounding.ts`
**Event-sourced, append-only.** Current state = the latest event per aircraft.
- `id` uuid PK `defaultRandom()`.
- `org_id` uuid NOT NULL, FK→org CASCADE (`.references()` + named hand-written FK, mirroring `dispatch_ticket`).
- `resource_id` uuid NOT NULL — the aircraft. NO `.references()`; composite FK `(resource_id, org_id) → resource(id, org_id)` ON DELETE RESTRICT.
- `state` `grounding_state` NOT NULL.
- `reason` text NOT NULL.
- `squawk_id` uuid NULL — composite FK `(squawk_id, org_id) → squawk(id, org_id)` ON DELETE SET NULL.
- `dispatch_ticket_id` uuid NULL — composite FK `(dispatch_ticket_id, org_id) → dispatch_ticket(id, org_id)` ON DELETE SET NULL. **FK only — no meter access.**
- `created_by` uuid NOT NULL — composite FK `(created_by, org_id) → app_user(id, org_id)` ON DELETE RESTRICT.
- `created_at` timestamptz NOT NULL `defaultNow()`. **No `updated_at`** (immutable).

CHECK `aircraft_grounding_reason_check`: `state='grounded' ⇒ char_length(btrim(reason)) > 0`. **[VERIFY-3b-C]:** release-reason optional (audit suffices).

Indexes: `uniqueIndex(id, org_id)`; `index(org_id, resource_id, created_at DESC)` for "latest event per aircraft" (`DISTINCT ON (resource_id) ORDER BY resource_id, created_at DESC, id DESC`).

### 1.3 Table `squawk` (3b.2) — `packages/db/src/schema/squawk.ts`
- `id` uuid PK; `org_id` uuid NOT NULL FK→org CASCADE.
- `resource_id` uuid NOT NULL — composite FK `(resource_id, org_id) → resource(id, org_id)` RESTRICT.
- `dispatch_ticket_id` uuid NULL — composite FK to `dispatch_ticket(id, org_id)` SET NULL. **FK only — no meter access.**
- `title` text NOT NULL (CHECK non-empty trimmed); `description` text NULL.
- `severity` `squawk_severity` NOT NULL; `status` `squawk_status` NOT NULL DEFAULT `'open'`.
- `reported_by` uuid NOT NULL — composite FK `(reported_by, org_id) → app_user(id, org_id)` RESTRICT.
- `reported_at` timestamptz NOT NULL `defaultNow()`.
- `resolution_notes` text NULL; `resolved_by` uuid NULL (composite FK SET NULL); `resolved_at` timestamptz NULL.
- `created_at`, `updated_at` timestamptz NOT NULL `defaultNow()`.

CHECKs: `squawk_title_nonempty_check`; `squawk_resolved_shape_check`
(`status IN ('resolved','deferred') ⇒ resolved_by, resolved_at NOT NULL`; `status='open' ⇒ resolved_by, resolved_at, resolution_notes ALL NULL`).

**Records posture:** `title`/`description`/`severity`/`reported_by`/`reported_at` write-once;
only `status`/`resolution_notes`/`resolved_by`/`resolved_at`/`updated_at` mutate. **No reopen
path** ([VERIFY-3b-D]).

Indexes: `uniqueIndex(id, org_id)`; `index(org_id, resource_id, status)` (open-count + per-aircraft list).

### 1.4 RLS + grant (both tables)
ENABLE + FORCE RLS; **4 named fail-closed policies** (SELECT/INSERT/UPDATE/DELETE) with the
standard GUC predicate `org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid`
(verbatim from `0005_dispatch.sql`). `GRANT SELECT, INSERT, UPDATE, DELETE ... TO aeroops_app`.
`aircraft_grounding` is append-only (no sanctioned UPDATE/DELETE code path); `squawk` UPDATE
is exercised only by the status transition.

### 1.5 Candidate-key prerequisite
`dispatch_ticket(id, org_id)` UNIQUE already exists (0005). `squawk(id, org_id)` UNIQUE is the
candidate key for `aircraft_grounding.squawk_id`'s FK — **create `squawk` before
`aircraft_grounding`'s `squawk_id` FK** in migration ordering.

### 1.6 Migration `0006_squawks_grounding.sql` (+ `.down.sql`) — staged + HUMAN-GATED, NEVER applied
Human-gated banner verbatim from `0005_dispatch.sql:1-47`. Order: (1) enums; (2) `squawk` table
(+FKs/CHECKs/UNIQUE); (3) `aircraft_grounding` (+FKs incl. `squawk_id`/CHECK/UNIQUE); (4) indexes;
(5) ENABLE+FORCE RLS both; (6) 4 policies × 2 tables; (7) grants. `.down.sql` reverses.

### 1.7 Schema tests
RLS isolation (cross-org read → 0 rows); FORCE RLS; cross-org composite-FK rejection for every
edge (`resource_id`, `created_by`/`reported_by`, `dispatch_ticket_id`, `squawk_id`); non-member
`created_by`/`reported_by` rejection; `aircraft_grounding_reason_check`; `squawk_title_nonempty_check`;
`squawk_resolved_shape_check`; `ON DELETE RESTRICT` blocks deleting a resource with rows; `SET NULL`
on `dispatch_ticket_id`/`squawk_id`/`resolved_by`.

## 2. API contracts
Pattern: **`fn(session, input)` + `fnWithDb(db, session, input)`**; `requireCapability(...)` FIRST;
Zod-validate → `ValidationError`; body inside `withSessionOrgContextWithDb`; `org_id` from session
only; one `audit_log` row per mutation; operational refusals RETURNED, auth/validation THROWN.
New module dir `packages/api/src/maintenance/`. Barrel from `packages/api/src/index.ts`.

### 2.1 New capabilities (`packages/core/src/capabilities.ts`, alphabetical; keep `satisfies` exhaustive; update `capabilities.test.ts`)
Per Conductor decision: `maintenance:access` (owner/manager/dispatcher/cfi/mechanic),
`maintenance:ground` (owner/manager/dispatcher/mechanic), `maintenance:squawk`
(owner/manager/dispatcher/cfi/mechanic).

### 2.2 Grounding API — `maintenance/{ground-aircraft,grounding-status,types}.ts`
- **`groundAircraft`** (authz `maintenance:ground`): input `{ resourceId, reason, squawkId?, dispatchTicketId? }`; resource must be visible/active/`kind='aircraft'` (else `ValidationError`); optional refs visible in-org. Idempotent: if latest event already `'grounded'` → `{ ok:true, alreadyGrounded:true, grounding }` (no write/audit). Else INSERT `'grounded'` + audit `grounding.grounded`. Result `{ ok:true; grounding: GroundingEventView; alreadyGrounded?: boolean }` (everything invalid THROWS; no `not_found` arm).
- **`unGroundAircraft`** (authz `maintenance:ground`): input `{ resourceId, reason? }`. Idempotent when already released/none. Else INSERT `'released'` + audit `grounding.released`. Result `{ ok:true; grounding: GroundingEventView | null; alreadyReleased?: boolean }`.
- **`getGroundingStatus`** (authz `maintenance:access`): input `{ resourceIds: string[] }` (≥1). One `DISTINCT ON (resource_id) ... ORDER BY resource_id, created_at DESC, id DESC` query. Returns `Map<resourceId, GroundingStatusView>` (every id keyed); `GroundingStatusView = { grounded, reason|null, since|null, groundedBy|null, eventId|null }`.

`GroundingEventView = { id, resourceId, state, reason, squawkId|null, dispatchTicketId|null, createdBy, createdAt }`.

### 2.3 The grounding GATE
**Pure (property-tested)** — `packages/core/src/maintenance/grounding-gate.ts`:
`evaluateGroundingGate(candidateResources: { resourceId, kind, grounded, reason }[], mode: 'block'|'warn'): { blocked: GroundingHit[]; warnings: GroundingHit[] }`,
`GroundingHit = { resourceId, reason }`. Pure (no I/O/clock). Only `kind==='aircraft'` evaluated.

**Integration A — shared create path (Option A, approved):** add one step to
`gatedCreateOccurrence` after the policy probe: load grounding status for candidate aircraft,
run `evaluateGroundingGate(..., 'warn')`, attach result to a NEW optional `groundingWarnings?:
GroundingHit[]` on the `ok:true` arm. **The create still succeeds; no new refusal arm, no changed
precedence** — every existing arm byte-identical. Applies through create/series/reschedule.

**Integration B — `openDispatch`** (3a code we own): after the active-aircraft check
(`open-dispatch.ts:160-182`), load the aircraft's latest grounding event; if `'grounded'`, RETURN
`{ ok:false, reason:'grounded', grounding: { resourceId, reason } }` (no write/audit). Additive
union member on `OpenDispatchResult`. **[VERIFY-3b-H]:** operator enforcing their own decision; no
FAR determination by the software.

### 2.4 Squawk API — `maintenance/{report-squawk,update-squawk-status,list-squawks,types}.ts`
- **`reportSquawk`** (authz `maintenance:squawk`): input `{ resourceId, title, description?, severity, dispatchTicketId? }`. Resource visible/active/aircraft; optional ticket visible. INSERT status `'open'`, `reported_by=session.userId` + audit `squawk.reported`. **Does NOT auto-ground** even when `severity='grounding'` ([VERIFY-3b-E]). Result `{ ok:true; squawk: SquawkView }`.
- **`updateSquawkStatus`** (authz `maintenance:squawk`): input `{ squawkId, status:'resolved'|'deferred', resolutionNotes? }`. Only `open→resolved`/`open→deferred` valid; `open→open` no-op `{ ok:true }`. Guarded `UPDATE WHERE id=$ AND status='open'` SET status/resolution_notes/resolved_by/resolved_at/updated_at (0 rows → `not_open`); audit `squawk.status_changed`. Result `{ ok:true; squawk } | { ok:false; reason:'not_found' } | { ok:false; reason:'not_open' }`. **No reopen.**
- **`listSquawks`** (authz `maintenance:access`): `{ resourceId?, status?, limit? }` (cap ~200, newest first). Returns `SquawkView[]`.
- **`getOpenSquawkCounts`** (authz `maintenance:access`): `{ resourceIds: string[] }` (≥1). `GROUP BY resource_id WHERE status='open' AND resource_id = ANY(...)`. Returns `Map<resourceId, number>` (every id keyed; 0 default).

`SquawkView = { id, resourceId, dispatchTicketId|null, title, description|null, severity, status, reportedBy, reportedAt, resolutionNotes|null, resolvedBy|null, resolvedAt|null }`.

### 2.5 Error model
`UnauthenticatedError`/`ForbiddenError` THROWN before data access; `ValidationError` THROWN for
malformed/non-aircraft/inactive/cross-org-invisible. Operational outcomes RETURNED: `not_found`,
`not_open`, `already_open` (existing), new `grounded` (openDispatch).

## 3. UI states (web only; no mobile in 3b)
- **3.1 Board grounding chips** — board page parallel-fetch gains `getGroundingStatusAction` +
  `getOpenSquawkCountsAction`. Each aircraft row shows a `Grounded` chip (red + reason) and an
  open-squawk count badge (when `maintenance:access`). Fetch failure is **non-fatal** (chips off,
  board still renders). `maintenance:ground` → Ground/Release buttons → GroundAircraftDialog
  (reason required) / confirm-Release.
- **3.2 New-reservation + resource picker (the wedge "before booking")** — grounded aircraft show
  an inline `Grounded` badge + reason **before commit**. Selecting one is allowed (warn) with a
  persistent warning; on submit, render `groundingWarnings` from the create response. Show the
  badge to anyone who can book.
- **3.3 Check-out grounded block** — CheckOutDialog handles the new `grounded` arm with a blocking
  error ("…is grounded and cannot be dispatched: <reason>. Release it first.").
- **3.4 Squawk list + create** — new route `/o/[slug]/(shell)/maintenance/squawks`. Page-level
  `requireCapability('maintenance:access')`. Loading/empty/populated/error/permission-denied states.
  "Report squawk" → ReportSquawkDialog; open squawks get Resolve/Defer → ResolveSquawkDialog.
- **3.5 Squawk-on-return (3b.3)** — optional collapsible section in CheckInDialog; after
  `closeDispatch` succeeds, fire `reportSquawk({ ..., dispatchTicketId })`. Independent calls — a
  squawk-report failure does NOT un-close the ticket (non-blocking message).

Nav: add a "Maintenance" (or "Squawks") item filtered by `maintenance:access` in `apps/web/lib/nav`.

## 4. Edge cases
Tenant isolation everywhere (RLS + composite FKs; `org_id` from session only). Grounding double-
ground/release idempotent. Gate-vs-grounding race: warn at create may pass, `openDispatch` re-reads
live state and blocks; released between board render and check-out → allowed. Squawk status
concurrency guarded by `WHERE status='open'`. Records write-once; one audit row per mutation;
idempotent no-ops write none. No money/cards/pricing. `severity='grounding'` never auto-grounds.
Soft-deleted aircraft: reads persist, writes reject; hard-delete RESTRICT-blocked. No interval/overlap
math (point-in-time events; no btree_gist). No money rounding (no priced value).

## 5. [VERIFY] flags → compliance-officer at /qa
3b-A (deferred = operator status, no MEL), 3b-B (severity = triage label), 3b-C (release reason
optional), 3b-D (no reopen), 3b-E (squawks advisory, never auto-ground), 3b-H (grounding blocks
dispatch as operator enforcement, no FAR determination). Resolve before merge.

## 6. Test list
**Property (core, hard guardrail) — `evaluateGroundingGate`:** G1 released never blocked/warned;
G2 mode partitions correctly; G3 non-aircraft never evaluated; G4 exact partition (no double-count);
G5 purity (same in → same out, twice deep-equal). Unit: empty/all-grounded/mixed/`grounded&reason=null`.
**Unit (core):** `is*` guards; capability matrix exhaustiveness + the three new rows; enum tuple stability.
**Integration (api, pglite, *WithDb) — grounding:** ground/unground happy+audit+idempotent; non-aircraft/
inactive/cross-org → `ValidationError`; `getGroundingStatus` latest-per-resource + tie-break by id +
RLS + authz. **Gate at create:** grounded aircraft → `ok:true` + `groundingWarnings`; released → none;
all pre-existing arms byte-identical; same through series (per-occurrence) + reschedule. **Gate at
openDispatch:** grounded → `{ok:false,reason:'grounded'}` no write/audit; after release → succeeds;
grounded after open before close → close still succeeds. **Squawks:** report happy+audit; `severity=
'grounding'` does NOT ground; empty title → `ValidationError`; status open→resolved/deferred happy;
re-resolve → `not_open`; cross-org → `not_found`; concurrency guard; list filters; open-counts. **Audit:**
exactly one row per mutation with correct action/entity/metadata; no-ops write zero. **Schema:** §1.7.
**No-regression:** the entire Slice-1/2a/2b/2c/3a suite stays green and byte-identical except
`openDispatch`'s additive `grounded` arm; `groundingWarnings` is optional so no consumer breaks.

## 7. Build order
1. **Core:** `maintenance/enums.ts` + `grounding-gate.ts` (+ property tests) + capabilities additions (+ `capabilities.test.ts`).
2. **Schema + migration 0006** (squawk before aircraft_grounding) + schema tests (human-gated).
3. **API 3b.1:** grounding functions + gate wiring (Option A into the create path + `openDispatch` `grounded` arm) + integration tests.
4. **API 3b.2:** squawk functions + tests.
5. **Web 3b.1:** board chips + Ground/Release dialogs + new-reservation badge + check-out `grounded` handling + actions + nav item.
6. **Web 3b.2:** `/maintenance/squawks` route + board open-squawk badge.
7. **Web 3b.3:** check-in squawk-on-return section.
8. Full suite green + no-regression. ADR-0008 + this spec finalized.

## Invariants builders MUST hold
Every new row carries `org_id`; both tables ENABLE+FORCE RLS + 4 fail-closed policies + grant; reads/
writes only inside `withSessionOrgContext`; `apps/web` never imports `@aeroops/db`; `org_id` from session
only. Grounding events + squawk reported-facts write-once; one `audit_log` row per mutation; idempotent
no-ops write none. No meter access; no money/cards/pricing; no computed FAR/airworthiness — grounding &
severity are operator data. Refusals RETURNED, auth/validation THROWN. FROZEN engines byte-identical;
edits additive only. Migration 0006 staged + human-gated, NEVER applied to a real DB.
