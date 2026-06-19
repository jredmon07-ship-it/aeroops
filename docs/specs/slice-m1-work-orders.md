# Slice M1 — Maintenance Work-Orders Foundation (Phase 4 entry, THIN) — build spec

**Migration 0013 (human-gated, NEVER auto-run). ADR-0012 at build. Sub-slices: M1.1 schema → M1.2 backend (incl. orchestration) → M1.3 web.**

LOCKED DECISIONS (founder-away; architect's recommended defaults adopted 2026-06-19):
1. `maintenance:work_order` grants → owner/manager/mechanic/dispatcher YES; cfi/accountant/renter/student NO.
2. Parts/labor = FREE-TEXT in `work_performed`/`sign_off_notes` ONLY — NO parts table, NO labor lines, NO money.
3. `updateWorkOrderStatus` accepts `in_progress` ONLY (complete → `completeWorkOrder`; cancel → `cancelWorkOrder`).
4. Conservative unground: do NOT unground without a matching grounding basis (§ rule below).
5. Fleet-aggregate work-order read gated to `fleet:access` (consistent with how squawks/grounding already surface on fleet detail).
6. A linked squawk MUST be on the same aircraft as the work order (enforced at `openWorkOrder`).

THE LOOP (M1's reason to exist): operator opens a `work_order` on an aircraft (optionally linked to a squawk) →
`open → in_progress → completed`/`cancelled` → records free-text work + an operator/mechanic SIGN-OFF (DATA ENTRY,
NOT a Part-43 determination) → on **completion** may (operator's explicit choice) **resolve the linked squawk** +
**unground the aircraft** so the demo's grounded Cirrus returns to service through a real maintenance record.

## HARD COMPLIANCE LINE (every regulation-adjacent surface)
NO computed FAA/Part-43/airworthiness determination of ANY kind. A work order, its sign-off, and 'completed'
status are OPERATOR DATA / data entry. The software computes/asserts NO airworthiness, return-to-service
(§43.9/§43.11), AD compliance, inspection currency (annual/100-hr/§91.409), or MEL status. "Sign-off" is a
recorded operator action, NOT an A&P/IA certification or e-signature; the signer is ANY org member (no
credential check). Ungrounding is an explicit operator action (affirmative checkbox), never a computed clearance.
[VERIFY-M1-A] completed≠RTS; [VERIFY-M1-B] no reopen; [VERIFY-M1-C] sign-off≠e-signature (durable who in
audit_log; signed_off_by SET-NULL); [VERIFY-M1-D] unground=operator action + the only-if-this-reason guard;
[VERIFY-M1-E] fleet-reader read exposure. DEFERRED forward seams (each own slice + compliance pass): A&P/IA
credential verify, e-signature/crypto signing, AD/inspection-due/annual/100-hr/§91.409, MEL, parts inventory,
labor/maintenance billing, §43 logbook records, ANY dispatch Hobbs/tach read ([[dispatch-correction-table-predecessor]]
still governs meter consumers — M1 reads NO meters). NO money anywhere.

## M1.1 — Schema (migration 0013, strictly additive)
New enum `WORK_ORDER_STATUSES = ['open','in_progress','completed','cancelled']` in `@aeroops/core`
(`scheduling/enums.ts`, + `WorkOrderStatus` + `isWorkOrderStatus` guard) → pgEnum `work_order_status` in
`packages/db/src/schema/enums.ts`. New table `work_order` (`packages/db/src/schema/work-order.ts`,
doc-comment density of squawk.ts):
- `id` uuid PK; `org_id` NOT NULL (FK→org CASCADE + Drizzle .references); `resource_id` NOT NULL (write-once,
  composite FK `(resource_id,org_id)→resource RESTRICT`); `squawk_id` NULL (write-once, composite FK
  `(squawk_id,org_id)→squawk SET NULL` **column-list syntax**); `title` NOT NULL (nonempty CHECK, write-once);
  `description` (write-once); `status` work_order_status DEFAULT 'open' (mutable, guarded transitions);
  `work_performed` (mutable while open/in_progress, **write-once once completed/cancelled**); `opened_by` NOT NULL
  (composite FK RESTRICT, write-once); `opened_at` DEFAULT now() (write-once); `signed_off_by` NULL (composite FK
  `→app_user SET NULL` **column-list**, NOT an e-signature [VERIFY-M1-C]); `signed_off_at` NULL; `sign_off_notes`
  NULL; `cancelled_reason` NULL; `cancelled_at` NULL; `created_at`/`updated_at`.
- CHECKs: `work_order_title_nonempty_check`; `work_order_completed_shape_check` (status='completed' ⇒
  signed_off_at NOT NULL; status='cancelled' ⇒ cancelled_at NOT NULL; status IN (open,in_progress) ⇒ all
  signed_off_*/sign_off_notes/cancelled_* NULL; `signed_off_by` intentionally NOT in the NOT-NULL arm — SET NULL,
  durable who in audit_log; mirror `squawk_resolved_shape_check`).
- `UNIQUE(id,org_id)`; index `(org_id,resource_id,status)` + `(org_id,squawk_id)`. NO one-open partial-UNIQUE
  (multiple open WOs per aircraft are legitimate).
- Migration 0013: CREATE TYPE → CREATE TABLE + named FKs + CHECKs → 3 indexes → ENABLE+FORCE RLS + 4 fail-closed
  named policies (byte-identical NULLIF predicate) → GRANT to aeroops_app. `.down`: DROP TABLE → DROP TYPE.
  Add 0013 to every existing db + api test MIGRATION_SQL array. Strictly additive — alters no existing object.
- Valid transitions (API-enforced, not a DB pair-CHECK): open→in_progress, open→completed, in_progress→completed,
  open→cancelled, in_progress→cancelled. completed/cancelled terminal. No reopen [VERIFY-M1-B].

## M1.2 — Backend (the orchestration is load-bearing)
**Inner-core extraction (byte-equivalent; existing squawk/grounding tests stay green):** refactor
`update-squawk-status.ts` + `ground-aircraft.ts` so their `withSessionOrgContextWithDb` callback BODY becomes a
tx-scoped inner helper in `maintenance/internal.ts`: `applySquawkStatusOnTx(sess,tx,{squawkId,status,resolutionNotes})`
+ `applyUngroundOnTx(sess,tx,{resourceId,reason})` (each does the guarded write + its OWN audit row; NO
requireCapability, NO context-open). Public `*`/`*WithDb` become thin wrappers delegating to the inner helper.
The FROZEN grounding GATE (`evaluateGroundingGate`, ADR-0008) is UNTOUCHED — M1 orchestrates the WRITE paths only.

**`completeWorkOrder` runs ALL sub-actions in ONE `withSessionOrgContextWithDb` tx** (crash → whole tx rolls back,
no half-applied loop): guarded UPDATE WO→completed (+sign-off) + `work_order.completed` audit; if `resolveSquawk`
& linked → `applySquawkStatusOnTx`; if `unground` → the §rule. 3 audit rows when all 3 fire; idempotent no-ops
write none. Sub-action ids come from the WO row read IN-CONTEXT, never caller input (cross-org structurally impossible).

**Unground rule (pure `shouldUngroundForWorkOrder`, unit-tested):** extend `GroundingProbeEntry`+`loadGroundingProbe`
to also project `squawkId` (additive; fleet/openDispatch ignore it). Unground ONLY if currently grounded AND the
latest grounding event's `squawk_id` == this WO's `squawk_id`. Else skip with `ungroundSkipped`:
'not_grounded' | 'grounded_for_other_reason' | 'no_matching_grounding_basis'. Completion + squawk-resolve still apply.
[VERIFY-M1-D]: operator must affirmatively check the box; the rule is an operator-convenience guard, not a determination.

**Capability `maintenance:work_order`** (NEW, alphabetical after maintenance:squawk; grants per LOCKED #1; exhaustive
ROLE_CAPABILITIES + satisfies guard). Read = existing `maintenance:access`. `completeWorkOrder` ALSO requires
`maintenance:squawk` when `resolveSquawk` and `maintenance:ground` when `unground` (up front, before any write —
preserves the existing ground/squawk authorization boundary; no back door).

**Functions** (`maintenance/` flat files, `*`+`*WithDb`, authz FIRST → Zod → context → guarded write → audit;
auth THROWN, validation THROWN, operational refusals RETURNED; mapper `toWorkOrderView` in internal.ts):
- `openWorkOrder({resourceId,title,description?,squawkId?,workPerformed?})` cap work_order — validate resource
  visible/active/kind=aircraft (ValidationError else); if squawkId: visible in-org AND same resourceId (LOCKED #6,
  ValidationError else); INSERT status open, opened_by=session; audit `work_order.opened`; returns {ok,workOrder}.
- `listWorkOrders({resourceId?,status?})` cap access — RLS SELECT ORDER BY created_at DESC LIMIT 50.
- `getWorkOrderDetail({workOrderId})` cap access — joins linked squawk via toSquawkView; cross-org→not_found.
- `updateWorkOrderStatus({workOrderId,status:'in_progress'})` cap work_order — guarded WHERE status='open';
  0 rows→ probe not_found vs invalid_transition; audit `work_order.status_changed`.
- `completeWorkOrder({workOrderId,workPerformed?,signOffNotes?,resolveSquawk?,squawkResolutionNotes?,unground?})`
  — the orchestration above; guarded WHERE status IN (open,in_progress); 0 rows → not_found vs not_completable;
  result {ok,workOrder,squawk,squawkResolveSkipped?,grounding,ungrounded,ungroundSkipped?} | not_found | not_completable.
- `cancelWorkOrder({workOrderId,cancelledReason})` cap work_order — guarded WHERE status IN (open,in_progress);
  audit `work_order.cancelled`; does NOT resolve squawk/unground. not_found | not_cancellable.
- Extend `assembleAircraftDetail` (fleet/internal.ts) + AircraftDetail with `openWorkOrders`(≤10)+`openWorkOrderCount`
  (one more RLS-scoped query, no N+1); optionally `openWorkOrderCount` on AircraftListRow. Gated by fleet:access [VERIFY-M1-E].
- Barrel-export all 6 fns + *WithDb + WorkOrderView + unions from packages/api/src/index.ts.

## M1.3 — Web (match fleet/* design system; under a `maintenance` shell section)
- `/maintenance/work-orders` list (filter aircraft/status; states loading/empty/populated/error/perm-denied;
  primary Open work order if work_order cap) → `/maintenance/work-orders/[id]` detail (header+aircraft link+linked
  squawk panel+work performed+sign-off block when completed+cancelled reason; not_found empty-state; status-dependent
  actions: open→Start/Complete/Cancel, in_progress→Complete/Cancel, terminal→read-only).
- Open dialog (aircraft preselect from fleet/picker; title required; optional link a squawk over THIS aircraft's
  open/deferred squawks; optional notes). Complete dialog (the loop): work_performed + sign_off_notes; "Resolve
  linked squawk" checkbox if linked & still open/deferred; "Return aircraft to service" checkbox ONLY if grounded &
  basis matches (else disabled info "grounded for a different reason — remains grounded"); a VERBATIM disclaimer
  (compliance-supplied): sign-off is an operator/mechanic record, NOT an FAA return-to-service/§43.9/§43.11
  determination [VERIFY-M1-A/C/D]. Cancel dialog (reason required; copy: does not resolve squawk/unground).
- Fleet `/fleet/[id]`: an "Open work orders" card (≤10, link each to detail) + Open work order button (gated
  maintenance:work_order). Dates serialized at the action boundary; apps/web imports ONLY @aeroops/api/@aeroops/core.

## Edge cases / tests (test-writer)
Tenant isolation on the aggregate AND the orchestration (cross-org WO id → not_found, never reads/mutates A's
squawk/grounding); complete w/ no linked squawk → no_linked_squawk skip; squawk already resolved → skip no dup audit;
grounded for DIFFERENT reason → grounded_for_other_reason, stays grounded; not grounded → not_grounded; lacks
ground/squawk cap when option requested → Forbidden BEFORE tx opens; **atomicity: inject a throw after the WO update
→ WO NOT completed + squawk NOT resolved (whole tx rolled back)**; double-complete → not_completable; cancel never
touches squawk/grounding; write-once terminal fields; cross-org squawk/resource at open → ValidationError; squawk on
other aircraft → ValidationError; NO money column anywhere; regression: existing squawk/grounding public-fn tests
green after inner-core extraction; loadGroundingProbe squawkId addition doesn't break fleet/openDispatch. Pure-unit:
isWorkOrderStatus guard, shouldUngroundForWorkOrder, status-transition validator, capability exhaustiveness. Schema:
RLS isolation per table, composite-FK cross-org rejection, SET-NULL column-list (org_id preserved), every CHECK fires,
migration 0013 up/down additive. NO new property-test engine expected (confirm with reviewer).

## Invariants
org_id from session only; ENABLE+FORCE RLS; one audit row per real mutation; write-once terminal fields; NO money;
FROZEN grounding gate / gatedCreateOccurrence / openDispatch / dispatch records UNTOUCHED; M1 reads no dispatch
meters; NO computed FAA/Part-43/airworthiness determination.
