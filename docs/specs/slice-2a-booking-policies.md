# BUILD SPEC — Slice 2a: Booking Policies (SCHED-2a)

**Date:** 2026-06-16 · **Phase/Slice:** Phase 1 / Slice 2a · Tickets SCHED-2a.1, 2a.2, 2a.3.
**Status:** Approved-pending. Implements ADR-0005. Conflict engine (`overlap.ts`, EXCLUDE, `ConflictHit`/result shapes) is **extended additively, never modified.**

**One-line scope:** add an optional per-resource booking policy + per-resource blackout windows, evaluated by a new pure `@aeroops/core` predicate that runs *beside* (never replacing) the conflict probe on the single create path, surfaced in an additively-extended advisory result and a policy admin UI. Absent policy ⇒ Slice-1 behavior preserved byte-for-byte.

> ## ⚠️ SCOPE AMENDMENT — approved 2026-06-16 (maintainer)
> **Required-tags / booking eligibility is DEFERRED out of Slice 2a** to a focused follow-up slice (which also builds the member-tag admin surface). Slice 2a ships **four rules only: max duration, max advance, min lead time, blackout windows.**
>
> Therefore, in this spec, builders **OMIT** all of the following (they move to the follow-up):
> - `booking_policy.required_tags` column — **do not create.**
> - `membership.booking_tags` column — **do not add.**
> - `'missing_required_tag'` violation kind — **omit** from `POLICY_VIOLATION_KINDS` (the tuple has 4 kinds in 2a).
> - `listOrgBookingTags` command + the required-tags field in the policy editor + the missing-tag preview copy — **do not build.**
> - The `actorTags` parameter of `evaluateBookingPolicy` and the actor-tag load on the create path — **omit.**
>
> Everything else below stands. The `[VERIFY-1/2]` (tag) flags and `[DEFER-C/F]` become moot for 2a (revisit in the follow-up). `evaluateBookingPolicy(candidate, policy, blackouts, now)` — no `actorTags` param in 2a.

## 0. Invariants every builder holds
1. **Tenant isolation:** new tables (`booking_policy`, `resource_blackout`) carry `org_id`, `ENABLE`+`FORCE` RLS, 4 fail-closed policies, composite FK `(child_id, org_id) → parent(id, org_id)`, `aeroops_app` grant — exact mirror of 0002. `membership.booking_tags` is added to an already-RLS'd table.
2. **Conflict engine FROZEN** — do not touch `overlap.ts`, EXCLUDE, `runConflictProbe`, `ConflictHit`, or the `{ok:false, reason:'conflict', conflicts}` shape.
3. **Single sanctioned write path** — policy eval runs inside `createReservation` within `withSessionOrgContext`, behind `schedule:create_reservation`.
4. **Pure core** — `evaluateBookingPolicy` pure (no I/O, no clock; `now` injected). Half-open `[start,end)` blackout overlap reusing `intervalsOverlap`. **Property-based tests (hard guardrail).**
5. **Records integrity** — policy upsert/clear + blackout create/delete each write one `audit_log` row. Refused reservation writes none.
6. **Free-text tags only** — no computed FAA currency/Part 61/141 (Phase 3 Training). [VERIFY-1].
7. **Additive, back-compatible** — every Slice-1 caller/type/test still passes unchanged.
8. **`apps/web` imports only `@aeroops/api`.**

## 1. Data model + migration 0003 (SCHED-2a.1)

### 1.1 Core enum (`packages/core/src/scheduling/enums.ts`)
`POLICY_VIOLATION_KINDS = ['max_duration_exceeded','too_far_in_advance','insufficient_lead_time','blackout_overlap','missing_required_tag']`. Export `PolicyViolationKind` + `isPolicyViolationKind`. **NOT a pgEnum** (runtime/core only, never stored). No new DB enum in 2a.

### 1.2 Table `booking_policy` (per-resource, 0..1) — `packages/db/src/schema/booking-policy.ts`
Columns: `id` uuid PK; `org_id` uuid NOT NULL; `resource_id` uuid NOT NULL; `max_duration_minutes` int NULL (CHECK >0); `max_advance_days` int NULL (CHECK ≥0); `min_advance_minutes` int NULL (CHECK ≥0); `required_tags` text[] NOT NULL DEFAULT `'{}'`; `created_at`/`updated_at` timestamptz.
Constraints: FK `(org_id)→org(id)` CASCADE; composite FK `(resource_id, org_id)→resource(id, org_id)` **ON DELETE CASCADE** (policy is a child attribute of the resource); `UNIQUE (resource_id)`; the three int CHECKs. Index `(org_id, resource_id)`.

### 1.3 Table `resource_blackout` (per-resource, 0..N) — `packages/db/src/schema/resource-blackout.ts`
Reuses the existing `tstzrange` customType. Columns: `id` uuid PK; `org_id` uuid NOT NULL; `resource_id` uuid NOT NULL; `during` tstzrange NOT NULL (built ONLY as `tstzrange($start,$end,'[)')`); `reason` text NULL; `created_by` uuid NOT NULL; `created_at` timestamptz.
Constraints: FK `(org_id)→org(id)` CASCADE; composite FK `(resource_id, org_id)→resource(id, org_id)` CASCADE; composite FK `(created_by, org_id)→app_user(id, org_id)` RESTRICT; CHECK `during_nonempty` (`lower IS NOT NULL AND upper IS NOT NULL AND lower < upper`). Index `(org_id, resource_id)`. **No GiST/EXCLUDE** — blackout overlap is a pure-core advisory check, not a DB constraint; two blackouts may overlap freely. Blackout blocks only *reservations*, enforced on the create path.

### 1.4 Column add `membership.booking_tags text[] NOT NULL DEFAULT '{}'`
Read on the create path from the *acting session user's* membership row (org-scoped by RLS). [VERIFY-1]/[DEFER-C]: 2a uses the creator's tags (no "on behalf of" pilot field exists yet).

### 1.5 Migration `0003_booking_policies.sql` (+ `.down.sql`)
Human-gated banner like 0002 (prereqs 0000+0001+0002). Up: create both tables (+composite FKs/UNIQUE/CHECKs) → indexes → `ALTER membership ADD booking_tags` → ENABLE+FORCE RLS on both new tables → 4 named RLS policies each (same GUC predicate as 0002) → grants. Down: reverse dependency order, mirror 0002.down. btree_gist already present; no new enum.

### Schema test list (`booking-policies-schema.test.ts`, pglite harness — all integration)
0003 applies atop 0000+0001+0002; `booking_policy` UNIQUE(resource_id) rejects 2nd; int CHECKs reject 0/-1; composite FK rejects cross-org resource_id; `resource_blackout` CHECK rejects empty/inverted range; blackout composite FKs reject cross-org resource_id & created_by; `membership.booking_tags` defaults `{}`/stores text[]; **RLS fail-closed** (0 rows GUC-unset) + **RLS isolation** (org A can't see org B policy/blackout rows) on both new tables.

## 2. API contracts (SCHED-2a.2)

### 2.1 Pure core predicate `packages/core/src/scheduling/policy.ts`
Times epoch ms (mirrors overlap.ts). `BookingPolicy {maxDurationMinutes:number|null, maxAdvanceDays:number|null, minAdvanceMinutes:number|null, requiredTags:readonly string[]}`. `BlackoutWindow {start,end}`. `PolicyCandidate {resourceId, start, end}`. `PolicyViolation` discriminated by `kind` (carries the limit + actual values; `blackout_overlap` carries the blackout bounds; `missing_required_tag` carries `missingTag`). 
`evaluateBookingPolicy(candidate, policy: BookingPolicy|null, blackouts, actorTags, now): PolicyViolation[]`.
Semantics (all violations collected, no short-circuit): `policy===null` ⇒ `[]` for the four policy rules, **but blackouts still evaluated if present** ([DEFER-D]: blackout is a resource-availability fact independent of a policy row). `max_duration_exceeded` iff `(end-start)/60000 > limit` (equal ⇒ OK). `too_far_in_advance` iff `start-now > days*86_400_000` (equal ⇒ OK). `insufficient_lead_time` iff `start-now < minutes*60_000` (equal ⇒ OK; past start ⇒ violation). `blackout_overlap` per blackout iff `intervalsOverlap(...)` (reuse; adjacency not a violation). `missing_required_tag` per tag in `requiredTags \ actorTags` (exact, case-sensitive — [VERIFY-2]). Deterministic violation order; property tests assert input-permutation order-independence of the violation *set*.

### 2.2 Gated create path — additive extension of `create-reservation.ts`
New step **3a.5 (policy probe)** inside the tx, after resource validation, alongside conflict pre-check (3b): per resource load `booking_policy` (0..1) + `resource_blackout` rows overlapping `[start,end)` (filtered SQL `during && tstzrange(...)`) + acting user's `membership.booking_tags`; capture `now` once at impl top (injectable in `*WithDb`); run `evaluateBookingPolicy`, collect all violations. **Refusal:** refuse if conflicts OR violations present, before any INSERT; if both, report both. INSERTs (3c) only when both gates clean. EXCLUDE remains the conflict race backstop (3d unchanged); policy has no DB backstop.

**Additive result union (`types.ts`; existing two arms unchanged):**
```
CreateReservationResult =
  | { ok:true; reservation: CreatedReservation }
  | { ok:false; reason:'conflict'; conflicts: ConflictHit[] }
  | { ok:false; reason:'policy'; violations: PolicyViolation[] }
  | { ok:false; reason:'conflict_and_policy'; conflicts: ConflictHit[]; violations: PolicyViolation[] }
```
Back-compat: callers checking `reason==='conflict'` keep working (that arm is byte-identical, still produced when only conflicts exist). `PolicyViolation` re-exported from `@aeroops/api`. [DEFER-E]: four-arm additive union (recommended, back-compat) vs single breaking `'blocked'` arm — ADR-0005 ratifies additive.

### 2.3 Advisory preview — additive extension of `check-conflicts.ts`
Keep `checkConflicts` exported (back-compat); it now also runs the policy probe and merges, so the UI makes ONE combined call. `CheckConflictsResult` extended with the same four arms. Same authz (`schedule:create_reservation`), `withSessionOrgContext`, pure read (no writes/audit). `now` defaults to injected clock. Authz/validation error posture unchanged (Forbidden/Unauthenticated/ValidationError thrown).

### 2.4 Admin commands (`packages/api/src/scheduling/`, app + `*WithDb` forms, authz `schedule:manage_resources`, audited)
`getBookingPolicy({resourceId})→BookingPolicyView|null`; `upsertBookingPolicy({resourceId, max*, requiredTags?})→{ok,policy}|{ok:false,'not_found'}` (audit `booking_policy.upserted`); `clearBookingPolicy({resourceId})→{ok}|{not_found}` (reverts to open booking; audit `booking_policy.cleared`); `listBlackouts({resourceId})→BlackoutView[]`; `createBlackout({resourceId,startAt,endAt,reason?})→{ok,blackout}|{not_found}` (ValidationError on `endAt<=startAt`; audit `resource_blackout.created`; does NOT touch existing reservations — [VERIFY-3]); `deleteBlackout({blackoutId})→{ok}|{not_found}` (audit `resource_blackout.deleted`); `listOrgBookingTags({})→string[]` (distinct union of org `membership.booking_tags`, sorted; powers required-tags autocomplete). Validation errors thrown distinct from `not_found` results. [DEFER-G]: enrich returned policy violations with `resourceDisplayName` at the API layer (core stays `resourceId`-only).

## 3. UI states + data contract (SCHED-2a.3)
Detailed visuals by product-designer at build time; this fixes states + contract. Extends `docs/design/slice-1-scheduling-ui.md`.

### 3.1 Policy editor — extends `/o/[slug]/schedule/resources` (gated `schedule:manage_resources`)
Per-resource "Booking rules" surface. In: `getBookingPolicy`, `listBlackouts`, `listOrgBookingTags`. Out: `upsert/clearBookingPolicy`, `create/deleteBlackout`. Fields: max duration (min, ≥1), max advance (days, ≥0), min lead (min, ≥0), required tags (multi free-text + autocomplete), blackout windows (datetime ranges + reason; add/remove with delete-confirm). States: loading / empty ("No booking rules — open for any available time") / populated / load-error / save-error (inline, strip `[scheduling]`; `not_found`) / saving / success / permission-denied (redirect). Primary action: **Save booking rules**.

### 3.2 New-reservation combined preview — extends `/o/[slug]/schedule/new`
`use-conflict-check.ts` (400ms debounce) now calls the combined `checkConflicts`. Banner states: hidden / checking / **clear** ("available and meets all booking rules") / **conflict only** (existing) / **policy only** ("does not meet the booking rules:" + per-`kind` bullets) / **conflict+policy** (both sections) / preview-error (submit stays enabled). Per-kind copy: duration → "Maximum booking length is {limit} min; this is {actual} min."; advance → "Bookings can be made at most {limitDays} days ahead."; lead → "Bookings require at least {requiredMinutes} min lead time."; blackout → "{resourceDisplayName} is unavailable {HH:mm}–{HH:mm} (blackout)."; missing tag → "This resource requires the '{missingTag}' tag, which you do not have." Blocked submit re-renders with hard-block framing; submit NOT disabled by preview (advisory; create path is the gate). Resource names resolved client-side via `buildResourceMap`. A11y mirrors Slice-1 §4 (`role=alert`/`aria-live`).

## 4. Edge cases
Tenant isolation: cross-org policy/blackout FK-rejected + RLS-hidden; `listOrgBookingTags` org-scoped; actor tags `WHERE user_id=sess.userId` + RLS; org-B blackout never affects org-A create. Half-open: blackout adjacency not a violation; containment/exact-equal are violations; multiple overlapping blackouts → one each. Boundaries: duration/advance/lead exactly equal ⇒ OK (strict `>`/`<`). Time: all comparisons epoch ms (UTC-safe); `max_advance_days` = fixed 24h days ([VERIFY-4]). Concurrency: create path re-reads policy+blackouts in-tx; a blackout committed by a concurrent tx after our read but before our INSERT is not caught — acceptable for an advisory rule, no SERIALIZABLE ([DEFER-I]). Records: policy/blackout mutations audited; refused reservation writes no audit row. Degenerate: dedup `required_tags`; reject empty-string tag; cap `reason` length (~500).

## 5. Test list (PB=property, U=unit, I=integration)
**2a.1 schema (I):** as §1 test list.
**2a.2 core `policy.test.ts`:** U — null policy ⇒ []; each rule isolated over/at/under; blackout adjacency both directions; multi blackout/tag; all-rules-at-once (no short-circuit); `now` determinism; equality boundaries. **PB (hard guardrail):** PB-1 no-policy⇒no-violations (blackouts-with-null-policy only emit blackout_overlap); PB-2 order-independence (permute blackouts/tags ⇒ same set); PB-3 blackout adjacency never a violation; PB-4 blackout_overlap ⟺ intervalsOverlap; PB-5 duration monotonicity (boundary flips once); PB-6 missing-tag set == requiredTags\actorTags; PB-7 monotone-in-now for advance/lead (flips once).
**2a.2 api (I):** policy-violating create → `ok:false reason:'policy'`, no rows/audit written; clean create on policied resource → ok:true + audit; **no-policy resource == Slice 1** (regression); both gates → `conflict_and_policy` both arrays, no write; conflict-only on satisfied-policy resource → `'conflict'` (preserved); blackout overlap → policy, adjacency → ok; missing tag → policy, with tag → ok; combined `checkConflicts` returns both, writes nothing, all four arms reachable; tenant isolation on new tables; each admin command writes exactly one audit row; authz matrix (manage_resources for admin commands; create_reservation unchanged); validation thrown distinct from policy result. (Optional PB-8 DB bulk: every committed booked window satisfies its resource's policy.)
**2a.3 web:** each banner arm renders correct copy + aria-live; per-kind copy with resolved names; submit not disabled by preview; blocked-submit re-enable; editor states; no-permission redirect.

## 6. Build order
1. Core enum + `policy.ts` + `policy.test.ts` (unit+property) — zero deps, the guardrail, first.
2. Schema + migration 0003 + `booking-policies-schema.test.ts` (human-gated, not applied).
3. API: extend `types.ts` (additive union), `internal.ts` (loaders + policy-probe + `now` injection), `create-reservation.ts` (3a.5 + refusal), `check-conflicts.ts` (combined); 7 admin commands; re-export `PolicyViolation`; extend api tests.
4. Web: server actions; policy editor; combined preview + banner; web tests.
5. Regression: run full Slice-1 suite to prove zero change on no-policy resources.
Human-review gate after step 1 and step 2 before backend wiring.

## 7. Flags
**[VERIFY] → compliance-officer:** [V1] tags free-text only, no FAA computation, no regulatory framing on the "you lack tag X" message; [V2] exact case-sensitive tag match acceptable; [V3] `createBlackout` does not auto-cancel existing in-window reservations (blocks only new); [V4] `max_advance_days` = fixed 24h (not DST calendar days).
**[DEFER] → CTO/ADR-0005 (✅ ratified) / maintainer:** [A] required_tags as text[] (✅); [B] no GiST/EXCLUDE on blackout (✅); [C] tag source = creator (✅, also V); [D] blackouts evaluated even with no policy row (✅ yes); [E] additive four-arm union (✅); [F] **member-tag assignment screen OUT of 2a — MAINTAINER SCOPE CALL** (required_tags only matches members who have tags; if dormant-until-later is unacceptable, add minimal `setMembershipBookingTags({userId,tags})` authz `org:manage_settings` audited); [G] enrich violations with display name at API (✅ yes); [H] no standalone "no past bookings" rule (✅ out); [I] advisory read-then-write race acceptable (✅).
