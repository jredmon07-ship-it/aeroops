# Slice P1.7 — Flight Circle data importer

Status: BUILD-COMPLETE (awaiting human review/merge). Branch `slice/code-health-rows-helper`.
Migration `0027_data_import.sql` STAGED, human-gated, NOT applied. No reviewer/compliance
sub-agent pass per the standing P1 session rule (`docs/ROADMAP.md`) — founder
reviews the diff personally.

## Why this slice exists

The fast-onboarding path (`docs/ROADMAP.md`): turning "migrate off
Flight Circle" from a leap into an afternoon. An operator downloads a CSV from their existing
provider's **Reports → Downloads** screen (their "Users Export" for members, an aircraft list
for fleet) and uploads it here. Nothing is created until the operator has reviewed a preview.

## Scope (in this slice)

- **Members roster import** — CSV → `app_user` + `membership` rows via the **existing**
  `addMember` write path. Roster entries only — **no `auth_credential`**, matching `addMember`'s
  own guarantee (members set a password later via a future invite flow). Default role:
  `renter` (least-privilege; the operator promotes via the existing People hub afterward).
- **Aircraft roster import** — CSV → `resource` rows via the **existing** `createResource`
  (identity: tail number + display name) **then** `updateAircraft` (make/model/year/serial),
  wrapped in one savepoint so a failure in either half rolls back both.
- **Preview-before-commit**: every upload is parsed + staged (`import_batch` + `import_row`)
  and returned as a preview (with duplicate/error flags) **before any real record exists**.
  The operator reviews, can re-preview with a corrected column mapping, then commits.
- **Column-mapping confirmation**: a best-effort header→field guess
  (`guessColumnMapping`, `@aeroops/core`) pre-fills the mapping UI; the operator confirms or
  remaps before committing. **Flight Circle's exact column headers are never assumed stable.**
- **Duplicate detection**: by normalized email (members) / normalized tail number (aircraft),
  against both existing org records and other rows in the same file. A duplicate is **skipped,
  never overwritten**.
- **Sales-Transactions / ledger detection**: a heuristic (`looksLikeSalesTransactionsExport`)
  flags a ledger-shaped CSV (Flight Circle's "Sales Transactions" export) as **out-of-scope-
  for-commit** — it is still staged (visible in the preview/history for transparency) but
  `commitImport` refuses it with a clear message. **No ledger/financial-history data is ever
  written to a money table by this slice.**

## Explicitly DEFERRED (out of scope for this slice)

- **Ledger/financial-history import.** Flight Circle's "Sales Transactions" export (charges,
  payments, adjustments) touches the append-only money spine (`ledger_entry`,
  `dispatch_ticket_correction`) and needs its own careful design (reconciliation posture,
  idempotency across re-imports, [VERIFY] on how historical balances should be represented).
  This slice deliberately stops at detecting + staging that file for visibility, never
  committing it.
- **Instructor / CFI / rate-schedule import** — mapping an FC instructor roster or hourly
  rates onto `resource(kind='instructor')` / `rate_schedule` is a natural follow-up but was
  not requested for this pass.
- **Schedule / reservation history import** — no historical booking data is imported.
- **Incremental re-sync** — every upload is a fresh, standalone batch; there is no "diff
  against what I imported last time" mode. Re-uploading the same file re-detects existing
  duplicates (safe — nothing is overwritten) but does not detect *removed* rows.
- **Configurable default role for imported members** — hardcoded to `renter`. A per-import
  role picker is a small follow-up if operators want it.
- **CSV delimiter auto-detection** (semicolon/tab) — Flight Circle exports comma-delimited
  CSV; alternate delimiters are a forward seam in `parseCsv` if ever needed.

## Architecture

### Pure layer (`packages/core/src/import/`)

- `csv.ts` — `parseCsv(text): { headers, rows }`. Dependency-free, RFC-4180-ish (quoted
  fields, `""`-escaped quotes, CRLF/LF, BOM-stripping). **No new npm dependency** — a CSV
  library was evaluated and rejected in favor of this small, fully-owned parser (the house
  "prefer pure, no new dep" posture); property-tested for round-trip correctness + "never
  throws on garbage input."
- `column-mapping.ts` — `guessColumnMapping(headers, kind)`: ordered regex heuristics
  (`/e-?mail/i` → email, `/tail|n-?number|registration/i` → tailNumber, etc.), first-match-
  wins so one header never double-maps. `looksLikeSalesTransactionsExport(headers)`: ≥2
  money/ledger-shaped header hints → true.
- `normalize.ts` — `normalizeMemberRow` / `normalizeAircraftRow`: raw row + confirmed mapping
  → typed candidate | skip-reason. **Never throws**, even on wildly malformed input. `dedupeKey`
  = normalized email / tail number.

All three files are property-tested (fast-check) in `packages/core/src/__tests__/import.test.ts`
— 27 tests: CSV round-trip + never-throws fuzzing, mapping never-double-maps, normalize
idempotency + never-throws + required-field enforcement.

### Command layer (`packages/api/src/import/`)

- `preview-import.ts` — `previewImport` / `previewImportWithDb`. Parses the CSV, normalizes
  every row, checks duplicates against a **fresh** RLS-scoped read of existing org records,
  stages `import_batch` (status `previewed`, carrying the **confirmed column mapping** as
  jsonb) + every `import_row` (bulk insert, one statement). Never creates a real
  `app_user`/`resource`. Caps: `people:manage` (members) / `fleet:manage` (aircraft) — "pick
  per kind," mirrored from the ticket's own instruction.
- `commit-import.ts` — `commitImport` / `commitImportWithDb`. Loads the batch **first** (RLS-
  scoped existence read), gates on the batch's own kind, refuses a non-`previewed` or
  out-of-scope batch, re-checks duplicates **fresh** (state may have changed since preview),
  then processes every still-`pending` `import_row` **atomically per row** via a savepoint —
  a bad row (write-path throw, or a duplicate surfaced only now) marks that row
  `error`/`skipped` and the loop continues; it never aborts the batch (mirrors
  `generate-dues-invoices.ts`'s per-schedule savepoint pattern). Writes go through
  `addMemberWithDb` / `createResourceWithDb` + `updateAircraftWithDb` — **never a bespoke
  INSERT**. Updates `import_row.mapped_status`/`target_id`/`error_detail` in place + the
  batch's final counts/status. One summary `audit_log` row.
- `list-import-batches.ts` / `get-import-batch.ts` — read-only history + per-row detail,
  gated on `people:access` / `fleet:access` per kind. `getImportBatch` resolves each imported
  row's target label (member email / aircraft tail) via **one** batched query — no N+1.

24 integration tests (PGlite, migrations 0000–0027) in
`packages/api/src/__tests__/import-api.test.ts`: happy path (both kinds), preview-time +
commit-time duplicate detection, malformed-row-doesn't-abort-batch, out-of-scope refusal,
already-committed no-op, tenant isolation (T-ISO), capability enforcement per kind, validation.

### Data model (migration `0027_data_import.sql`, STAGED, NOT applied)

- **`import_batch`** — one row per uploaded file. Standard 4-policy mutable RLS (mirrors
  migration 0024's `stripe_payment_method`/`autopay_setting`) — status + counts are updated
  as the batch progresses `pending → previewed → committed|failed`. Carries the **confirmed
  column mapping** (jsonb) so `commitImport` never re-guesses or re-asks the operator.
  `error_detail` doubles as the out-of-scope-for-commit marker (prefix `out_of_scope: `).
- **`import_row`** — one row per parsed CSV line, staged at preview and **updated in place**
  at commit (`mapped_status`/`target_id`/`error_detail`). `target_id` deliberately carries no
  FK (polymorphic: `app_user.id` for a members batch, `resource.id` for an aircraft batch).

**Deviation from the original ticket wording** (documented, reasoned): the ticket describes
`import_row` as "(append-only staging, SELECT+INSERT RLS)" but also specifies that
`commitImport` must "Update import_row.target_id + mapped_status" — those two instructions are
in tension (a strictly append-only table, like `audit_log`/`ledger_entry`, structurally
forbids `UPDATE` even for the owner via `FORCE ROW LEVEL SECURITY` + no UPDATE policy). Since
the row-level outcome is a required, load-bearing part of the feature (an operator needs to
see exactly which row became which record, or why it didn't), `import_row` was built with
`SELECT + INSERT + UPDATE` RLS (**no DELETE** — rows are never removed). This is a narrower
posture than the fully-immutable append-only family: no compliance/money guarantee rides on
`import_row`'s immutability (it is an operator-facing staging/audit convenience, not a
financial or regulatory record), so the trade-off favors the working feature. See the
migration file header for the full rationale.

## Known capability-model interaction (not a bug, documented)

Aircraft import's write path uses `createResource` (cap `schedule:manage_resources`) **then**
`updateAircraft` (cap `fleet:manage`). `commitImport` for `kind='aircraft'` is gated on
`fleet:manage` only (matching the ticket's "pick per kind" instruction), and
owner/manager/dispatcher hold both caps — but **mechanic holds `fleet:manage` without
`schedule:manage_resources`**. A mechanic can therefore preview an aircraft import, but every
row will surface a `Forbidden` error at commit time (caught per-row, not a crash — the batch
still completes with every row marked `error`). This mirrors an existing, intentional asymmetry
in the capability matrix (`fleet:manage` = edit identity on an existing aircraft;
`schedule:manage_resources` = create a new bookable resource) and was not changed by this
slice — widening it is a capability-model decision, not an importer bug.

## UI

`/o/[slug]/settings/import` — kind toggle (members/aircraft, shown per the caller's own
capabilities) → upload → column-mapping confirmation (pre-filled, editable) → preview table
(status chips: will-import / duplicate-skipped / error, with the reason) → Commit → result
summary, plus a batch history table. CSV parsing + mapping-guessing run client-side via the
pure `@aeroops/core` functions for a zero-round-trip mapping step; the **confirmed** mapping
and raw CSV text are sent to `previewImportAction`, which re-parses and re-validates
server-side (the client's parse is never trusted for the real staging write). Linked from the
existing Org Settings page (visible only to owner/manager, who hold both `people:manage` and
`fleet:manage`).

## Compliance posture

Plain roster/identity import — no FAA/regulatory meaning is attached to any imported field.
Members import exactly like the existing `addMember` (no credential, no currency/medical/
Part-61/141 inference). Aircraft import exactly like the existing `createResource` +
`updateAircraft` (make/model/year/serial are operator data, not an airworthiness record).
