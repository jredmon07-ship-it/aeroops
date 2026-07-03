# Slice P2 — Pilot Logbook (derived, read-only + CSV export)

**Status:** BUILD-COMPLETE. Branch `slice/code-health-rows-helper`. No migration
(logbook needs NONE — a pure projection of `dispatch_ticket` + `resource`).

## 0. Scope & invariants

- **Derived read only.** The logbook is a pure projection of `dispatch_ticket`
  (CLOSED tickets) joined to `resource` for make/model. No new table.
- **FROZEN surfaces byte-identical.** `packages/api/src/dispatch/open-dispatch.ts`,
  `close-dispatch.ts`, and `gatedCreateOccurrence` (in `scheduling/internal.ts`)
  are untouched — verified via `git diff` (empty) at build time. This slice
  imports `deriveFlightTime` and the dispatch `*WithDb` open/close/void
  functions read-only (to seed test fixtures) but edits none of them.
- **`deriveFlightTime` reused, display-only.** Flight time per entry is computed
  in JS via `deriveFlightTime(hobbsOut, hobbsIn)` (Hobbs basis). Never persisted
  by this slice.
- **Corrections NOT applied** (deliberate scope line). This is a convenience
  view, not billing — it reads raw closed-ticket meters, not
  `dispatch_ticket_correction`. See `[VERIFY-P2-LOG-A]` below.
- **Self-scope is load-bearing.** Portal reads hardwire subject =
  `session.userId`; no row-identifying input. Staff reads take `userId` and are
  RLS + org-scoped (cross-org/non-member → `not_found`).
- **Running totals in integer tenths** — accumulate `Math.round(h*10)` tenths,
  divide by 10 at the end (no float-sum drift).
- **Raw `sql` never interpolates a JS `Date`** — date bounds arrive as ISO
  strings and are cast `::timestamptz`.
- No money path in this slice.

## 1. Data-model delta

**None.** Reads only `dispatch_ticket` (id, org_id, pilot_user_id, resource_id,
status, hobbs_out, hobbs_in, closed_at) and `resource` (tail_number, make,
model). RLS already ENABLE+FORCE on both; every read runs inside
`withSessionOrgContextWithDb`.

## 2. Pure core additions

`packages/core/src/import/csv-write.ts` (new) — companion to `csv.ts`:
- `serializeCsv(rows: string[][]): string` — RFC-4180 quoting; round-trips with
  `parseCsv`.
- `neutralizeCsvFormula(field: string): string` — spreadsheet-injection guard
  (prefixes a leading `= + - @` or TAB/CR with `'`). Kept OUT of `serializeCsv`
  so the round-trip property stays clean; applied by callers to specific
  free-text columns (tail/make/model).

Exported from `packages/core/src/index.ts` alongside `parseCsv`.

## 3. API (`packages/api/src/logbook/`)

- `types.ts` — `PilotLogEntry`, `PilotLog`, `PilotLogCsvResult`.
- `internal.ts` (not barrel-exported) — `UUID_RE`, `dateBoundsSchema`,
  `readPilotLog` (the one raw-SQL read), `buildPilotLog` (tenths-exact running
  totals), `pilotLogToCsvRows`, `pilotLogCsvFilename`.
- `get-my-pilot-log.ts` — `getMyPilotLog`/`WithDb`. Cap `portal:access`. Subject
  ALWAYS `session.userId`. Not audited.
- `get-pilot-log.ts` — `getPilotLog`/`WithDb`. Cap `people:access`. Takes
  `{userId, from?, to?}`. Resolves membership in-org first → `not_found` if
  invisible; an in-org member with zero closed tickets → `ok:true` empty (not
  `not_found`). Not audited.
- `export-my-pilot-log-csv.ts` — `exportMyPilotLogCsv`/`WithDb`. Cap
  `portal:access`. Writes ONE audit row (`pilot_log.exported`, `self:true`).
- `export-pilot-log-csv.ts` — `exportPilotLogCsv`/`WithDb`. Cap `people:access`.
  Writes ONE audit row (`pilot_log.exported`, `self:false`). `not_found` for
  cross-org/non-member `userId`.

Barrel-exported from `packages/api/src/index.ts` in a new "Slice P2" section.

## 4. Web surfaces

- **Portal Logbook view** — `apps/web/app/o/[slug]/(shell)/portal/logbook/page.tsx`
  (RSC, `portal:access` gate → redirect `/no-access`) +
  `_components/download-csv-button.tsx` (client Blob-download). Actions added
  to `portal/actions.ts`: `getMyPilotLogAction`, `exportMyPilotLogCsvAction`.
  Link card added to `portal/page.tsx` next to Billing.
- **People member-detail Logbook facet** —
  `people/_components/member-logbook-card.tsx` (server component, fails
  closed) + a local `_components/download-csv-button.tsx` copy (handles the
  extra `not_found` refusal arm). Actions added to `people/actions.ts`:
  `getPilotLogAction`, `exportPilotLogCsvAction`. Attached in
  `people/[id]/page.tsx` inside its own Suspense boundary, alongside
  `MemberTrainingCard`.

Both surfaces render the verbatim disclaimer (§0/§7) always — not gated behind
the empty state.

## 5. Edge cases held (see test list, §6)

Tenant isolation (adversarial), self-scope, voided/open exclusion, flight-time
correctness, running-total precision, half-open date bounds, CSV
injection/escaping, empty history, and audit correctness.

## 6. Tests

- `packages/core/src/import/__tests__/csv-write.test.ts` — 18 tests: a
  property-based round-trip (`parseCsv(serializeCsv(grid))` reproduces data
  rows for random cell content incl. commas/quotes/CRLF/unicode), quoting unit
  cases, `neutralizeCsvFormula` unit cases.
- `packages/api/src/__tests__/logbook-api.test.ts` — 29 tests: happy path,
  `flightTimeHours === deriveFlightTime`, tenths-exact running totals,
  voided/open exclusion, self-scope, T-ISO adversarial (tampered
  cross-org session + foreign-org staff lookup → no leak/`not_found`), date
  filtering (`from` inclusive / `to` exclusive / `from>to` / non-ISO →
  `ValidationError`), empty history (self + staff), staff/portal capability
  gates (student/renter/accountant/mechanic Forbidden as appropriate), CSV
  export round-trip + escaping + deterministic filename, audit correctness
  (exactly one `pilot_log.exported` row per export, correct `self`/
  `entryCount`, no PII; non-export reads write zero audit rows).

Full suite green: core 1077, api 1734, web 615, db 528 (3907 pre-existing +
47 new = 3954 total).

## 7. Compliance flag — route to compliance-officer before internet exposure

`[VERIFY-P2-LOG-A]` — two items to confirm:
1. The disclaimer wording (verbatim in both web surfaces) is sufficient to
   keep this a §61.51 convenience view, not a record of record.
2. The deliberate decision that this view reads **raw closed-ticket meters**
   and does **NOT** apply `dispatch_ticket_correction` (so displayed hours may
   differ from corrected billing hours) is acceptable for a non-authoritative
   view.

**Deferred** (all edge toward record-of-record, out of this slice): manual/
off-AeroOps entries, endorsements, category/class + night/IMC/XC
classification, PDF output, signed/certified logbook.

## 8. Files touched

New: `packages/core/src/import/csv-write.ts`,
`packages/core/src/import/__tests__/csv-write.test.ts`,
`packages/api/src/logbook/{types,internal,get-my-pilot-log,get-pilot-log,
export-my-pilot-log-csv,export-pilot-log-csv}.ts`,
`packages/api/src/__tests__/logbook-api.test.ts`,
`apps/web/app/o/[slug]/(shell)/portal/logbook/page.tsx` +
`_components/download-csv-button.tsx`,
`apps/web/app/o/[slug]/(shell)/people/_components/{member-logbook-card,
download-csv-button}.tsx`, this spec.

Edited: `packages/core/src/index.ts`, `packages/api/src/index.ts`,
`apps/web/app/o/[slug]/(shell)/portal/actions.ts` + `portal/page.tsx`,
`apps/web/app/o/[slug]/(shell)/people/actions.ts` + `people/[id]/page.tsx`.

**No** migration, **no** `packages/db` change, **no** frozen-file edit
(git diff on `open-dispatch.ts`/`close-dispatch.ts`/`scheduling/internal.ts` is
empty).
