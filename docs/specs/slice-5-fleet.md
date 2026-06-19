# Slice 5 — Fleet / Aircraft detail pages (build spec)

## Conductor decisions (2026-06-18) — RESOLVED, builders may proceed

- **(a) Tail # is FROZEN in `updateAircraft`** — not editable in this slice (identity-critical, tied to dispatch/squawk/grounding history). `kind` and `active` also not editable here (`active` stays owned by `deactivateResource`).
- **(b) Capability grants:** `fleet:access` → owner, manager, dispatcher, cfi, mechanic. `fleet:manage` → owner, manager, dispatcher, mechanic (NOT cfi — CFI reads, can't edit identity). renter/student/accountant get neither.
- **(c) Inspection columns = documented forward seam ONLY, no column created** in 0007 (Phase 4 territory; an unused nullable column invites the forbidden feature). Note the seam in the schema header.
- **(d) Recent-N = 10** for recent squawks, recent dispatch, and upcoming reservations.
- **(e) Edit Aircraft = a Dialog on the detail page** (consistent with existing edit dialogs), `fleet:manage` gated.
- **Meter-config = two booleans** `has_hobbs` / `has_tach` (NOT NULL DEFAULT true) — display/config only; they DO NOT alter the FROZEN ADR-0007 dispatch meter-capture path.
- **Precursor (REQUIRED):** `location` has no `(id, org_id)` candidate key today. Migration 0007 MUST first `ALTER TABLE location ADD CONSTRAINT location_id_org_id_unique UNIQUE (id, org_id)` (and `location.ts` gets the matching `uniqueIndex`) BEFORE the `home_base_location_id` composite FK.
- **Migration 0007 stays staged + HUMAN-GATED, NEVER applied to a real DB.** The demo applies it in-memory.
- **Compliance: light.** No new reg claims; carry-forward `[VERIFY]` only (current meters = "last recorded", not airworthiness; grounding = operator data). Route the two label-wording confirmations to compliance at QA.

Sub-slices: **5.1 schema (migration 0007) → 5.2 backend reads + edit → 5.3 web UI**, built/reviewed in sequence.

---

## 0. Invariants builders MUST hold
- Every new query runs through `withSessionOrgContextWithDb` (RLS backstop); no org_id from input; cross-org id → `not_found` (never a 500, never a cross-org peek).
- `home_base_location_id` is a same-org composite FK `(home_base_location_id, org_id) → location(id, org_id) ON DELETE SET NULL` (hand-written; column carries no `.references()`).
- `updateAircraft` edits IDENTITY fields only; ONE `audit_log` row per mutation; never touches meters/dispatch/squawk/grounding records (write-once / append-only, owned by their existing paths).
- Additive only: FROZEN engines + existing reservation/dispatch/squawk/maintenance queries untouched; existing `resource` inserts that omit the new columns MUST still succeed; `resource_kind_shape_check` left byte-for-byte intact.
- No money (no rates/pricing/balance). No computed inspections/AD/airworthiness. Hobbs/tach display reuses 3a `[VERIFY-A]`; grounding reuses `[VERIFY-3b-H]`.

## 1. Data model (5.1 — migration 0007, human-gated)

New nullable columns on `resource` (aircraft-oriented; `resource.ts` + 0007):

| Column | Type | Notes |
|---|---|---|
| `make` | text NULL | free text |
| `model` | text NULL | free text |
| `year` | integer NULL | CHECK `year IS NULL OR (year BETWEEN 1900 AND 2200)` (sanity, not a reg) |
| `serial_number` | text NULL | operator-entered |
| `home_base_location_id` | uuid NULL | composite FK → location(id, org_id) SET NULL |
| `has_hobbs` | boolean NOT NULL DEFAULT true | display/config only |
| `has_tach` | boolean NOT NULL DEFAULT true | display/config only |

`resource_kind_shape_check` UNCHANGED (new columns are nullable/outside it; do NOT require make/model for aircraft — would break existing rows). No new index (`resource_org_id_kind_idx` covers the fleet list).

Migration 0007 order: (1) `location_id_org_id_unique` UNIQUE on `location(id, org_id)`; (2) the 7 `ADD COLUMN`s; (3) `resource_year_sane_check`; (4) `resource_home_base_org_fk` composite FK. `.down.sql` reverses (drop FK → check → columns → location unique key). Human-gated banner verbatim from 0006; prerequisite = 0006 applied.

Regression gate (MUST stay green): `scheduling-schema.test.ts` (all `resource_kind_shape_check` cases), scheduling resource/reservation tests (incl. `listResources`/`ResourceRow` unchanged), all 3a/3b tests.

## 2. API (5.2 — new module `packages/api/src/fleet/`)
Pattern: `fn(session,input)` + `fnWithDb`; `requireCapability` FIRST; Zod-validate; `withSessionOrgContextWithDb`; reuse existing views (`DispatchTicketView`, `SquawkView`, `GroundingStatusView`) + `loadGroundingProbe` + the `getOpenSquawkCounts`/`listSquawks` query shapes. Barrel from `packages/api/src/index.ts`.

New caps (core `capabilities.ts`, alphabetical, keep `satisfies` exhaustive + update test): `fleet:access`, `fleet:manage` per decision (b).

- **`listAircraft(session, { includeInactive? })` → `AircraftListRow[]`** (authz `fleet:access`). Query: aircraft (RLS) → `loadGroundingProbe` → open-squawk counts. Row `{ id, tailNumber, make, model, active, grounded, openSquawkCount }`. Default active-only.
- **`getAircraftDetail(session, { resourceId })` → `{ ok:true; aircraft: AircraftDetail } | { ok:false; reason:'not_found' }`** (authz `fleet:access`). `not_found` when invisible/cross-org OR `kind!=='aircraft'`. Aggregate (~5 queries, same org context, no N+1): identity + home-base join; grounding (`loadGroundingProbe`); open-squawk count + recent squawks (≤10); last-10 dispatch tickets (incl. voided, render status) + current meters = latest `status='closed'` ticket's `hobbsIn`/`tachIn` (+ `closedAt` as `currentMetersAsOf`; null if no closed ticket); upcoming reservations (future, booked, this aircraft, ≤10, focused query in `fleet/internal.ts`). `AircraftDetail` per spec (identity, homeBase|null, hasHobbs/hasTach, grounding, openSquawkCount, recentSquawks, recentDispatch, currentHobbs/currentTach|null, currentMetersAsOf|null, upcomingReservations).
- **`updateAircraft(session, input)` → `{ ok:true; aircraft } | { ok:false; reason:'not_found' } | { ok:false; reason:'invalid_home_base' }`** (authz `fleet:manage`). Editable: make, model, year, serialNumber, homeBaseLocationId, hasHobbs, hasTach, displayName. NOT editable: tailNumber, kind, active, any record/meter. Validate year range + homeBaseLocationId UUID; pre-check the location is visible same-org (else `invalid_home_base`); target must be visible aircraft (else `not_found`). ONE audit row `aircraft.updated` with before/after of identity fields. Returns fresh detail.
- **`listLocations(session)` → `{ id, name, icao }[]`** (authz `fleet:access`, RLS) — small new read to populate the home-base select.
- `listResources`/`ResourceRow` NOT changed (existing consumers depend on it).

## 3. Web (5.3 — `apps/web/app/o/[slug]/(shell)/fleet/`)
RSC pages + `requireCapability` gate + Suspense; actions wrap the API fns. Design system: shared `components/ui/*` primitives, architectural corners, `brand`/`brand-ink`/`danger` tokens, `.nums` on tail #s/meters/hours. Never hardcode color.
- **`/fleet` list** (`fleet:access`): loading skeleton / empty ("No aircraft yet", link to Resources admin to add) / populated table (tail # bold `.nums`, make+model, status chips: Grounded(danger) / "N open squawks"(link to squawks filtered) / Inactive / Active) rows link to detail / error Alert+Retry.
- **`/fleet/[id]` detail** (`fleet:access`): not-found empty state (not 500) / loading / populated overview cards: identity header (+ Edit button if `fleet:manage`), grounding status banner, current-meters card (Hobbs card iff hasHobbs, tach iff hasTach; "No recorded meters yet" if null), open-squawks card (deep-link to squawk surface filtered to aircraft), recent-dispatch card (date/pilot/Hobbs out-in/flight time/status badge, `.nums`), upcoming-reservations card ("Repeats" badge if seriesId).
- **Edit dialog** (`fleet:manage`): make/model/year/serial/home-base select(`listLocations`)/hasHobbs/hasTach/displayName; inline validation; `invalid_home_base` inline; `not_found` → close+toast. Re-checks cap server-side.
- **Nav:** add `Fleet` item (`fleet:access`) after Resources / before Maintenance in `lib/nav.ts`; update nav tests.

## 4. Edge cases
Tenant isolation on EVERY aggregated facet (cross-org id → not_found, no facet leak); non-aircraft id → not_found; no dispatch → empty + null meters; only open/voided tickets → null current meters + non-empty list; grounded → danger banner (operator language); no/cross-org home base → null / structurally unlinkable / SET NULL on location delete; hasHobbs/hasTach false → hide meter card (display only, dispatch still records both); no money/rounding; last-writer-wins on identity; inactive aircraft still has a detail page; year boundary → ValidationError + DB CHECK; empty fleet → empty state.

## 5. Tests
**No property tests** (no new pure decision logic — say so in the QA packet; if a current-meter helper is extracted, ordinary table-driven unit tests). Schema T1–T7 (additive columns + defaults; omit-columns insert still works; kind-shape unchanged; year CHECK; composite FK same-org/cross-org/SET-NULL; location unique key; down reverses). Backend T8–T25 (list happy/isolation/authz; detail happy/per-facet isolation/non-aircraft not_found/no-history null meters/open-voided-only null meters/grounded/no-home-base/authz; update happy+ONE audit/non-editable-fields-unwritable/not_found/invalid_home_base/authz CFI-denied/year-range; listLocations RLS+authz). Capabilities T26 (exhaustive + new grants + renter/student/accountant denied). Web T27–T30 (nav visibility; list/detail/edit states).

## 6. [VERIFY] (compliance — light, carry-forward only)
- **[VERIFY-5-A]** current-meter display reuses 3a `[VERIFY-A]`: label as "last recorded" reading (latest closed ticket's `_in`), NOT a live/authoritative airframe total or maintenance value.
- **[VERIFY-5-B]** grounding banner reuses 3b `[VERIFY-3b-H]`: operator-data language ("Grounded by {operator}"), never "not airworthy".
- No inspection/AD/airworthiness computed; fleet page only DISPLAYS meters (read-only), does not correct/recompute → does not trip the correction-table predecessor. Compliance confirms display-only wording.
