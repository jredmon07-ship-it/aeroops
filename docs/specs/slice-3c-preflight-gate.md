# Slice 3c — Full pre-flight (dispatch) gate (build spec)

## Conductor decisions (2026-06-19) — RESOLVED, builders may proceed
- **Eligibility = operator-set FREE-TEXT tag matching ONLY** ([VERIFY-3c-A], hard line). The pure
  matcher computes NO FAA currency/medical/flight-review/Part-61/141/endorsement determination —
  string set-difference over operator-defined opaque labels. Eligibility blocking = the operator
  enforcing their own rule (same posture as grounding [VERIFY-3b-H]).
- **Balance = no-op STUB** ([VERIFY-3c-MONEY], hard money boundary). `stubBalanceSeam.check()` ALWAYS
  returns `{ok:true}`. `dispatch_config.balance_check_enabled` is a feature flag (default OFF) with NO
  dollar value / minimum / payment / card / Stripe / invoicing. The `balance_block` arm is RESERVED and
  unreachable in Phase 1 (only an injected fake seam can return it, in tests). UI toggle copy says
  "not yet active".
- **dispatch:manage_requirements** → owner/manager/dispatcher (read via existing `dispatch:access`).
- **Case-SENSITIVE exact-match** (consistent with Slice 6 `member_tag` storage).
- **Defaults:** eligibility mode = `block` (when a rule exists), balance flag = `false`. Absent
  `dispatch_config` row → `{eligibilityMode:'block', balanceCheckEnabled:false}`.
- **Per-aircraft `dispatch_requirement` table** (option C, mirrors `member_tag`).
- Config toggles live on a **board-level "Gate settings" control**; requirements admin on the **Fleet
  detail page**. ADR-0009. Migration 0009 staged + HUMAN-GATED, NEVER applied (demo applies in-memory).
- NO meter access anywhere ([[dispatch-correction-table-predecessor]] NOT triggered).

Sub-slices: **3c.1 eligibility → 3c.2 balance stub**, one migration 0009.

## 1. Data model (migration 0009, human-gated)
**`dispatch_requirement`** (new, model on `member-tag.ts`): id; org_id NOT NULL (.references org + named FK);
resource_id NOT NULL (NO .references; composite FK `(resource_id,org_id)→resource(id,org_id) ON DELETE
CASCADE` — config, not a record); required_tag text NOT NULL; created_by NOT NULL (composite FK
`(created_by,org_id)→app_user(id,org_id) RESTRICT`); created_at; **NO updated_at**. CHECK
`dispatch_requirement_tag_nonempty_check`. UNIQUE `(resource_id, required_tag)` (case-sensitive) +
`(id, org_id)`. Index `(org_id, resource_id)`.
**`dispatch_config`** (new, 0..1 per org): id; org_id NOT NULL (.references org); eligibility_mode text
NOT NULL DEFAULT 'block' + CHECK IN ('block','warn'); balance_check_enabled boolean NOT NULL DEFAULT
false (feature flag, NO dollar value); created_at/updated_at. UNIQUE `(org_id)` + `(id, org_id)`.
Both: ENABLE+FORCE RLS + 4 fail-closed policies (canonical GUC predicate, byte-identical to 0008) + GRANT
to aeroops_app. Migration 0009 order: dispatch_config → dispatch_requirement → index → RLS → 8 policies →
grants; `.down.sql` reverses. Doc-comment carries [VERIFY-3c-A/MONEY] + MONEY-BOUNDARY note.
Regression gate: full Slice-1→6 suite byte-identical except openDispatch's additive arms; omit-config/
requirement inserts still succeed (defaults apply).

## 2. API
**Pure core (property-tested)** `packages/core/src/dispatch-gate/eligibility-gate.ts`:
`evaluateEligibilityGate(requiredTags, pilotTags, mode:'block'|'warn') → { satisfied, missingTags, blocked, warnings }`.
missingTags = case-sensitive set difference (requiredTags\pilotTags), deduped, order from requiredTags.
Empty requiredTags → satisfied:true, no gate. block → blocked=!satisfied, warnings=[]; warn → blocked=false,
warnings=missingTags. PURE (no I/O/clock, no tag-content interpretation). [VERIFY-3c-A].
**Balance seam** `packages/core/src/dispatch-gate/balance-seam.ts`: `BalanceCheckRequest {orgId, pilotUserId}`
(NO amount/minimum/currency/account), `BalanceCheckResult {ok:true}|{ok:false,reason:'below_minimum'}` (reserved),
`BalanceSeam { check }`, `stubBalanceSeam` = ALWAYS `{ok:true}` (no I/O, no money). [VERIFY-3c-MONEY].
**Cap** `dispatch:manage_requirements` → owner/manager/dispatcher (core capabilities + test).
**CRUD `packages/api/src/dispatch-gate/`** (fn+WithDb, requireCapability first, withSessionOrgContextWithDb,
org_id from session, refusals returned/auth+validation thrown, ONE audit per mutation):
`getResourceRequiredTags`({resourceId}, `dispatch:access`) → list|not_found; `addResourceRequiredTag`
({resourceId,requiredTag}, `dispatch:manage_requirements`) trim/nonempty, aircraft visible/active else not_found,
23505→duplicate, audit `dispatch.requirement_added`; `removeResourceRequiredTag`({resourceId,requirementId})
delete by id, 0 rows→not_found, audit `dispatch.requirement_removed` (capture tag); `getDispatchConfig`
(`dispatch:access`) → defaults when absent (shared `loadDispatchConfig(tx,orgId)` reused by openDispatch);
`updateDispatchConfig`({eligibilityMode?,balanceCheckEnabled?}, `dispatch:manage_requirements`) upsert ON
CONFLICT(org_id), partial preserves other field, audit `dispatch.config_updated` (NO dollar in metadata).
Barrel all from packages/api/src/index.ts.
**openDispatch wiring (additive)** in `_openDispatchImpl`, AFTER pilot-membership (3e), BEFORE INSERT (3f):
(4) eligibility — load requiredTags; if empty skip (no pilot-tag query); else load pilot member_tags +
loadDispatchConfig.eligibilityMode; `evaluateEligibilityGate`; if blocked → RETURN `{ok:false,
reason:'ineligible', missingTags}` (no write/audit); warn+unsatisfied → carry optional `eligibilityWarnings?`
on the ok:true arm. (5) balance — if cfg.balanceCheckEnabled → `balanceSeam.check({orgId,pilotUserId})`; if
!ok → RETURN `{ok:false, reason:'balance_block'}` (reserved; stub never returns). Inject `balanceSeam:
BalanceSeam = stubBalanceSeam` (optional param; openDispatchWithDb exposes it for a fake-injecting test).
Grounding (3d) precedes eligibility — byte-identical. Live re-read at check-out (no stale snapshot).
**`OpenDispatchResult`** (dispatch/types.ts) additive: ok:true gains optional `eligibilityWarnings?: string[]`;
new arms `{ok:false,reason:'ineligible',missingTags:string[]}` + `{ok:false,reason:'balance_block'}`. Existing
arms (not_found/already_open/grounded) byte-identical.

## 3. Web
- Fleet detail page: "Dispatch requirements" card (getResourceRequiredTagsAction) — free-text chips +
  add/remove (dialog, trim/nonempty, duplicate inline) gated `dispatch:manage_requirements`; copy
  "Required tags (free-text labels you define). A pilot must carry a matching tag to be checked out." —
  no currency/endorsement implication. Empty → "Any qualified pilot can be checked out."
- Board "Gate settings" control (gated `dispatch:manage_requirements`): Eligibility mode Block/Warn (default
  Block) + Balance check toggle whose copy says "Pre-flight balance check (coming in Billing). Not yet active —
  turning this on has no effect until account balances ship." [VERIFY-3c-MONEY].
- check-out-dialog.tsx: handle new arms alongside `grounded` — `ineligible` → blocking inline error listing
  `missingTags`; `balance_block` → generic message (reserved, exhaustive switch); warn (ok:true +
  eligibilityWarnings) → non-blocking success notice. All other states unchanged.
- Design system tokens, `.nums` where numeric, never hardcode color.

## 4. Edge cases
Tenant isolation (cross-org resourceId/requirementId → not_found uniformly; pilot tags never cross orgs;
matcher is pure, isolation lives in load queries). No requirements → no gate (skip pilot-tag query, byte-
identical happy path). Pilot no tags + rules → block with full missingTags. Block vs warn both tested.
Case-sensitive. Duplicate → duplicate. Live re-read. Balance stub always ok (flag on → still ok; injected
fake → balance_block proves wiring, no real money code). NO money rounding (no money exists). Inactive
aircraft manage → not_found. CASCADE requirement w/ aircraft; RESTRICT created_by. ONE audit per mutation;
refusals/no-ops write zero. No meter access.

## 5. Tests
**Property (core, hard guardrail) — evaluateEligibilityGate E1–E7**: empty→satisfied; exact set-diff;
satisfied⇔missing empty; mode partition; superset→satisfied; case-sensitivity; purity. **Unit**: cap
exhaustiveness + dispatch:manage_requirements row; stubBalanceSeam always ok; BalanceCheckRequest has NO
money field (type assertion). **Integration**: CRUD happy/duplicate/empty-ValidationError/non-aircraft-cross-
org-not_found/authz(cfi denied, dispatcher ok); config absent→defaults/update+audit/partial/invalid/no-dollar-
in-audit; openDispatch ineligible(block, no write/audit)/ok(pilot has tag)/warn(ok+warnings)/no-rules(byte-
identical, no pilot-tag query); balance flag off→not consulted, on+stub→ok, on+fake→balance_block(no write);
tenant isolation; grounded precedes eligibility; all existing open-dispatch tests byte-identical. **Schema**:
RLS isolation + FORCE; composite-FK cross-org; nonempty CHECK; (resource_id,required_tag) UNIQUE; eligibility_mode
CHECK; config org_id UNIQUE; CASCADE/RESTRICT; additive inserts succeed. **No-regression**: full Slice-1→6 green.

## 6. [VERIFY] (compliance) — [VERIFY-3c-A] free-text only/no computed currency; [VERIFY-3c-MONEY] balance is a
no-op stub, no money concept in any table/type/audit/UI; [VERIFY-3c-GATE] eligibility block = operator enforcing
own rule, not a software reg determination.

## 7. Build order
1. Core: eligibility-gate (+property E1–E7) + balance-seam (+unit) + cap (+test). 2. Schema + migration 0009 +
schema tests. 3. API CRUD + loadDispatchConfig + tests. 4. openDispatch additive arms + injected-seam test +
no-regression. 5. Web (Fleet requirements card + board gate-settings + check-out arms). 6. Full suite green;
ADR-0009 + this spec finalized.

## 8. Invariants
org_id from session only; both tables ENABLE+FORCE RLS + 4 policies + grant; web imports only @aeroops/api;
matcher PURE + no reg determination; balance a no-op stub (no Stripe/payment/dollar; balance_block reserved/
unreachable; flag default OFF); NO meter access; ONE audit per mutation, refusals/no-ops zero; FROZEN engines +
openDispatch existing arms byte-identical, edits additive only; refusals returned/auth+validation thrown;
migration 0009 staged + human-gated, NEVER applied.
