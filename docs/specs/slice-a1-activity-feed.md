# Slice A1 — Activity feed (read-only audit timeline) — build spec

**READ-ONLY (zero writes to audit_log; reading the trail is NOT audited). Additive, NO migration/money/FAA-determination.
Sub-slice A1.1 backend+core → A1.2 web.** LOCKED decisions (maintainer-away; architect recommendations adopted): reuse
`reporting:access` (owner/manager/dispatcher/cfi/accountant) — NO new cap; keyset cursor on `(created_at,id)` + "Load more"
(limit default 50, cap 100); DEFER the dashboard "Recent activity" card + the optional `(org_id,created_at)` index (perf
pass later). audit_log RLS is CONFIRMED present (migration 0000: ENABLE+FORCE, select+insert policies only — append-only at
the DB). [VERIFY-A1-CAP] actor names to the full reporting:access set (acceptable) + [VERIFY-A1-RETENTION] (A1 imposes no
retention obligation) → compliance to confirm.

## A1.1 — Backend (`packages/api/src/activity/`) + pure core (`packages/core/src/activity/`)
**Pure summarizer (core, the safety boundary — PROPERTY-tested):** `summarizeAuditEntry({action, entityType, metadata}) →
string` — returns a CURATED human string ONLY; **whitelist-only** defensive reads of specific metadata fields per known
action; an unknown/future action → generic safe fallback "performed an action on a {humanizedEntityType}". **NEVER dumps raw
jsonb, NEVER surfaces money or any non-whitelisted/PII value.** Plus `activityPath({entityType, entityId, metadata}) →
string|null` (slug-less relative path to the affected entity, or null if no live target). Enumerate the ~39 emitted actions by
grepping `auditLog` inserts across `packages/api/src` (dispatch.opened/closed/voided, reservation.created, squawk.*,
grounding.*, work_order.opened/status_changed/completed/cancelled, training.course_created/lesson_added/lesson_removed/
member_enrolled/enrollment_status_changed/lesson_recorded/lesson_record_voided, dispatch.config_updated, optimization_run.created,
people/member.*, etc.) → map each to a summary template + a link target (board / fleet/[id] / people/[id] / training/[courseId]
/ training/enrollments / maintenance/squawks / maintenance/work-orders — NOTE: grounding/squawk link to /maintenance/squawks,
work orders to /maintenance/work-orders; there is NO bare /maintenance page). NO money/airworthiness/Part determination in any
string (grounding = "grounded N66RG" operator data, not a ruling).
**Read** (`listActivity(session,opts?)` + `listActivityWithDb`, `requireCapability(session,'reporting:access')` FIRST, ONE
`withSessionOrgContextWithDb`, org_id from session only — NO org_id predicate, RLS scopes; LEFT JOIN app_user for actor name):
`opts = { limit?, cursor? }`; ORDER BY created_at DESC, id DESC; keyset `cursor = {createdAt,id}` → `WHERE (created_at,id) <
(cursor.createdAt, cursor.id)`; limit default 50 cap 100. Result `{ entries: [{ id, actorName, summary, entityType,
entityPath|null, createdAt }], nextCursor? }`. Actor: `full_name ?? email`; `actor_user_id` null → "System"; deleted user
(no join row) → "A former user" (no PII leak). Map rows via the pure summarizer/path. Barrel-export from packages/api index.

## A1.2 — Web (`(shell)/activity/page.tsx` + nav, match the reports page idiom)
RSC + action `listActivityAction` (await auth, map Forbidden/Unauthenticated, serialize Dates→ISO, @aeroops/api only). Page:
heading "Activity" + a timeline list (each entry: actorName + summary + relative time + link to entityPath when present);
"Load more" using nextCursor. States loading-skeleton / empty ("No activity yet") / populated / error (Alert+retry) /
permission-denied (the dashboard's role panel, NO redirect — real gate is the API cap). Nav "Activity" item
(requiredCapability reporting:access) after "Reports" + nav.test.ts. Bars/times use `.nums` where numeric.

## Edge cases / tests
T-ISO tenant isolation (org-A session NEVER sees org-B audit rows under enforced RLS — seed both, assert) + actor-name
resolution (full_name??email / null→"System" / deleted→"A former user") + cap enforcement (matrix-exhaustive: reporting:access
roles get it; student/renter/mechanic → Forbidden; null → Unauthenticated) + limit bounds (cap 100) + keyset cursor ordering +
tie-break on equal created_at + null entity_id (no link) + unknown action (generic fallback, NEVER raw json). **PROPERTY test
(REQUIRED): the no-raw-metadata invariant** — for ANY action + ANY metadata jsonb (fuzz with money keys/PII/nested junk),
`summarizeAuditEntry` output never contains a raw-json fragment / never leaks a non-whitelisted value (+ summarizer is total/
deterministic) + entity-type humanization. Web: nav visibility + page states.

## Compliance (light)
Read-only display of the audit trail (operator actions); grounding/squawk = operator data NOT FAA/Part-43/91 determination;
NO money; records-integrity preserved by construction (never mutates audit_log). [VERIFY-A1-CAP]/[VERIFY-A1-RETENTION] →
compliance confirm (expected PASS). The whitelist-only summarizer is the disclosure guard — no raw metadata reaches the UI.
