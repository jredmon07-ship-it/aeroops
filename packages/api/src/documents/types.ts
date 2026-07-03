/**
 * documents/types.ts — public result/IO types for the document-storage write
 * + read paths (Slice P1.6). Framework-agnostic; no I/O.
 *
 * DESIGN POSTURE (mirrors maintenance-item-types.ts / work-order-types.ts):
 *   - Operational refusals (not_found, owner_not_found, not_configured) are
 *     RETURNED as discriminated-union values, NOT thrown. The UI renders
 *     them — 'not_configured' becomes "file storage not enabled by your
 *     operator", never a crash.
 *   - Auth failures are THROWN as ForbiddenError / UnauthenticatedError.
 *   - Input-shape / allowlist / size-cap failures are THROWN as ValidationError.
 *
 * COMPLIANCE (HARD LINE): a document is uploaded-file METADATA + a pointer
 * into external object storage. This slice NEVER reads, parses, or
 * interprets a file's contents — no OCR, no computed FAA/currency/medical-
 * validity/eligibility/airworthiness determination. `category` is a
 * FREE-TEXT operator label (a filing-cabinet tab), not a regulatory
 * classification. [VERIFY-P1.6-A]
 */

export type DocumentOwnerType = 'member' | 'aircraft';
export type DocumentStatus = 'pending' | 'stored';

// ─── DocumentView ─────────────────────────────────────────────────────────────

/**
 * DocumentView — a document row as seen by API callers.
 *
 * Write-once fields: ownerType, ownerId, filename, contentType, sizeBytes,
 * category, uploadedBy. Mutable: status (pending → stored via confirmUpload
 * only).
 */
export interface DocumentView {
  id: string;
  ownerType: DocumentOwnerType;
  ownerId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  category: string | null;
  status: DocumentStatus;
  uploadedBy: string;
  createdAt: Date;
}

// ─── requestUpload result ─────────────────────────────────────────────────────

/**
 * RequestUploadResult — discriminated union for requestUpload.
 *
 *   ok:true                     → 'pending' row inserted; audit written;
 *                                  caller receives a pre-signed PUT URL.
 *   ok:false owner_not_found    → ownerId does not exist (or is not the
 *                                  right kind) in the caller's org.
 *   ok:false not_configured     → STORAGE_* env is not fully set. NO row is
 *                                  inserted in this case (nothing to point
 *                                  at) — the caller sees a clean refusal.
 *
 * Everything else invalid (bad shape, disallowed content-type, over the
 * size cap) THROWS ValidationError.
 */
export type RequestUploadResult =
  | {
      ok: true;
      document: DocumentView;
      uploadUrl: string;
      uploadMethod: 'PUT';
      expiresAt: Date;
    }
  | { ok: false; reason: 'owner_not_found' }
  | { ok: false; reason: 'not_configured' };

// ─── confirmUpload result ─────────────────────────────────────────────────────

/**
 * ConfirmUploadResult — discriminated union for confirmUpload.
 *
 *   ok:true            → status flipped 'pending' → 'stored'; audit written.
 *                         Idempotent: an already-'stored' document returns
 *                         ok:true with NO duplicate audit row (retry-safe).
 *   ok:false not_found → document not visible in the session org.
 */
export type ConfirmUploadResult =
  | { ok: true; document: DocumentView }
  | { ok: false; reason: 'not_found' };

// ─── listDocuments result ─────────────────────────────────────────────────────

/**
 * ListDocumentsResult — discriminated union for listDocuments.
 *
 *   ok:true            → metadata rows for the given owner, newest-first.
 *   ok:false not_found → the owner does not exist (or is not the right
 *                         kind) in the caller's org.
 */
export type ListDocumentsResult =
  | { ok: true; documents: DocumentView[] }
  | { ok: false; reason: 'not_found' };

// ─── getDownloadUrl result ─────────────────────────────────────────────────────

/**
 * GetDownloadUrlResult — discriminated union for getDownloadUrl.
 *
 *   ok:true                 → short-lived pre-signed GET URL; audit written
 *                              ('document.downloaded' — who downloaded what).
 *   ok:false not_found      → document not visible in the session org.
 *   ok:false not_configured → STORAGE_* env is not fully set.
 */
export type GetDownloadUrlResult =
  | { ok: true; url: string; expiresAt: Date; document: DocumentView }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_configured' };

// ─── deleteDocument result ─────────────────────────────────────────────────────

/**
 * DeleteDocumentResult — discriminated union for deleteDocument.
 *
 *   ok:true            → the underlying object delete is BEST-EFFORT (see
 *                         delete-document.ts); the metadata row is always
 *                         removed on ok:true. Audit written.
 *   ok:false not_found → document not visible in the session org.
 */
export type DeleteDocumentResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' };
