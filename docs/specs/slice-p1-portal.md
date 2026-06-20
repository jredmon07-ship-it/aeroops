# Slice P1 — Student/Renter self-service portal (thin, READ-ONLY) — build spec

**READ-ONLY, additive, NO migration/money/FAA-determination. Resolves [VERIFY-T1-H]. Sub-slice P1.1 backend+cap → P1.2 portal UI+routing.**
LOCKED decisions (founder-away; architect recommendations adopted): (a) `portal:access` granted to student/renter/owner/manager
ONLY (not cfi/dispatcher); (b) raise the Dashboard nav item to `reporting:access` so portal-only roles see only "Portal";
(c) P1.2 shows progress-SUMMARY only (no per-lesson checklist); (d) renters + students get the IDENTICAL portal (empty
states handle the difference). DEFERRED for founder (NOT built): self-booking, self-cancel, payments/balance, document
upload, profile self-edit, eligibility surfacing, mobile portal.

## THE LOAD-BEARING REQUIREMENT — self-scoping
Every portal read filters to `session.userId` (caller's OWN rows) IN ADDITION to org RLS. A student must NEVER see another
member's data, even same-org. Use DEDICATED self-scoped reads in `packages/api/src/portal/` — do NOT reuse the staff
list-all reads (listMembers/listEnrollments/listReservations/getMemberDetail). The portal reads take NO row-identifying
input (no userId/enrollmentId param) — they are implicitly "me"; `session.userId` comes from the verified JWT only (zero IDOR).

## P1.1 — Backend + capability (packages/core + packages/api/src/portal/)
**Cap:** add `'portal:access'` to `CAPABILITIES` (alphabetical, between people:manage and reporting:access) + grant to
student/renter/owner/manager in ROLE_CAPABILITIES; update the matrix doc + resolve the [VERIFY-T1-H] inline note ("delivered
in P1"); keep the `satisfies` guard + extend the exhaustiveness test. **portal:access does NOT transitively grant
training/people/fleet/schedule access** — the portal reads are SEPARATE functions gated solely on portal:access.
**Reads** (`fn(session)`+`fnWithDb(db,session)`, `requireCapability(session,'portal:access')` FIRST, then ONE
`withSessionOrgContextWithDb`, then `= session.userId` predicate; empties→[]; barrel-export from packages/api index;
`portal/internal.ts` holds `assembleMyPortal(tx,userId)` + the 3 tx-level helpers, NOT exported — people/internal.ts pattern):
- `getMyTraining` → MyEnrollmentRow[] (= MemberEnrollmentRow): `enrollment WHERE student_user_id = session.userId`, progress
  via progressRatioFromCounts, enrolled_at DESC. [VERIFY-T1-B] progress=content coverage not Part-141.
- `getMyReservations` → MyReservationRow[] `{id,startAt,endAt,seriesId,resourceIds,role:'booker'|'pilot'|'booker_and_pilot'}`:
  upcoming (status='booked' AND start>NOW()) where `reservation.created_by = session.userId` OR linked non-voided
  `dispatch_ticket.pilot_user_id = session.userId`; JOIN resource for tail #; start ASC LIMIT 20.
- `getMyAccount` → MyAccountView `{userId,displayName(fullName??email),email,phone,role,joinedAt,tags:{id,tag}[]}`: identity +
  own tags for `m.user_id = session.userId` ONLY. Do NOT return status/hasLogin/other members' data. Tags = free-text [VERIFY-6-A].
- `getMyPortalSummary` → `{account,reservations,training}` — the page's single fetch; runs the 3 reads inside ONE
  withSessionOrgContext (assembleMyPortal). Granular reads still exported (testability/mobile reuse).
- Types in `portal/types.ts`. Reads NOT audited (read-only).

## P1.2 — Web (`(shell)/portal/page.tsx` + routing; match dashboard design)
Page (RSC, calls `getMyPortalSummary`, page-level `requireCapability('portal:access')` → redirect /no-access else):
A heading "Welcome, {firstName}"; B "My upcoming reservations" (start/end local-fmt, tail #, booker/pilot chip; empty "No
upcoming reservations" — NO book CTA, deferred); C "My training" (per-enrollment course title + status pill + progress bar +
completed/total; empty "Not enrolled in a course yet"; SUMMARY only) + the [VERIFY-T1-B] footnote "Progress reflects lessons
recorded by your instructor — not a regulatory completion or graduation."; D "Account" (name/email/phone/role label/member-
since/read-only tag chips, no edit). States loading/empty/populated/error per section.
**Routing:** at the org-root dashboard page, after auth(), if portal-only (`hasCapability(portal:access) && !hasCapability(
reporting:access)` — use a testable `isPortalOnly(session)` helper in lib/nav.ts) → `redirect('/o/[slug]/portal')`. Add a
"Portal" NAV_ITEM (href /o/[slug]/portal, requiredCapability portal:access) at the TOP of NAV_ITEMS; RAISE the "Dashboard"
item's requiredCapability to `reporting:access` (so portal-only roles see only Portal; all dashboard-appropriate roles —
incl. accountant — hold reporting:access). Update nav.test.ts.

## Edge cases / tests
HEADLINE self-scoping (two students A & B same org: A's portal reads contain ZERO B rows, and vice versa, for ALL 4 reads) +
tenant isolation across orgs + cap enforcement (no portal:access → Forbidden; null → Unauthenticated) + **separation: a
portal:access-only role (student) calling a STAFF read (listEnrollments/listMembers/getMemberDetail) → Forbidden** (proves no
leak) + self-via-pilot (reservation by someone else but dispatch pilot=A → role:'pilot'; created_by=A no dispatch →
'booker') + empties (no enrollments→[], nothing booked→[]) + past/cancelled excluded + getMyAccount returns own tags only no
status/hasLogin. Core: exhaustiveness extended (portal:access ∈ CAPABILITIES; can(student/renter/owner/manager,portal:access)
true; can(student,training:access) STILL false — regression guard; can(mechanic,portal:access) false; sorted). Web: nav
"Portal" for student/renter, isPortalOnly truth table, the org-root redirect predicate. NO property tests (no engine logic).

## Compliance (light)
Read-only own-data; no writes/audit; NO money (MONEY BOUNDARY held — zero dollars); [VERIFY-T1-H] RESOLVED (student sees their
OWN progress = operator content already recorded about them, NOT a new computed determination; broad training:access stays NOT
granted); [VERIFY-T1-B]/[VERIFY-6-A] carry over (progress=coverage not graduation; tags=free-text). Tenant isolation +
self-scoping are the dominant guardrails — adversarially tested.
