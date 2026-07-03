# Slice P2-ESIGN — E-signature on lesson records

**Status:** BUILD-COMPLETE (awaiting human review of migration `0032_lesson_signature.sql`).
**Branch:** `slice/code-health-rows-helper` (working tree only; migration staged, NOT applied).

## 0. Compliance hard line (verbatim — HIGHEST COMPLIANCE CARE) [VERIFY-P2-A]

> A `lesson_signature` is an operator/instructor ATTESTATION artifact — a record of who signed,
> when, what they attested to, and a content hash of the signed `lesson_record` snapshot. It is
> NOT an FAA-recognized digital/electronic signature, NOT a §61.51 / §61.65 / Part-141 endorsement
> of record, and it computes NO training-completion, stage, graduation, or currency determination
> of any kind. `role_at_signing` is a snapshot of the signer's operator role; `attestation_text` is
> free-text the operator provides. A stored signature does not verify eligibility, endorsement
> validity, or airworthiness — a human still makes every regulatory call.

This posture is carried verbatim in: the migration header (`0032_lesson_signature.sql`), the
schema doc-comment (`packages/db/src/schema/lesson-signature.ts`), `packages/api/src/training/types.ts`
(`LessonSignatureView`), the pure snapshot function doc-comment
(`packages/core/src/training/lesson-record-snapshot.ts`), the command files
(`sign-lesson-record.ts` / `void-lesson-signature.ts`), the barrel comment in
`packages/api/src/index.ts`, and the web UI (the Sign dialog shows the full text; the record log
shows a condensed version).

The `content_hash` on every `lesson_signature` row is a **tamper-evidence digest** (sha256 of
`canonicalLessonRecordSnapshot`, `@aeroops/core`) — it proves a later `lesson_record` snapshot
differs from what was signed. It is **not** a cryptographic/PKI signature.

## 1. Data model — migration `0032_lesson_signature.sql`

One new table, `lesson_signature`, **APPEND-ONLY** (SELECT + INSERT RLS policies only — mirrors
`ledger_entry`, migration `0022`). No UPDATE/DELETE policy exists; `GRANT SELECT, INSERT` +
explicit `REVOKE UPDATE, DELETE` is the belt-and-suspenders backstop. With FORCE ROW LEVEL
SECURITY, the absence of a permissive UPDATE/DELETE policy blocks those operations for **every**
role, including the table owner.

Columns: `id`, `org_id`, `lesson_record_id` (composite FK → `lesson_record(id, org_id)` ON DELETE
RESTRICT), `signer_user_id` (composite FK → `app_user(id, org_id)` ON DELETE RESTRICT),
`role_at_signing`, `attestation_text`, `content_hash`, `voided_by_signature_id` (nullable
self-referencing composite FK → `lesson_signature(id, org_id)` ON DELETE RESTRICT), `signed_at`,
`created_at`.

### Tombstone-void semantics

There is no UPDATE path — voiding a signature **appends** a new row (a tombstone) whose
`voided_by_signature_id` points at the signature being voided:

- `voided_by_signature_id IS NULL` → a normal attesting signature (may be ACTIVE or VOIDED).
- `voided_by_signature_id IS NOT NULL` → this row **is** a tombstone; it can never itself be voided
  (command-layer refusal: `cannot_void_tombstone`).
- A non-tombstone signature is **VOIDED** iff some tombstone row references it as its target;
  otherwise it is **ACTIVE**.

**No partial UNIQUE index** enforces "one active signature per lesson_record" — that would
permanently block legitimate re-signing after a void (the original non-tombstone row is never
deleted, so it would forever collide with the partial index). Instead, "one active signature" is
enforced in the **command layer** under a `FOR UPDATE` lock on the parent `lesson_record` row —
mirrors the "no flat unique (enrollment_id, lesson_id)" rationale already documented on
`lesson_record` itself (migration `0012`).

## 2. Pure logic

`packages/core/src/training/lesson-record-snapshot.ts` — `canonicalLessonRecordSnapshot(input)`.
Deterministic, key-order-independent canonical-JSON serialization of the seven `lesson_record`
fields the signature covers (`id`, `enrollmentId`, `lessonId`, `instructorUserId`, `completedAt`,
`gradeLabel`, `notes`, `status`), built with a FIXED key order (never `JSON.stringify` of an
arbitrary object). `null` and `''` are distinct encodings. Pure — no I/O, no `node:crypto` (mobile-
safe). Property-tested (`packages/core/src/__tests__/lesson-record-snapshot.test.ts`): key-order
independence and single-field-change sensitivity, via `fast-check`.

The sha256 hash itself is computed in the API layer (`node:crypto`, mirrors
`packages/api/src/storage/sigv4.ts`).

## 3. Capability

No new capability. `training:manage` (owner/manager/cfi) gates `signLessonRecord` and
`voidLessonSignature`. `training:access` (owner/manager/dispatcher/cfi) gates
`getLessonSignatures`. A student/renter/mechanic/accountant holds neither cap. `dispatcher` can
read signatures but not sign/void them.

## 4. API — `packages/api/src/training/*`

- `signLessonRecord(session, { lessonRecordId, attestationText })` — `training:manage`. Locks the
  target `lesson_record` `FOR UPDATE`, refuses a second active signature (`already_signed`),
  snapshots `role_at_signing` from `membership`, computes `content_hash`, INSERTs one row, writes
  one `audit_log` row (`training.lesson_record_signed`). **The signer is always `session.userId`
  — there is no `signerUserId` input field at all** (a caller can only ever sign as themselves).
- `voidLessonSignature(session, { signatureId, reason })` — `training:manage`. Refuses voiding a
  tombstone (`cannot_void_tombstone`) or an already-voided signature (`already_voided`); locks the
  parent `lesson_record` `FOR UPDATE`; APPENDS a tombstone row (the original is never touched);
  writes one `audit_log` row (`training.lesson_signature_voided`).
- `getLessonSignatures(session, { lessonRecordId })` — `training:access`. One RLS-scoped
  aggregation query (no N+1); cross-org/nonexistent id returns `[]` (RLS-invisible, never leaks
  existence).

`assembleLessonSignatures` (new helper in `packages/api/src/training/internal.ts`) is the single
read path shared by all three commands. `assembleEnrollmentDetail` in the same file is
**untouched** (byte-identical) — signatures are read through this separate helper, not folded into
enrollment aggregation.

## 5. Web UI

`apps/web/app/o/[slug]/(shell)/training/actions.ts` — three new server actions
(`signLessonRecordAction`, `voidLessonSignatureAction`, `getLessonSignaturesAction`) +
`SerializedLessonSignatureView` (Dates → ISO), following the existing `mapAuthError` /
`isValidationError` conventions.

`enrollment-detail-client.tsx` — a new **Signature** column on the record log table. Per-record
`SignaturePanel`:
- **loading** — spinner after ~200ms.
- **empty** — "Not signed." + Sign button (if `canManage`) opening a dialog with the full
  `[VERIFY-P2-A]` disclaimer + a required attestation field.
- **active** — green "Signed" badge, signer/role/time, a truncated tamper-evidence hash (title
  tooltip), and (if `canManage`) a Void-signature action.
- **voided** — struck-through original + red "Voided" chip + the tombstone's signer/reason/time;
  the Sign button reappears (re-signing is allowed once no active signature remains).
- **error** — destructive `Alert` (`role="alert"`, `aria-live="assertive"`) + Retry.
- `!canManage` — signatures render read-only (no Sign/Void buttons); the page already gates on
  `training:access`.

## 6. Tests

`packages/core/src/__tests__/lesson-record-snapshot.test.ts` — 5 tests (property-based via
`fast-check`): determinism, key-order independence, single-field-change sensitivity, `null` vs
`''` distinctness, fixed-key-order JSON shape.

`packages/api/src/__tests__/lesson-signature-api.test.ts` — 37 tests covering: happy-path sign +
recomputed-hash equality; exactly one audit row per write; structural signer-is-always-self;
already-signed refusal; not_found (cross-org / nonexistent); full auth-ordering truth table
(student/renter/mechanic/accountant/dispatcher → Forbidden; owner → allowed); append-only
tombstone-void (byte-unchanged original, `+1` row); already-voided / cannot-void-tombstone
refusals; re-sign-after-void; adversarial tenant isolation (org B cannot sign/void/read org A's
signatures); tamper-evidence (hash changes after void+re-record); `getLessonSignatures` newest-
first + derived flags + cap truth table; schema-level RLS isolation; append-only UPDATE/DELETE
denial under `aeroops_app`; all three CHECK constraints; all three composite-FK cross-org
rejections (including the self-FK); self-FK same-org resolution.

Full monorepo baseline: 3,907+ tests were green before this slice; all pre-existing suites remain
green after (see build report).

## 7. Deferred (not built) — forward seams

- Cryptographic/PKI signatures.
- FAA IACRA / 8710 integration.
- Real §61 endorsements.
- Completion-certificate generation.
- Biometric signing.
- The **stage-check marker** (`§8` of the approved spec): a mutable, free-text operator
  pass/incomplete label on an enrollment. Deliberately deferred from this slice — it needs a
  different mutability posture than the append-only signature core, and (being closer to a
  "Part-141 stage" reading) needs its own disclaimer framing under the same HIGHEST COMPLIANCE
  CARE standard. Forward seam: an append-only `stage_check_marker` table `(id, org_id,
  enrollment_id composite FK, marker text /* free-text 'pass'|'incomplete' operator label */,
  note, marked_by, voided_by_marker_id self-ref, marked_at)` — same append-only + tombstone
  posture as `lesson_signature`, same `[VERIFY]` "operator label, NOT a Part-141 stage
  determination" hard line. **No enrollment column was added in this slice** (enrollment schema
  untouched).

## 8. [VERIFY-P2-A] — routed to compliance-officer

Confirm the attestation posture: `lesson_signature` is an operator attestation + tamper-evidence
hash, explicitly NOT an FAA/§61/§141 electronic signature or endorsement of record, and computes
no completion/stage/currency determination.
