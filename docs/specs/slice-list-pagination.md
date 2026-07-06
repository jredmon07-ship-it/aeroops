# Slice — List pagination (scale-hardening)

Status: BUILD-COMPLETE (branch `slice/code-health-rows-helper`). NO migration
(read-only change). Backward-compatible: no existing caller changed behavior.

## Problem

`listMembers` and `listAircraft` returned EVERY row unpaginated. For a large
flight academy (hundreds of students, 40+ aircraft) that is an unbounded read on
the two hottest list surfaces. This slice adds keyset pagination to both, without
breaking the many existing callers.

## Approach — array-preserving + new paginated function (NOT a return-shape change)

The existing functions have many callers that consume a plain `Row[]` (People
page, Fleet page, dashboard/reporting, onboarding, the mobile `fleet` + `squawks`
routes, work-order components, POS / block-time pickers, training enroll dialogs).
Several of those (pickers, mobile, reporting aggregates) legitimately need the
**whole** set, not one page. Changing the return shape — or bounding the array
function — would break them.

So:

- `listMembers` / `listMembersWithDb` and `listAircraft` / `listAircraftWithDb`
  are **UNCHANGED**: same signature, same unbounded `Row[]` return. Their bodies
  were only refactored to share a row-mapper / enrichment helper (byte-equivalent
  output).
- New **additive** functions:
  - `listMembersPage(session, opts?)` / `listMembersPageWithDb(...)`
    → `{ rows: OrgMemberListRow[]; nextCursor?: MemberCursor }`
  - `listAircraftPage(session, opts?)` / `listAircraftPageWithDb(...)`
    → `{ rows: AircraftListRow[]; nextCursor?: AircraftCursor }`

Only the **People list page** and the **Fleet list page** switch to the paginated
functions (via new `listMembersPageAction` / `listAircraftPageAction`). Every
other caller keeps calling the unbounded functions unchanged.

## Keyset design (mirrors `activity/list-activity.ts`)

- Fetch `limit + 1` rows to detect a next page; return `limit` rows + a
  `nextCursor` built from the last returned row.
- Cursor values are always **bound params** (never interpolated) — injection-safe.
- Ordering is a strict total order so paging is deterministic and gap-free:
  - **Members**: `(COALESCE(full_name, email), user_id)` ascending. `email` is
    NOT NULL and `user_id` is the uuid PK, so the composite key is unique and
    never null — no NULLS-LAST ambiguity. `MemberCursor = { sortName, id }`.
  - **Aircraft**: `(COALESCE(tail_number, ''), id)` ascending. `id` is the uuid
    PK. `AircraftCursor = { tailNumber, id }`.
- `limit`: default **100**, capped at **500** (`Math.min`, mirrors activity's
  DEFAULT/MAX constants).
- AUTHZ (`people:access` / `fleet:access`) runs FIRST; one
  `withSessionOrgContextWithDb`; org_id from session only; RLS backstop. No
  `org_id` predicate in SQL — same choke-point as the unbounded reads, so a
  cursor **cannot** cross orgs (T-ISO tested).
- No N+1: the aircraft page reuses the same set-based grounding / squawk /
  work-order aggregation as the unbounded read (extracted `enrichAircraftRows`);
  the member page keeps the single `array_agg` tag aggregation.

## Web UX

Both list pages get a **"Load more"** control using a server-link
`?before=<base64url(cursor)>` param — RSC-native, no client JS, no new imports
(mirrors the activity feed exactly; `Buffer` is the same server global it uses).
The People page preserves its existing `?includeInactive=1` filter across the
Load-more navigation. Loading skeletons, empty states, and error/retry states are
unchanged. Pickers/mobile/reporting are untouched.

## Tests (vitest + PGlite)

Added to `people-api.test.ts` (T11b) and `fleet-api.test.ts` (T8b):
- multi-page walk reconstructs the unbounded read **exactly** (same set, same
  order, no dupes, no gaps) and terminates (last page has no `nextCursor`);
- first page honors `limit` and returns a `nextCursor` when more exist;
- `limit` above MAX returns everything with no `nextCursor` (cap holds);
- active-only default excludes inactive members;
- **T-ISO**: paging org A never surfaces an org-B row, for any cursor;
- caps enforced (renter → Forbidden, null → Unauthenticated);
- the aircraft page carries the same enrichment fields as the unbounded read.
The pre-existing no-opts `listMembers`/`listAircraft` tests remain green =
backward-compat regression coverage for the refactor.

## Out of scope / follow-up

Reporting and AR/billing list reads are already bounded (top-N aggregates, date-
range windows, per-aircraft) so they are NOT paginated here. If any grows into an
unbounded per-row list, apply the same `*Page` pattern. No infinite-scroll /
client "load more" component was added — the server-link approach is sufficient
and matches the codebase; a client control can be layered on later without an API
change.
