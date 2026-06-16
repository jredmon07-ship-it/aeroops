# ADR-0006 — Recurring reservations: representation, timezone-correct expansion, partial-create

**Status:** Accepted (Phase 1, Slice 2b / SCHED-2b; decisions ratified by conductor 2026-06-16). **Owners:** CTO, architect, scheduling-engineer. **Builds on:** ADR-0001 (RLS/`withOrgContext`), ADR-0003 (capability gate), ADR-0004 (conflict engine — **FROZEN**), ADR-0005 (booking-policy gate — **FROZEN**). Extends both gates; modifies neither.

## Context
ADR-0005 §6 committed the shape: each expanded occurrence clears BOTH gates through the same single create path. 2b makes it real. Three hard problems: (1) **timezone-correct expansion** — naive `+7×86_400_000ms` drifts a 10:00-local lesson by an hour across DST; (2) **partial-create** — a series is not all-or-nothing (book 9 of 10 free weeks), but a failed INSERT (`23P01`) poisons its transaction; (3) **series lifecycle** — cancel a whole series without an edit path.

## Decision

### 1. Representation — structured columns, weekly-by-weekday, hard-capped. NO RRULE.
`reservation_series` stores the rule as structured columns: `freq` ('weekly' only; daily = all-7-weekdays subset), `weekdays smallint[]` (ISO 1–7), `interval_weeks` (≥1), bounded end = `count` (1–52) **XOR** `until_date`, `local_start_time`, `duration_minutes` (>0, same-day), `iana_tz`, `resource_ids uuid[]` (≥1), `notes`, `status` ('active'/'cancelled'), audit/`created_by` columns. **Hard cap ≤52 occurrences**, enforced in the pure expander and mirrored by a `count<=52` CHECK; an `until` rule exceeding 52 truncates with a `truncatedByCap` flag (not an error). **Explicitly NO** monthly/yearly/nth-weekday/BYSETPOS/EXDATE/per-occurrence overrides/RRULE strings. Reversible: a nullable `rrule` column + translator can be added later if ever needed.

### 2. Timezone-correct expansion — pure core, injected resolver, UTC downstream.
Expansion is a NEW pure function `expandRecurrence` in `@aeroops/core` (no runtime tz dependency — `@aeroops/core` stays dep-free). It takes the rule + an **injected `resolveZoned(localParts, tz) → {utcMs, status:'valid'|'nonexistent'|'ambiguous'}`** converter (supplied at the API boundary, exactly as `now` is injected into the policy predicate) + injected `now`. Core does plain calendar arithmetic (which dates qualify, in order, to the cap), calls the resolver per occurrence to get UTC `{startMs,endMs}`, and emits UTC instants. **The conflict/policy gates and storage stay UTC-only and untouched** — the seam is: tz lives in expansion, UTC lives in conflict/policy/storage.

**DST edges (defined, deterministic, reported — never silent):**
- **Nonexistent local time** (spring-forward gap): occurrence **dropped**, reported in `skippedLocalDates` (reason `nonexistent_local_time`). Refusing is honest vs silently shifting "10:00 local" intent.
- **Ambiguous local time** (fall-back, occurs twice): resolve to the **earlier (pre-transition)** instant, deterministically. Not skipped.
- **Everyday case:** a 10:00 lesson stays 10:00 local across both transitions (offset shifts, wall-clock fixed) — the DST-stability property test asserts this directly.

**Timezone source (RESOLVED):** the series stores its own `iana_tz`; the web form defaults it from the browser-detected zone (`Intl…resolvedOptions().timeZone`) and the operator confirms it. **No `org`/`location` schema change in 2b.**

### 3. Partial-create + skip-report — per-occurrence independence via SAVEPOINTS in one outer tx.
Series-create expands to N candidates; each runs through the SAME gated create logic; **clear occurrences commit, gated occurrences skip with a reason, the call returns a per-occurrence report.** A whole-request failure (auth/validation/cap-exceeded) is thrown, distinct from per-occurrence skips. A series where ALL occurrences skip is still `ok:true` (the create succeeded; zero booked + reasons).

**Transaction shape (RESOLVED — Option B, savepoints):** `createSeries` opens ONE outer `withSessionOrgContext` tx (GUC set LOCAL once, visible to all savepoints). It inserts the `reservation_series` row, then runs each occurrence's gated body inside a **nested transaction = SAVEPOINT** (`tx.transaction(...)`). On a `23P01`/policy refusal, the savepoint rolls back and the outer tx stays alive — that occurrence is recorded skipped, the loop continues. The outer tx commits the series row + all created occurrences + their audit rows **atomically** (no orphan partial series on a mid-loop crash) while keeping each occurrence's verdict independent. The ADR-0004 rich-conflict re-probe runs per occurrence after `ROLLBACK TO SAVEPOINT` within the live outer tx. **Fallback (Option A):** per-occurrence top-level transactions, used ONLY if savepoints prove unworkable in the pglite harness — loses series atomicity; the builder must report if they fall back.

**Keystone reuse (invariant 1):** the per-occurrence gated body is the SAME shared internal helper single-create uses (resource validation → conflict pre-check → policy probe → INSERT reservation+joins+audit → 23P01 catch). The 2b refactor extracts that body from `_createReservationImpl` into `gatedCreateOccurrence(tx, sess, window, resourceIds, now, seriesId?)`, called by BOTH `createReservation` (1×) and `createSeries` (N×). NO parallel insert that skips a gate. Single-create must remain byte-equivalent (its test suite passes unchanged).

### 4. Series lifecycle — nullable `series_id` FK; cancel-one reuses existing; cancel-series future-only; NO edit.
Each occurrence is a `reservation` row with nullable `series_id` + composite FK `(series_id, org_id) → reservation_series(id, org_id)` **ON DELETE SET NULL** (preserve audited occurrence rows if a series is deleted). `series_id IS NULL` = one-off, byte-identical to Slice 1/2a. Single-occurrence cancel reuses `cancelReservation` unchanged. **New `cancelSeries(seriesId)`** cancels all still-`booked` occurrences with `start_at > now` (future-only — past occurrences are records, may be dispatched/billed later), flips their join rows (frees windows), writes one audit row per cancelled reservation + one `series.cancelled`. Idempotent on an already-cancelled series. **NO series edit** (cancel + recreate).

### 5. Isolation invariants.
`reservation_series`: `org_id` + `ENABLE`+`FORCE` RLS + 4 fail-closed policies + `UNIQUE (id, org_id)` + composite FKs (`created_by`/`cancelled_by` → app_user same-org) + `aeroops_app` grant. `reservation.series_id` composite FK `(series_id, org_id)`. All reads inside `withSessionOrgContext`; `apps/web` never imports `@aeroops/db`. Migration **0004** staged + human-gated, NEVER auto-applied.

### 6. Forward-compat.
2c reschedule = cancel-occurrence + recreate through `gatedCreateOccurrence`. The optimizer (Slice 4) is an advisory candidate producer that funnels each accepted candidate through the same helper. Single-write-path invariant holds — `createSeries` loops the existing path, introduces no new write path.

## Consequences
- `create-reservation.ts` is refactored (gated body extracted); reviewer confirms single-create byte-equivalence (its all-or-nothing contract, catch-and-requery, audit).
- Series-create is partial by design; the per-occurrence report is the UI contract.
- Savepoints add bounded per-occurrence overhead (≤52 cap); pglite supports savepoints, so partial-create is property-testable.
- tz correctness lives in core behind an injected resolver; gates stay tz-unaware.
- One new table + one nullable column + migration 0004 (human-gated). Non-breaking: `series_id IS NULL` reproduces prior behavior.

## Invariants (reviewer enforces)
1. One sanctioned write path, shared body — series-create runs each occurrence through the SAME `gatedCreateOccurrence`; no gate-skipping parallel insert.
2. Expansion pure + tz/now-injected; advisory only.
3. Gates stay UTC + FROZEN — `overlap.ts`, `policy.ts`, EXCLUDE, `ConflictHit`/`PolicyViolationView` untouched; only additive series/report types.
4. DST-correct + deterministic — wall-clock fixed across DST; gap dropped+reported, fall-back→earlier; property-tested (count/until/weekday/interval/cap/no-past/DST-stability/determinism).
5. Per-occurrence isolation via savepoints in one outer tx; series + created occurrences atomic; LOCAL GUC never re-set/leaked.
6. `reservation_series` tenant-isolated (full pattern); `reservation.series_id` composite FK; web never imports db.
7. NO arbitrary RRULE, NO series edit, NO per-occurrence override.
8. Cancel-series future-booked-only + audited; single cancel reuses `cancelReservation`.
9. Partial-by-design; whole-request failures throw (auth/validation/cap), not per-occurrence skips.

## Resolved decisions (were open questions)
(a) `series_id` **ON DELETE SET NULL**. (b) Transaction shape **Option B (savepoints)**, A as fallback. (c) Zero-future/all-skipped: **still create the series row** (audited intent), `ok:true` with the report. (d) DST-nonexistent + past occurrences are generated-then-dropped (reported via `skippedLocalDates`/omission), not specially charged against the count budget beyond generation — documented so the preview matches. (e) cancel-series boundary **`start_at > now`**. (f) tz library: **injected `Intl`-based offset resolver** at the API boundary (no heavy core dep); builder picks the concrete impl, must handle gap/ambiguous per §2. (g) `weekdays`/cardinality bounds **DB-CHECK**; `resource_ids` element same-org enforced by the **create path** (rejects cross-org/unknown/inactive/wrong-kind). (h) `listSeriesOccurrences` is a **dedicated read**.

## Alternatives considered
RRULE string (rejected — opaque, unbounded surface); materialize-only without a series row (rejected — fuzzy cancel); one flat tx (rejected — first 23P01 aborts all siblings); per-occurrence top-level txns (fallback only — loses series atomicity); expand at API boundary (rejected — breaks pure-core/property-test discipline); cancel-series incl. past (rejected — records integrity).

## Open question routed to compliance (non-blocking)
**[VERIFY] Part 141:** does a *series-level* create/cancel need its own retained record beyond the per-occurrence `reservation.created`/`reservation.cancelled` audit rows we already write? Belief: per-occurrence audit suffices (each occurrence is a normal reservation); compliance confirms at the QA gate. Do not invent the rule.

## Addendum — Slice 2c reschedule (2026-06-16)
Per §6 forward-compat, **rescheduling one reservation = cancel-original + recreate through the shared `gatedCreateOccurrence`**, recorded here rather than in a new ADR (no new write path, no new gate, no schema change; `series_id` already nullable). Atomicity rule: in ONE `withSessionOrgContext` tx, cancel the original (freeing its window so an overlapping-self move does not self-conflict), then recreate at the new window/resources; if either gate refuses, **throw-to-rollback** so the original stays intact and booked (a plain return would commit the cancel). A rescheduled occurrence **detaches** from its series (`series_id` NULL). Audit linkage: `reservation.cancelled` (metadata `reason:'reschedule', rescheduledTo`) + the create's `reservation.created` + a dedicated `reservation.rescheduled` row carrying `rescheduledFrom`/window deltas. See `docs/specs/slice-2c-reschedule-board.md`.

## Links
ADR-0001, ADR-0003, ADR-0004 (FROZEN), ADR-0005 (FROZEN; §6 seeds this), THE-BIBLE §2.1/§10.
