# ADR-0005 — Booking-policy enforcement gate: a second gate beside conflict detection

**Status:** Proposed (Phase 1, Slice 2a / SCHED-2a). **Owners:** CTO, architect, scheduling-engineer. **Builds on:** ADR-0001 (RLS/`withOrgContext`), ADR-0003 (capability gate), ADR-0004 (conflict engine — **FROZEN**; this ADR extends, never modifies it).

## Context
Slice 1 (ADR-0004) gave one sanctioned reservation write path guarded by one gate: conflict detection. That gate has a two-layer shape — a pure advisory predicate in `@aeroops/core` plus an authoritative DB backstop (the `EXCLUDE` constraint) that makes the rule unforgeable from app code.

Slice 2a adds **booking policies** (THE-BIBLE §2.1: who can book what, advance limits, max duration, blackouts, required ratings). A policy is a per-resource, operator-defined rule set a proposed reservation must satisfy *in addition to* being conflict-free.

**The structural asymmetry driving this ADR:** conflict has a natural DB backstop — overlap is a coexistence property expressible as `EXCLUDE USING gist`. Booking policy is different: most rules (advance limit, required-tag match, blackout membership) are predicates over a single proposed row plus reference data and wall-clock `now()` — not "two rows may not coexist." No honest declarative DB constraint expresses "created more than 30 days ahead" or "member holds the required tag." So what makes the policy gate authoritative without an `EXCLUDE`? **Exactly one sanctioned write path exists, and the policy check is part of it** (ADR-0004 invariant 2). That is the unforgeability story; the reviewer keeps it true.

## Decision

### 1. Two layers, same boundary as ADR-0004 — the choke-point is the authority
- **`@aeroops/core` — pure policy predicate.** New `scheduling/policy.ts` exports `evaluateBookingPolicy(candidate, policy, blackouts, actorTags, now)` → `PolicyViolation[]` (empty = clear). No I/O, no Drizzle, no internal clock (`now` injected → pure + property-testable). Reuses the exact half-open `[start,end)` discipline from `overlap.ts` for blackout membership. Advisory only — never the sole write gate.
- **`@aeroops/api` — authoritative enforcement at the single choke-point.** Inside `createReservation`, within the existing `withSessionOrgContext` transaction, after resource validation and alongside the conflict pre-check, the path loads per-resource policy + blackout rows (RLS-scoped) + the booking member's tags, runs the same predicate, and refuses the write on any violation. Unforgeable for the same reason the conflict pre-check is: nothing else can insert a reservation.

**Ruling on the asymmetry:** authoritative enforcement for policy is the app-layer check at the single choke-point — sufficient given and only given invariant 1 (one write path). If a second write path ever appears, the policy check MUST move to a shared internal helper both call. This is weaker than `EXCLUDE` (which survives a rogue INSERT); we accept it because no faithful DB constraint exists for time-relative/reference-data rules.

**Selective DB backstop:** `max_duration` is the one rule that is a pure function of the proposed row's own columns. It *could* carry a CHECK-style backstop, but the limit lives in a per-resource policy row (a plain table CHECK can't see it; it would need a denormalized column or trigger). **Decision: defer the `max_duration` DB CHECK** (additive, reversible). All other rules are app-layer-only by nature and get no DB backstop — and this ADR says so, so no builder invents one.

### 2. Policy resolution — per-resource row, optional, absent = open booking (THINNEST)
One optional `booking_policy` row per resource (`UNIQUE (resource_id)`). **Absent row = open booking** — Slice-1 behavior preserved byte-for-byte. **Per-resource only in 2a; NO per-resource-kind org default / inheritance yet.** This is not a corner: resolution is encapsulated behind one resolver ("the effective policy for resource R") — adding an org-default tier later changes that one resolver + one table; the core predicate and call site (which consume a *resolved* policy object) are unchanged. Named as invariant 7 to keep it reversible.

### 3. Composition — both gates fire, both surface in ONE call, create refuses on EITHER
A policy violation, like a conflict, is a **returned value, not thrown**. Validation failures stay thrown `ValidationError`. The advisory preview and create path report both a conflict and a policy violation in a single call. **Result-shape extension is additive only:** the existing `{ ok:false; reason:'conflict'; conflicts: ConflictHit[] }` is never narrowed/renamed; 2a adds sibling arms carrying `policyViolations`. No existing `ConflictHit`/conflict-branch field changes type or meaning. Refusal predicate: refuse if `conflicts.length > 0 || policyViolations.length > 0`; all-or-nothing preserved.

### 4. Blackout windows — separate table, half-open `[start,end)`, checked in pure core
A separate `resource_blackout` table (NOT embedded), mirroring the `reservation_resource` range discipline: each row a `during tstzrange` built with the single sanctioned `'[)'` encoding. Adjacency is NOT a violation. Overlap is checked in pure core against supplied rows (same architecture as `findConflicts`), calling the *same* `intervalsOverlap` (reused, not reimplemented; `overlap.ts` untouched). No DB `EXCLUDE` for blackout-vs-booking — a booking overlapping a blackout is a policy refusal, not a coexistence constraint; blackout is reference data. Two blackouts on one resource may overlap freely (operator's prerogative).

### 5. Isolation invariants — every new table follows ADR-0001/0004
Every new tenant table (`booking_policy`, `resource_blackout`): `org_id NOT NULL` + FK→`org(id)` CASCADE; `ENABLE`+`FORCE` RLS; 4 fail-closed named policies (`org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid`); composite FK `(resource_id, org_id) → resource(id, org_id)`; explicit `aeroops_app` grant. All reads only inside `withSessionOrgContext`; `apps/web` never imports `@aeroops/db`. `membership.booking_tags text[]` and `resource.required_tags text[]` are operator-defined free-text only.

### 6. Forward-compat — 2b/2c reuse with zero re-architecture
- **2b (recurrence):** each expanded candidate clears BOTH gates through the same predicate pair; a `map` over candidates, no engine change.
- **2c (drag-drop reschedule):** modeled as cancel + recreate through the same gated path → re-clears both gates automatically; no reschedule-specific bypass.
- **`max_duration` DB CHECK** (deferred) is additive, not a re-architecture.

## Consequences
- The write path now runs two gates; both pure-core predicates with one authoritative app-layer enforcement point. The no-double-book `EXCLUDE` is untouched and remains the strongest guarantee.
- **Policy is choke-point-enforced, not DB-enforced** — strictly weaker than the conflict `EXCLUDE`; acceptable only while invariant 1 holds. This is the single thing the reviewer must watch hardest; flagged, not papered over.
- Two new tables + two array columns; migration `0003` small, staged, **human-gated — NEVER auto-applied**.
- Open booking (no policy row) is default → every existing resource and test behaves identically; the slice is non-breaking.
- Per-resource-only resolution is a deliberate thin-slice limit; the org-default tier is reversibly addable behind the resolver.
- The advisory result grows additively; existing `conflicts`-only consumers keep working.

## Invariants (reviewer enforces)
1. **One sanctioned write path** runs BOTH gates (conflict + policy). Nothing else inserts reservations; if a second path is added, the policy check MUST be a shared helper both call. (Keystone of policy unforgeability.)
2. **Core policy predicate stays pure** — no I/O, no Drizzle, no internal `Date.now()` (`now` injected); advisory only.
3. **`overlap.ts`, the `EXCLUDE` constraint, and the `ConflictHit`/conflict result branch are FROZEN** — 2a reuses `intervalsOverlap` and only *additively* extends the result with policy violations.
4. **Half-open `[start,end)` everywhere** for blackouts; adjacency is NOT a violation.
5. **Both new tables** `org_id`-scoped + `ENABLE`+`FORCE` RLS + 4 fail-closed policies + composite FK + grant; `apps/web` never imports `@aeroops/db`.
6. **Absent policy row + no blackouts = open booking**, identical to Slice 1 (non-breaking guarantee).
7. **Policy resolution is a single encapsulated step** — the create path consumes a *resolved* policy object, never queries precedence inline.
8. **Required ratings are operator-defined free-text tags ONLY** — `membership.booking_tags[]` ∩ `resource.required_tags[]`. NO computed FAA currency/medical/Part 61/141 anywhere in this slice.
9. **Policy violations are RETURNED values, not thrown**; validation stays thrown `ValidationError`.

## Hard boundaries (binding on all builders)
- **Required ratings = free-text tags only.** NOT FAA currency, medical, flight review, IPC, 90-day, or any Part 61/141/135 rule. **[VERIFY]** real computed currency is Phase 3 Training, owned by `compliance-officer`. If a ticket drifts toward computed currency, STOP and ask.
- **Non-financial only.** Balance / below-minimum / outstanding-invoice restriction is OUT (Phase 2 Billing).
- **Conflict engine frozen** (invariant 3). 2a sits beside it.
- **Migration `0003` staged + human-gated, NEVER auto-applied.**

## Alternatives considered
- **DB trigger/generated-column backstop for all policy rules:** rejected — time-relative + reference-data rules force triggers reading `now()`/other tables, more coupling than the choke-point removes. Keep the one honest candidate (`max_duration` CHECK) as a deferred additive follow-up.
- **Embed blackouts as a `range[]` column:** rejected — loses per-row FK/RLS/index discipline; a child table mirrors `reservation_resource`.
- **Two-tier org-default + per-resource override in 2a:** rejected as not-thinnest; reversibly addable via the resolver (invariant 7).
- **Throwing policy violations:** rejected — inconsistent with the returned-value posture.

## Open questions (founder / compliance)
1. **`max_duration` DB CHECK** — defer (recommended, additive/reversible) vs. include a denormalized/trigger CHECK in `0003` now. CTO: **defer**.
2. **[VERIFY] tag taxonomy** — confirm with compliance that operator free-text booking tags carry no regulatory meaning in the UI (no label implying computed FAA recency).
3. **Advance-limit direction** — 2a supports a max lead time (`max_advance_days`) and a min lead time (`min_advance_minutes`); confirm both are wanted in 2a.
4. **Required-tags usability** — **RESOLVED 2026-06-16 (founder): required-tags / eligibility is DEFERRED out of Slice 2a** to a focused follow-up slice that also builds the member-tag admin surface. Slice 2a ships four rules only (max duration, max advance, min lead, blackouts). Invariant 8 and the "required ratings = free-text tags only" boundary remain the governing rule for that follow-up — recorded here so the free-text-only / no-FAA-currency constraint is not lost when eligibility is built.

## Links
ADR-0001 (tenant isolation), ADR-0003 (capability gate), ADR-0004 (conflict engine — FROZEN; this extends), THE-BIBLE §2.1 / §10. Related memory: [[ios-mobile-app-required]].
