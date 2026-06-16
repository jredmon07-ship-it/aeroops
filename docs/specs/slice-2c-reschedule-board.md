# BUILD SPEC — Slice 2c: Drag-drop reschedule + dispatch board (SCHED-2c)

**Status:** Approved-pending. Builds on ADR-0004 (FROZEN conflict engine), ADR-0005 (FROZEN policy gate), ADR-0006 §6 (reschedule = cancel-occurrence + recreate through `gatedCreateOccurrence`). **No new ADR; no schema change.**

**One-line scope:** add `rescheduleReservation` (atomic cancel-original + recreate-at-new-slot through the shared `gatedCreateOccurrence`; refuse-and-keep-original on either gate; detach from series; audited) + a single-day **dispatch board** (resources as rows, time horizontal, blocks) wired so dragging a block reschedules it. No new persistence, no week view, no dispatch/Hobbs/optimizer.

**Invariants:** every query org-scoped via `withSessionOrgContextWithDb` (RLS backstop); the reschedule write goes through the ONE sanctioned `gatedCreateOccurrence` (no parallel insert, no duplicated gate logic); cancel + create both audited; reschedule atomic (all-or-nothing, one tx); `apps/web` never imports `@aeroops/db`.

## 1. Data model
**NONE.** `reservation.seriesId` already nullable (detach = set NULL); `cancelledAt`/`cancelledBy` exist; `reservation_resource` partial EXCLUDE `WHERE status='booked'` means flipping the original's join rows to cancelled in-tx frees its window. No migration, no RLS change, zero `packages/db` diff. Linkage lives in existing `audit_log.metadata`.

## 2. API — `rescheduleReservation` (new `packages/api/src/scheduling/reschedule-reservation.ts`)
Two forms (`reschedule...` + `...WithDb(db,session,input,opts?)` with injectable `opts.now`).
Input: `{ reservationId, newStartAt:Date, newEndAt:Date, newResourceIds?:string[] (default: original's resources) }`.
Result (additive; reuses frozen `ConflictHit`/`PolicyViolationView`):
```
RescheduleResult =
  | { ok:true; reservation: CreatedReservation }
  | { ok:false; reason:'not_found' }
  | { ok:false; reason:'conflict'; conflicts: ConflictHit[] }
  | { ok:false; reason:'policy'; violations: PolicyViolationView[] }
  | { ok:false; reason:'conflict_and_policy'; conflicts; violations }
```
authz `schedule:create_reservation` FIRST. Validate `newEndAt>newStartAt` + `newResourceIds` (reuse `parseReservationWindow`/`reservationWindowSchema`) → throw `ValidationError`.
**Transaction shape (ONE `withSessionOrgContext` tx):**
1. Load original (RLS). Not visible OR already cancelled → `{ok:false,reason:'not_found'}`, no write. Load its current resourceIds + notes.
2. `targetResourceIds = newResourceIds ?? originalResourceIds` (dedup, ≥1).
3. Cancel original in-tx (UPDATE reservation→cancelled + cancelledAt/by; UPDATE its reservation_resource→cancelled — frees the window).
4. `gatedCreateOccurrence(tx, sess, db, {startAt:newStartAt, endAt:newEndAt, resourceIds:targetResourceIds, notes:original.notes, seriesId:undefined}, now)` → series detaches (series_id NULL); re-clears BOTH gates.
5. **On gate refusal** (`gatedCreateOccurrence` returns ok:false): THROW a private `RescheduleRefused` sentinel carrying the result to force Drizzle ROLLBACK (so the cancel is undone, original stays booked), catch outside the tx, return that result. (A plain `return` from inside the callback would COMMIT the cancel — the throw-to-rollback is load-bearing.)
6. **On success:** commit (original cancelled + new created + audits). Return `{ok:true,reservation}`.
7. **Race (`OccurrenceRaceError`/23P01 during step 4 INSERT):** poisons tx → caught outside → original preserved (rolled back) → `reProbeInFreshTx` → `{reason:'conflict',conflicts}`. Mirrors createReservation catch-and-requery.
**Audit:** `reservation.cancelled` (metadata `{reason:'reschedule', rescheduledTo:newId}`) + the `reservation.created` gatedCreateOccurrence writes + a dedicated `reservation.rescheduled` row (`entityId:newId`, metadata `{rescheduledFrom:originalId, oldWindow, newWindow}`) for explicit linkage — keeps gatedCreateOccurrence untouched. [VERIFY-compliance #2].
Export from index.ts + types.ts under a "Slice 2c" block. Frozen exports untouched.

## 3. Board data contract (pure read + the one reschedule write)
Route `/o/[slug]/schedule/board`, capability `schedule:access`; add to shell nav (hasCapability-gated). RSC resolves `?date=` (default today, local) and fetches in parallel `listReservations({from:startOfDay,to:endOfDay})` (cancelled excluded by default) + `listResources({})`. Pass to a `'use client'` board. Server action `rescheduleAction` in schedule/actions.ts.
**Grid:** rows = active resources (kind then displayName); horizontal = the day, 15-min snap; block left/width = (startAt-dayStart)/dayDuration, clamp midnight-spanning to edges. **Multi-resource reservation = one block per resource row it occupies, sharing reservationId; dragging any reschedules the whole reservation.** Cancelled never rendered.
**Drag wiring:** drop → snap to 15-min → `newStartAt`, `newEndAt = newStartAt + originalDuration`; cross-row drag → swap dragged resource for drop-target resource in `newResourceIds` (keep others); same-row → omit newResourceIds. Optimistic move (pending styling) → `rescheduleAction` → ok:true confirm/reconcile (original id gone, new id in); ok:false/ValidationError → revert (snap back) + surface reason reusing 2a/2b conflict+policy renderers.

## 4. UI states
Board: loading (skeleton grid) / empty-no-reservations (overlay) / empty-no-resources (+manage link if cap) / error (Alert) / no-permission (redirect to no-access). Drag: read-only viewer (schedule:access without create) → blocks not draggable (aria-disabled); drag-in-progress (snap targets highlighted); drop-submitting (pending+aria-busy); success (block settles + aria-live "Reservation moved to [time]"); refused-conflict / refused-policy / refused-both (snap back + respective renderer); not_found (snap back + "no longer exists" → re-fetch); validation (snap back + "Invalid time range"). hasCapability('schedule:create_reservation') passed as prop (UI-only; server action requireCapability is the gate).

## 5. Edge cases
Reschedule onto own/overlapping-self slot succeeds (cancel frees window first — highest-value test). Multi-resource all-or-nothing (any target collides → whole reschedule refused, original intact). Cross-row resource swap. Series occurrence → detaches (series_id NULL; listSeriesOccurrences no longer returns it, original shows cancelled). Race → original preserved. Tenant isolation: cross-org reservationId → not_found; cross-org newResourceIds → ValidationError (rollback restores original). Past reschedule: NO bespoke past-block; rely on policy gate (minAdvance/blackout); board MAY visually restrict drop ≥ now for UX [VERIFY-compliance #1]. Notes preserved; only window+resources editable. No money/Hobbs.

## 6. Test list
**Integration (pglite, real EXCLUDE+RLS), via rescheduleWithDb + injected now:** (1) happy: original cancelled, new booked at new window series_id NULL, 3 audit rows; (2) refused-conflict → original INTACT (still booked, no new row, no audit) — full rollback; (3) refused-policy → intact; (4) conflict_and_policy → intact; (5) not_found cross-org; (6) **overlapping-self slot succeeds** (window freed first — highest value); (7) zero-delta same-slot succeeds; (8) multi-resource: target conflicts only on instructor → whole reschedule refused, neither moved; (9) resource swap to free aircraft → ok; (10) series detach → new row series_id NULL, listSeriesOccurrences excludes it; (11) validation end<=start throws; (12) cross-org/inactive newResourceIds throws, original intact; (13) already-cancelled original → not_found; (14) authz (no create cap → Forbidden; null → Unauthenticated).
**Property (extends ADR-0004 suite):** (15) reschedule never produces a double-book (randomized existing + target → no two booked join rows share resource+overlapping during); (16) atomicity: any ok:false → DB byte-identical to pre-call; any ok:true → exactly one row cancelled + one new booked.
**Race:** (17) competing booking commits into target between pre-check and INSERT → OccurrenceRaceError → conflict, original preserved.
**Regression:** (18) all existing create/cancel/series/list/conflict suites pass UNCHANGED (gatedCreateOccurrence reused, not modified).
**Board (pure unit):** (19) block left/width positioning incl. midnight clamp; (20) multi-resource fan-out to N blocks sharing id; (21) cancelled excluded; (22) drag math → 15-min-snapped newStartAt, duration preserved. Interactive pointer-drag e2e deferred if no harness.

## 7. Build order
1. API `reschedule-reservation.ts` + RescheduleResult + index export; tests #1–#18 (incl. property #15–16). 2. Board read page + rescheduleAction + nav + pure `_utils/board-layout.ts` (unit tests #19–22). 3. Board grid + drag-drop component (per product-designer board UX). 4. Reschedule wiring (optimistic → action → confirm/revert reusing 2a/2b renderers).

## 8. Flags
No new ADR (append the reschedule atomicity + audit-linkage convention to ADR-0006 §6). **[VERIFY-compliance #1]** retroactive reschedule — does Part 141 prohibit moving a scheduled event into the past / require special retention? (belief: paired cancelled+created+rescheduled audit suffices; rely on policy gate; no bespoke past-block). **[VERIFY-compliance #2]** confirm the dedicated `reservation.rescheduled` linkage row is the desired records representation. Both non-blocking; route to compliance at QA.
