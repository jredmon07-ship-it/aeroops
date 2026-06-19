# Slice 6 — People / Members management (build spec)

## Conductor decisions (2026-06-19) — RESOLVED, builders may proceed

- **[AUTH-DECISION] → roster entry only, NO login.** `addMember` writes `app_user` + `membership`
  ONLY — NO `auth_credential`, no password, no auth-boundary crossing. The member is a roster
  entry (taggable, role-assignable, deactivatable) that CANNOT log in until a future invite/
  set-password slice. The UI must say "Roster entry — no login yet." Do NOT bolt credential-
  writing onto `addMember`.
- **Last-owner guard ON + self-deactivation guard ON** (server-side, not just UI):
  - Demoting/deactivating the SOLE `status='active'` owner → refuse `{ok:false, reason:'last_owner'}`.
  - A caller deactivating their OWN `userId` → refuse `{ok:false, reason:'cannot_deactivate_self'}`.
  - "active owners" counts only `status='active'` rows. The last-owner concurrency TOCTOU race is
    **documented as acceptable** for this slice (reversible, no money) — do NOT add `FOR UPDATE`
    over-engineering; reviewer confirms.
- **Capabilities:** `people:access` → owner, manager, dispatcher, cfi (read). `people:manage` →
  owner, manager ONLY (NOT dispatcher/cfi — they read the roster, can't change roles/status/tags).
  mechanic/renter/student/accountant get neither.
- **Tags = case-sensitive exact match** for the `(user_id, tag)` uniqueness; UI trims only.
- **`status` is a ROSTER FLAG, NOT an auth gate** — `inactive` does NOT block login in this slice
  (login does not read `status`). Document clearly so operators aren't misled; wiring inactive→
  login-refusal is a future auth slice. Do NOT silently add it here.
- **[VERIFY-6-A] (HARD COMPLIANCE LINE):** `member_tag.tag` is a FREE-TEXT operator label ONLY.
  The system computes/interprets NO FAA currency, medical, flight-review, Part 61/141, endorsement,
  or eligibility status from a tag. Eligibility ENFORCEMENT is NOT in this slice — this is only the
  admin surface the deferred eligibility follow-up will later read. Compliance confirms at QA.
- **[VERIFY-6-C]** "Upcoming reservations they booked" = `reservation.created_by` (the only booking-
  owner seam in Phase 1); NOT a pilot/student assignment or logbook entry. Wording must not imply
  flight assignment/training credit.
- **Migration 0008 staged + HUMAN-GATED, NEVER applied to a real DB.** Demo applies it in-memory.

Sub-slices: **6.1 schema (migration 0008) → 6.2 backend (`packages/api/src/people/`) → 6.3 web**.

---

## 1. Data model (6.1 — migration 0008, human-gated)

**`app_user` additive columns** (`user.ts` + 0008; no auth-behavior change; omit-column inserts still succeed):
- `phone text` (nullable, free-text).
- `status text NOT NULL DEFAULT 'active'` + hand-written CHECK `app_user_status_check CHECK (status IN ('active','inactive'))`. Roster flag, NOT auth. (text+CHECK, not a pg enum — additive/reversible for a 2-value domain.)
`app_user_id_org_id_unique (id, org_id)` already exists (0000) — FK target for member_tag; no new app_user constraint needed.

**`member_tag` table** (NEW `member-tag.ts` + 0008): `id` uuid PK; `org_id` uuid NOT NULL FK→org CASCADE; `user_id` uuid NOT NULL (no `.references()`); `tag` text NOT NULL; `created_by` uuid NOT NULL; `created_at` timestamptz NOT NULL now(). **No `updated_at`** (add/remove only). Constraints (hand-written): `member_tag_user_org_fk (user_id, org_id) → app_user(id, org_id) ON DELETE CASCADE` (tags are disposable labels, not audited records — CASCADE correct); `member_tag_created_by_org_fk (created_by, org_id) → app_user(id, org_id) ON DELETE RESTRICT` (preserve attribution); `member_tag_tag_nonempty_check CHECK (char_length(btrim(tag)) > 0)`; `member_tag_user_id_tag_unique UNIQUE (user_id, tag)`; `member_tag_id_org_id_unique UNIQUE (id, org_id)`. Index `member_tag_org_user_idx (org_id, user_id)`. ENABLE+FORCE RLS + 4 fail-closed policies (canonical GUC predicate, byte-identical to 0006) + `GRANT SELECT,INSERT,UPDATE,DELETE TO aeroops_app`. Doc-comment: free-text-only compliance note.

Migration 0008 order: (1) app_user ADD phone; (2) ADD status; (3) status CHECK; (4) CREATE member_tag + 5 constraints; (5) index; (6) ENABLE+FORCE RLS; (7) 4 policies; (8) grant. `.down.sql` reverses. Human-gated banner (prereq 0000–0007).

**Regression gate (MUST stay green):** auth/credential tests (`auth.test.ts`, `auth.smoke.test.ts`, `auth-credential.test.ts`), the 0000 RLS suite, `listOrgMembers` tests, and any seed/fixture `app_user` insert that omits the new columns. No new column appears in any auth query path.

## 2. API (6.2 — new `packages/api/src/people/`)
Pattern: `fn(session,input)` + `fnWithDb`; `requireCapability` FIRST; Zod-validate; `withSessionOrgContextWithDb` (org_id from session only); refusals returned as discriminated unions, auth/validation thrown; reuse `toDispatchTicketView` + fleet's aggregation approach. New caps in `capabilities.ts` (alphabetical, keep `satisfies` exhaustive + update test): `people:access` (owner/manager/dispatcher/cfi), `people:manage` (owner/manager).

- **`listMembers(session,{includeInactive?})` → `OrgMemberListRow[]`** (authz `people:access`). `membership` JOIN `app_user` + set-based tag fetch (`array_agg`, no N+1). Default active-only. Row `{ userId, displayName(fullName??email), email, role, status, phone, tags:string[], tagCount }`. Do NOT modify the existing `listOrgMembers` (different gate/purpose) — add a new read.
- **`getMemberDetail(session,{userId})` → `{ok:true;member}|{ok:false;reason:'not_found'}`** (authz `people:access`). Shared `assembleMemberDetail(tx,userId)` in `internal.ts` (used by detail read AND post-write re-reads): identity+role (membership JOIN app_user; 0 rows → null → not_found); tags (ORDER BY tag); upcoming reservations they BOOKED (`reservation.created_by=$, status='booked', start_at>now()`, ≤10); recent dispatch as pilot (`dispatch_ticket.pilot_user_id=$`, incl. voided, ≤10). `MemberDetail{ userId, displayName, email, phone, status, role, joinedAt, tags:MemberTagView[], upcomingReservations[], recentDispatch:DispatchTicketView[] }`. Deactivated member → full detail (not not_found). not_found only for invisible/cross-org/non-member.
- **`updateMember(session,input)` → `{ok:true;member}|{ok:false;reason:'not_found'}|{ok:false;reason:'last_owner'}`** (authz `people:manage`). Input `{ userId, fullName?, phone?, role? }`. Identity+role ONLY — NEVER email/records. role validated via `isMembershipRole`. Last-owner guard on role demotion. ONE audit `member.updated` (before/after of fullName/phone/role). Returns fresh detail.
- **`setMemberStatus(session,{userId,status})` → `{ok:true;member}|{not_found}|{last_owner}|{cannot_deactivate_self}`** (authz `people:manage`). Self-deactivation guard (`status==='inactive' && userId===session.userId`); last-owner guard. ONE audit `member.status_changed`. Returns fresh detail.
- **`addMemberTag(session,{userId,tag})` → `{ok:true;member}|{not_found}|{duplicate}`** (authz `people:manage`). Trim tag; empty → ValidationError. Pre-check member visible (else not_found). Insert (`created_by=session.userId`); unique violation → `duplicate`. ONE audit `member.tag_added`. Opaque free-text — no interpretation.
- **`removeMemberTag(session,{userId,tagId})` → `{ok:true;member}|{not_found}`** (authz `people:manage`). DELETE by id (RLS); 0 rows → not_found. ONE audit `member.tag_removed` (capture tag string before delete).
- **`addMember(session,input)` → `{ok:true;member}|{ok:false;reason:'email_taken'}`** (authz `people:manage`). Input `{ email, fullName?, phone?, role }`. Insert app_user (status='active', NO auth_credential) + membership. Org-email collision → email_taken. ONE audit `member.created`. UI says "no login yet".
- Barrel-export all 8 fns + `*WithDb` + types from `packages/api/src/index.ts`.

## 3. Web (6.3 — `apps/web/app/o/[slug]/(shell)/people/`)
RSC + Suspense + actions (ISO-date serialization) like fleet. Design system (architectural corners, brand tokens, `.nums`, role badge via `ROLE_LABELS`). Nav: add `People` item (`people:access`) after Resources / before Fleet.
- **`/people` list** (`people:access`): perm-denied redirect / loading / empty / populated (Name, Email, Role badge, Status chip, Tags chips +N, phone) with active-only toggle + "Add member" (`people:manage`) / error.
- **`/people/[id]` detail** (`people:access`): not-found 404-style (not 500) / loading / populated (header with status chip + "no login" hint; Contact card; Tags card with add/remove (`people:manage`); upcoming reservations "booked by them"; recent dispatch as pilot; Edit + Deactivate/Reactivate if `people:manage`). Deactivated member still renders.
- **Dialogs** (`people:manage`): edit-member (fullName/phone/role; `last_owner` message), add-member (email/fullName/phone/role; `email_taken`; "no login" notice), status-toggle (confirm; `cannot_deactivate_self`/`last_owner` messages), tag-editor (add trim/non-empty; `duplicate` inline; remove by id). Every refusal rendered as a message, never a crash.

## 4. Edge cases
Tenant isolation on the aggregation (cross-org userId → not_found, no tag/reservation/dispatch leak — test org-B id from org-A AND no facet leak); member with no activity → empty cards ok; deactivated → full detail; duplicate tag → duplicate; cross-org id → not_found uniformly across all mutations; last-owner boundary (2 active owners ok / 1 active+1 inactive refused / exactly 1 refused); self-deactivation refused; concurrency race documented acceptable; addMemberTag on deactivated member allowed; email collision org-scoped; removeMemberTag cross-org tagId → not_found; NO money/card/raw-password anywhere.

## 5. Tests
**No property tests** (no new pure algorithm; last-owner is a count predicate covered by boundary cases — say so in the QA packet). Schema T1–T8 (additive insert back-fills status='active'; status CHECK rejects bad value; auth/credential/membership/RLS/listOrgMembers regression green; member_tag RLS isolation; composite FK cross-org block; (user_id,tag) unique; tag-nonempty CHECK; CASCADE from app_user + RESTRICT on created_by). Backend T9–T23 (list happy/isolation/authz; detail happy/no-activity/deactivated/cross-org-not_found; update edits+ONE audit+last_owner+never-touches-records; setStatus audit+self-deactivation+last_owner; addTag insert+audit+duplicate+empty-ValidationError+cross-org; removeTag delete+audit+not_found; addMember NO credential row+audit+email_taken; capability exhaustiveness + the 2 new caps grants; concurrency best-effort/documented).

## 6. [VERIFY] (compliance + human)
- **[VERIFY-6-A] (compliance, hard line):** tags free-text only, no computed currency/medical/cert/eligibility. Confirm schema/API/UI attach no regulatory meaning.
- **[VERIFY-6-C] (compliance/product):** "reservations they booked" = created_by, not flight assignment/training credit.
- **[VERIFY-6-D] (human/auth, documented):** status is a roster flag, NOT a login gate; inactive does not block auth in this slice; login-status enforcement deferred.
- **[VERIFY-6-LASTOWNER]/[VERIFY-6-E] (reviewer/product):** confirm guard policy + "active owners" denominator + accepted concurrency race.

## 7. Invariants
org_id from session only; member_tag ENABLE+FORCE RLS + 4 policies + grant; every role/status/tag/create mutation writes exactly ONE audit row (actorUserId=session.userId); no raw card/money; NO credential writes / auth boundary untouched (Decision A); additive-only (FROZEN engines + auth/membership/listOrgMembers queries unchanged; omit-column app_user inserts still succeed); member_tag is free-text opaque; refusals returned / auth+validation thrown; web imports only @aeroops/api; migration 0008 staged + human-gated, NEVER applied.
