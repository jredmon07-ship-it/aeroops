# ADR-0004 — Scheduling conflict-detection engine: architecture + race-safety

**Status:** Accepted (Phase 1, Slice 1 / SCHED-1). **Owners:** CTO, architect, scheduling-engineer. **Builds on:** ADR-0001 (RLS/`withOrgContext`), ADR-0003 (capability gate).

## Context
SCHED-1 introduces conflict detection — the primitive every later Hub (dispatch,
billing, training, maintenance) builds on. Two failures must be impossible: a
cross-tenant leak (ADR-0001) and a **double-book** (two non-cancelled reservations
sharing a resource over overlapping `[start,end)` windows). The double-book is a
classic read-then-write race. The mechanism must be race-proof in prod AND
testable on the `@electric-sql/pglite` harness, model the multi-resource
reservation (a booking may hold aircraft + instructor; any shared-resource overlap
= conflict), and extend to sim/room/vehicle + later slices without re-architecture.

**Environment finding (resolves the open question):** pglite 0.5.2 bundles
`btree_gist` as a loadable contrib extension (same loader shape as the already-wired
`pgcrypto`). So a Postgres `EXCLUDE USING gist` constraint is enforceable in prod
*and* exercisable in the test harness.

## Decision
**Two layers, one boundary** (`core ← db ← api ← web`):
- **`@aeroops/core` — pure predicate.** `intervalsOverlap(a,b)` on half-open
  `[start,end)` (adjacency is NOT conflict) + `findConflicts(candidate, existing)`.
  No I/O. This gets the property tests in isolation and powers the UI/advisory
  checks. Advisory, never the sole gate on a write.
- **`@aeroops/db` / `@aeroops/api` — race-safe persistence.** The authoritative
  guarantee is a **Postgres `EXCLUDE` constraint** on the `reservation_resource`
  join row, which carries a denormalized `during tstzrange`:
  `EXCLUDE USING gist (resource_id WITH =, during WITH &&) WHERE (status='booked')`
  (needs `CREATE EXTENSION btree_gist`). A reservation with N resources inserts N
  join rows in one transaction; if any collides, the INSERT raises `23P01
  exclusion_violation` and the whole transaction rolls back — all-or-nothing,
  enforced by the engine, impossible to forget. Default `READ COMMITTED` suffices;
  no SERIALIZABLE retry loop.

**Layered, not either/or (the reconciliation):** the `EXCLUDE` constraint is the
correctness backstop; the app ALSO runs the `core` overlap query inside
`withOrgContext` to (a) power the pre-submit conflict preview (`checkConflicts`,
commits nothing) and (b) build the **rich conflict result** naming the colliding
resource(s) + existing windows. On a `23P01` from a genuine race, the app catches
it and re-queries to return the same rich `ConflictHit[]`. The app query is for UX
and messaging; the constraint is for truth. They share one definition of overlap
(half-open / `tstzrange(start,end,'[)')`) so preview and DB verdict cannot disagree.

**Org-scoping a table-global constraint:** `resource_id` is a globally-unique uuid
belonging to exactly one org, so two orgs' bookings live in disjoint `resource_id`
partitions of the GiST index and cannot collide — no cross-org false-block, no
information flow. Composite FKs `(child_id, org_id) → parent(id, org_id)` (the
membership/auth_credential pattern) make "resource_id implies one org" structural.
All three tables still carry `org_id` + ENABLE+FORCE RLS + 4 fail-closed policies
+ `aeroops_app` grant (ADR-0001). RLS governs *which rows a session may touch*; the
constraint governs *which rows may coexist* — orthogonal, both apply.

**Reservation↔resource model:** `reservation` (canonical window, status
booked/cancelled, `CHECK end_at>start_at`), `reservation_resource` join (carries
denormalized `during`+`status`; where the EXCLUDE lives), `resource` (kind enum,
nullable subtype cols, UNIQUE `(id,org_id)`). The single sanctioned write path
derives the join `during`/`status` from the parent in the same transaction.

**Forward-compat:** `resource.kind` enum is core-sourced (the `MEMBERSHIP_ROLES`
pattern); Slice 1 populates only aircraft + instructor; adding sim/room/vehicle is
a data change, not an engine change (the constraint is subtype-agnostic).

## Consequences
- No-double-book is engine-enforced and unforgeable from app code (same posture as
  RLS for isolation). Adds a `btree_gist` dependency (prod + harness; standard on
  Neon/Supabase, bundled in pglite). Dropping the constraint later is a one-way door.
- Range denormalization onto the join is contained by the single-write-path
  invariant + a parent/child range-equality property test.
- **pglite is single-threaded WASM** — true OS-thread concurrency isn't reproducible;
  the property suite proves serialization by two-transaction interleaving + bulk
  rejection. A real-Postgres concurrency smoke is deferred to Slice 0.4 CI.

## Invariants (reviewer enforces)
1. No two committed `booked` join rows share a `resource_id` + overlapping `during`
   (`[)`); EXCLUDE-enforced, property-asserted.
2. One sanctioned create path through `@aeroops/api` inside `withOrgContext` behind
   `schedule:create_reservation`; nothing else inserts join rows.
3. `core` predicate stays pure (no I/O); advisory only, never the sole write gate.
4. Three new tables `org_id`-scoped + ENABLE+FORCE RLS + 4 policies + composite FKs
   on both join edges; `apps/web` never imports `@aeroops/db`.
5. Conflict detection ships property tests; the harness loads `btree_gist`.
6. Half-open `[start,end)` everywhere (core, `tstzrange '[)'`, UI); adjacency ≠ conflict.

## Alternatives considered
- **App-level SERIALIZABLE / `FOR UPDATE` / advisory-lock** (architect's lean):
  retained as the documented fallback only if a target Postgres lacks `btree_gist`
  (swap enforcement to `pg_advisory_xact_lock(hashtext(org_id||resource_id))` at the
  single write path; core predicate + model unchanged). Rejected as primary because
  it trades a declarative DB guarantee for per-call-site discipline.
- **`org_id WITH =` inside the exclusion / constraint on `reservation` directly:**
  rejected (redundant / cannot express per-resource exclusion for multi-resource).

See [[aeroops-tenant-isolation-invariants]].
