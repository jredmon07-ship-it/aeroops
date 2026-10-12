# Slice P1.6 — Document storage

**Status:** BUILD-COMPLETE (awaiting human merge). Migration `0030_documents.sql` staged + human-gated, NOT applied.
**Branch:** `slice/code-health-rows-helper`. **Parity target:** Flight Circle "Secure Upload Document Storage".

## Scope

Upload files and attach them to either a **member** (`app_user`) or an **aircraft** (`resource`) — medicals,
insurance, POHs, receipts, etc. Files live in **external S3-compatible object storage**; AeroOps stores only a
metadata row + the storage key. Upload and download use **pre-signed URLs**: the browser PUTs/GETs bytes directly
to storage and the Node server only ever signs URLs. **No file bytes pass through Postgres or the app server.**

## Architecture

- **Storage seam** (`packages/api/src/storage/provider.ts`) mirrors the captcha/email/Stripe seam:
  `StorageProvider` interface (`signUploadUrl`, `signDownloadUrl`, `deleteObject`); `stubStorageProvider`
  returns a typed `not_configured` when `STORAGE_*` env is unset (UI shows "file storage not enabled by your
  operator" — never crashes); `realStorageProvider` signs **AWS SigV4** pre-signed URLs hand-rolled with
  `node:crypto` (**no `aws-sdk` / `@aws-sdk` dependency** — zero new heavy deps). Memoized `getStorageProvider()`.
- **`document` table** (migration 0030): `owner_type` (`member`|`aircraft`) + `owner_id`, `storage_key`,
  `filename`, `content_type`, `size_bytes`, free-text `category`, `status` (`pending`→`stored`), `uploaded_by`,
  audited. `org_id` + ENABLE/FORCE RLS + composite `UNIQUE(id, org_id)` + grants. Polymorphic owner is enforced
  by `owner_type` + org-scoped app-level existence checks (a single composite FK can't be polymorphic — documented
  in the migration header).
- **Commands** (`packages/api/src/documents/`, audited, capped — members: `people:access`/`people:manage`;
  aircraft: `fleet:access`/`fleet:manage`): `requestUpload` (validates owner + a content-type/size **allowlist**,
  rejects executables, inserts a `pending` row, returns a signed PUT URL), `confirmUpload` (`pending`→`stored`),
  `listDocuments`, `getDownloadUrl` (short-lived signed GET, **audited — who downloaded what**), `deleteDocument`
  (best-effort object delete + row removal, audited). Portal reads: `getMyDocuments` / `getMyDocumentDownloadUrl`
  (self-scoped, read-only).

## Tenant-isolation guarantee (the crux)

`storage_key` is **ALWAYS server-generated** as `org/<sess.orgId>/…` from the session org id — **never
client-supplied**. An attacker-controlled `ownerId`/`filename` cannot escape the org prefix, so one org can never
sign a URL into another org's storage space. This is enforced in `request-upload.ts` (`generateStorageKey`) and
covered adversarially by the T-ISO tests (`documents-api.test.ts`): org B cannot list, download, or delete org A's
documents; the SigV4 signer itself is unit-tested (`storage-sigv4.test.ts`) with a fake provider — no real S3/HTTP.

## Compliance (HARD LINE — verbatim posture)

Documents are **STORED, NEVER INTERPRETED**: no OCR, no computed FAA/currency/medical-validity/eligibility/
airworthiness determination is derived from a file's contents. `category` is a **free-text operator label** (a
filing-cabinet tab), not a regulatory classification. A stored "Medical" document does **not** mean the software
verified medical currency — a human still makes that call. Mirrors the `member_tag` / squawk / work-order /
lesson-record precedent. `[VERIFY-P1.6-A]`

## Maintainer steps to enable

Set `STORAGE_BUCKET`, `STORAGE_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY` (S3 or any
S3-compatible provider — Cloudflare R2, Backblaze B2, MinIO). Apply migration 0030. Configure the bucket CORS to
allow browser PUT/GET from the app origin. Unset env = feature inert (stub), nothing breaks.

## Deferred (forward seams)

Hosted intake forms (FC's "Hosted Forms with Document Upload"), virus/malware scanning on upload, document-expiry
reminders (would pair with the P1.5 maintenance-due / notification engine), versioning, OCR/extraction, a
`category` edit/correction command, and per-document access grants beyond owner/staff scope.
