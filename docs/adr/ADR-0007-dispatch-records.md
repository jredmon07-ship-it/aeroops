# ADR-0007 — Dispatch ticket: records-immutable check-out/in, the one-open backstop, the dispatch↔reservation seam

**Status:** Accepted (Phase 1, Slice 3a / DISPATCH-3a; ratified by conductor 2026-06-16). **Owners:** CTO, architect, scheduling-engineer. **Builds on:** ADR-0001 (RLS/`withOrgContext`), ADR-0003 (capability gate), ADR-0004 (conflict engine — FROZEN; EXCLUDE backstop + single-write-path), ADR-0005 (policy gate — FROZEN; injected seam + app-check-at-choke-point), ADR-0006 (recurrence/reschedule — FROZEN; single write path + audit linkage). Extends the scheduling surface; modifies none of it.

## Context
Slice 3a builds the first thing downstream of a reservation: **dispatch** — releasing an aircraft and recording its meters. A ticket has two events: OPEN (check-out: `hobbs_out`/`tach_out` + pilot) → CLOSE (check-in: `hobbs_in`/`tach_in` → derived billable flight time). Three structural problems, each with a FROZEN-ADR analogue: (1) **these are RECORDS** (Hobbs/tach are the legal/operational truth; no silent mutation); (2) **at most one OPEN ticket per aircraft** (a coexistence rule → a DB backstop like the conflict EXCLUDE); (3) **dispatch must not be retroactively mutated by reservation lifecycle** (records are append-only events, not mutable projections). 3a is the records core only — no balance, grounding, billing, or currency.

## Decision

### 1. Records posture — meters write-once; corrections out of 3a; a mis-check-out is reversed by an audited VOID, not an UPDATE
A `dispatch_ticket` has exactly: **mutable** `status` transitions `open→closed` (check-in) and `open→voided` (abandon a mistaken check-out); **immutable once written** `hobbs_out`/`tach_out`/`pilot_user_id`/`opened_at` (at OPEN) and `hobbs_in`/`tach_in`/`flight_time_hours`/`closed_at` (at CLOSE). NO code path UPDATEs a recorded meter. **Corrections to a closed ticket's meters are NOT in 3a** — when built they will be an append-only `dispatch_ticket_correction` row (old/new/actor/reason), never a destructive UPDATE; recorded here as a forward boundary, table not created in 3a. **3a ships OPEN, CLOSE, and VOID-while-open** (`voidDispatch(ticketId, reason)` → `open→voided`, audited `dispatch.voided`); a voided ticket keeps its meters, is excluded from the one-open backstop, and is never a billing basis. `closed→voided` (supervisor reversal of a bad check-in) is NOT in 3a — a wrong closed meter is a known audited gap until the correction table lands. **[VERIFY-D]** compliance confirms the interim is acceptable.

### 2. One-open-ticket-per-aircraft — a partial UNIQUE index, unforgeable from app code
`CREATE UNIQUE INDEX dispatch_ticket_one_open_per_resource ON dispatch_ticket (resource_id) WHERE (status='open')`. A second OPEN on an already-out aircraft raises `23505`, caught and mapped to a typed `already_open` refusal (the ADR-0004 catch-and-map). `closed`/`voided` are outside the predicate. **Org-scoping (ADR-0004 §Org-scoping reused):** `resource_id` is globally unique to one org (composite FK), so org partitions are disjoint — `org_id` is NOT in the index; RLS governs which rows a session may touch, the index which rows may coexist. **DB-enforced:** one-open partial-UNIQUE; same-org composite FKs on `reservation_id`/`resource_id`/`pilot_user_id`/`opened_by`; meter non-negativity + the closed-shape CHECK. **App-checked at the single write path (the ADR-0005 asymmetry — reference-data joins, no faithful single-row constraint):** "the dispatched aircraft is a resource on the ticket's reservation," "the reservation is booked," and **`in >= out`** (kept app-level, NOT a DB CHECK, so the meter-rollover decision stays open — [VERIFY-A]).

### 3. Dispatch ↔ reservation — independent once opened
Composite FKs `(reservation_id, org_id)`, `(resource_id, org_id)`, `(pilot_user_id, org_id)` (all `ON DELETE RESTRICT` for the senior records). The resource-level one-open partial-UNIQUE subsumes the active aircraft conflict; a reservation may accrue multiple historical closed/voided tickets (records history). **Once opened, a dispatch is independent — reservation cancel/reschedule does NOT mutate/close/void it** (a dispatch records a physical event; a booking is a plan). 3a does NOT cascade reservation status onto dispatch and does NOT modify the frozen `cancelReservation`/`rescheduleReservation` paths. Reservation hard-delete is RESTRICT-blocked by any ticket.

### 4. Flight-time derivation — pure core, property-tested, Hobbs-default
`deriveFlightTime(meterOut, meterIn)` in `@aeroops/core/dispatch/flight-time.ts` — pure (no I/O/clock), property-tested (the hard guardrail). **Meter basis = Hobbs default** (billable/rental basis; tach is recorded for maintenance, Phase 4); 3a stores BOTH meter pairs and derives `flight_time_hours` from Hobbs; operator-configurable basis is a LATER additive change (single call-site seam). `in >= out` (equality = 0 minutes allowed — a ground check-out); `in < out` throws `RangeError` in core / ValidationError at the API. **Records/ops data, NEVER a price.** **[VERIFY-A]** meter rollover/replacement is OUT of 3a (reject `in<out`), precision `numeric(10,1)`, billing granularity 0.1 hr — compliance confirms.

### 5. The balance seam — declared, built in 3c, NONE in 3a
3c's pre-flight gate balance dimension will be an INJECTED resolver (ADR-0005/0006 seam discipline) defaulting to a Phase-1 stub `{status:'unknown', blocking:false}`; real balance is Stripe/Phase 2. `openDispatch` is shaped so a gate-resolver is an additive parameter. **3a builds none of it.**

### 6. Capabilities + single write path
Two new capabilities `dispatch:access` (read) + `dispatch:create` (open/close/void), added to `CAPABILITIES` (alphabetical) + `ROLE_CAPABILITIES`; **both granted to owner/manager/dispatcher/cfi** (parity with `schedule:access`; the read/create split is structural for later viewer roles). Code-only — no DB matrix, no seed/migration. `openDispatch`/`closeDispatch`/`voidDispatch` are the ONLY sanctioned write paths: inside `withSessionOrgContext`, `org_id` from session only, `requireCapability('dispatch:create')` BEFORE data access, each writing exactly one `audit_log` row (`dispatch.opened`/`dispatch.closed`/`dispatch.voided`). `closeDispatch` derives `flight_time_hours` via the pure §4 fn in-tx, write-once. Operational refusals are RETURNED (`already_open`, `not_found`, `not_open`); auth/validation are THROWN.

### 7. Isolation invariants
`dispatch_ticket` (+ future correction table): `org_id` + FK→org CASCADE; ENABLE+FORCE RLS; 4 fail-closed policies (SELECT/INSERT/UPDATE/DELETE — UPDATE needed for the status transition); `UNIQUE (id, org_id)`; composite FKs on all edges; `aeroops_app` grant. Reads/writes only inside `withSessionOrgContext`; `apps/web` never imports `@aeroops/db`. Migration **0005** + down staged with the human-gated banner, NEVER auto-applied.

## Invariants (reviewer enforces)
1. Meters write-once; only mutations are `status` `open→closed` and `open→voided`.
2. One sanctioned write path per transition (open/close/void) in `@aeroops/api`, inside `withSessionOrgContext`, `dispatch:create`-gated FIRST, one audit row each; nothing else writes `dispatch_ticket`.
3. One-open-per-aircraft DB-enforced by the partial UNIQUE `WHERE status='open'`; `org_id` not in the index; `23505` mapped to `already_open`.
4. Flight-time derivation pure (no I/O/clock), property-tested; `in>=out` (equality=0); produces minutes/hours, NEVER a price; rollover out-of-scope + documented.
5. Dispatch lifecycle-independent — reservation cancel/reschedule never mutates a ticket; reservation hard-delete RESTRICT-blocked.
6. `dispatch_ticket` tenant-isolated (org_id + ENABLE+FORCE RLS + 4 policies + UNIQUE(id,org_id) + composite FKs + grant); web never imports `@aeroops/db`.
7. Operational refusals RETURNED (already_open/not_found/not_open); auth/validation THROWN; scheduling ADRs + frozen gates/types untouched.
8. NO balance/Stripe/billing/grounding/currency/maintenance in 3a; the balance seam is declared but built in 3c.
9. Migration 0005 + down staged, human-gated, NEVER auto-applied.

## Hard boundaries
NO Stripe/balance/invoicing/pricing in Phase 1 (derived time is ops data). NO computed currency/medical/Part-61 (Phase 3); NO maintenance work-orders/MEL/interval computation (Phase 4; tach stored not interpreted); NO civil-twilight/optimizer (Slice 4); NO fuel; NO mobile. Grounding (3b) is operator data not a computed reg determination — 3a encodes no airworthiness gate. Corrections of closed meters NOT in 3a (void-while-open only). Conflict/policy/recurrence/reschedule paths FROZEN — dispatch is downstream, reuses them only by composite-FK reference.

## Alternatives considered
In-place UPDATE to correct a closed ticket (rejected — silent mutation; corrections are append-only/deferred). EXCLUDE/GiST for one-open (rejected — single-row uniqueness, a plain partial-UNIQUE btree is the honest backstop). App-only one-open check (rejected — a faithful declarative constraint exists, so it gets the unforgeable backstop). Cascade reservation-cancel→auto-void dispatch (rejected — conflates booking plane with records plane). Composite `(reservation_id, resource_id)` partial-unique (rejected — redundant + wrongly blocks legitimate historical re-dispatch).

## Open questions / [VERIFY] (compliance/founder at QA gate; non-blocking to build)
- **[VERIFY-A]** Meter basis (Hobbs default) + reject-`in<out` (no rollover modeling) + precision `numeric(10,1)` + billing granularity 0.1 hr.
- **[VERIFY-B]** Does a recorded Hobbs/tach reading constitute a maintenance/logbook record needing stronger retention than the write-once row + audit? (belief: suffices for 3a.)
- **[VERIFY-C]** Part-141 dispatch-record retention beyond per-ticket audit rows (belief: suffices).
- **[VERIFY-D]** Mis-close remedy: wrong closed meter is an acceptable audited gap until the correction table; is `closed→voided` needed in 3a or can wait?

## Links
ADR-0001, ADR-0003, ADR-0004 (FROZEN; EXCLUDE/single-path reused), ADR-0005 (FROZEN; injected-seam + choke-point asymmetry), ADR-0006 (FROZEN; single path + injected-resolver + audit-linkage), THE-BIBLE §2.2 / §10. Related: [[ios-mobile-app-required]].
