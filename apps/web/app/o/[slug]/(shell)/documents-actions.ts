/**
 * documents-actions.ts — Server actions for Slice P1.6 document storage.
 *
 * Shared by both the Fleet detail page (aircraft documents) and the People
 * detail page (member documents) — mirrors dispatch-gate-actions.ts's
 * shell-level placement for a capability shared across two detail surfaces.
 *
 * Wraps:
 *   requestUpload   (people:manage | fleet:manage, by ownerType)
 *   confirmUpload   (people:manage | fleet:manage, resolved from the row)
 *   listDocuments   (people:access | fleet:access, by ownerType)
 *   getDownloadUrl  (people:access | fleet:access, resolved from the row)
 *   deleteDocument  (people:manage | fleet:manage, resolved from the row)
 *
 * Pattern mirrors fleet/actions.ts + dispatch-gate-actions.ts:
 *   1. await auth() → session.
 *   2. Call @aeroops/api fn (requireCapability inside the fn).
 *   3. Map ForbiddenError / UnauthenticatedError → { error: 'forbidden'|'unauthenticated' }.
 *   4. Map ValidationError (code === 'VALIDATION') → { error: 'validation', message }.
 *   5. Pass through ok:false arms as-is (operational refusals are values, not errors).
 *
 * Dates are serialized to ISO strings at the action boundary so RSC → client
 * components receive plain JSON (Dates are NOT JSON-serializable).
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 * RLS + org_id scoping, the content-type allowlist, the size cap, and the
 * server-generated org-prefixed storage_key are ALL enforced inside the
 * @aeroops/api functions — this file is a thin, typed passthrough.
 *
 * COMPLIANCE (HARD LINE) [VERIFY-P1.6-A]: documents are STORED, NEVER
 * INTERPRETED. `category` is a FREE-TEXT operator label, not a computed
 * classification. No FAA/currency/medical-validity/eligibility/
 * airworthiness determination is made anywhere in this path.
 */
'use server';

import { auth } from '@/auth';
import {
  requestUpload,
  confirmUpload,
  listDocuments,
  getDownloadUrl,
  deleteDocument,
} from '@aeroops/api';
import type { DocumentOwnerType, DocumentView } from '@aeroops/api';

// ─── Serialized DocumentView (Dates → string) ────────────────────────────────

export interface SerializedDocumentView {
  id: string;
  ownerType: DocumentOwnerType;
  ownerId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** FREE-TEXT operator label (e.g. "Medical", "Insurance") — NOT a computed classification. */
  category: string | null;
  status: 'pending' | 'stored';
  uploadedBy: string;
  createdAt: string;
}

function serializeDocument(d: DocumentView): SerializedDocumentView {
  return {
    id: d.id,
    ownerType: d.ownerType,
    ownerId: d.ownerId,
    filename: d.filename,
    contentType: d.contentType,
    sizeBytes: d.sizeBytes,
    category: d.category,
    status: d.status,
    uploadedBy: d.uploadedBy,
    createdAt: d.createdAt.toISOString(),
  };
}

// ─── Error shapes ─────────────────────────────────────────────────────────────

import { mapAuthError, isValidationError } from '@/lib/action-errors-result';
import type { AuthErrorResult, ValidationErrorResult, ServerErrorResult } from '@/lib/action-errors-result';

export type { AuthErrorResult, ValidationErrorResult, ServerErrorResult };

function stripPrefix(msg: string): string {
  return msg.replace(/^\[[\w:/-]+\]\s*/, '');
}

// ─── requestUploadAction ──────────────────────────────────────────────────────

export type RequestUploadActionResult =
  | {
      ok: true;
      document: SerializedDocumentView;
      uploadUrl: string;
      uploadMethod: 'PUT';
    }
  | { ok: false; reason: 'owner_not_found' }
  | { ok: false; reason: 'not_configured' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function requestUploadAction(input: {
  ownerType: DocumentOwnerType;
  ownerId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  category?: string;
}): Promise<RequestUploadActionResult> {
  const session = await auth();
  try {
    const result = await requestUpload(session, input);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return {
      ok: true,
      document: serializeDocument(result.document),
      uploadUrl: result.uploadUrl,
      uploadMethod: result.uploadMethod,
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── confirmUploadAction ──────────────────────────────────────────────────────

export type ConfirmUploadActionResult =
  | { ok: true; document: SerializedDocumentView }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function confirmUploadAction(input: {
  documentId: string;
}): Promise<ConfirmUploadActionResult> {
  const session = await auth();
  try {
    const result = await confirmUpload(session, input);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, document: serializeDocument(result.document) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── listDocumentsAction ──────────────────────────────────────────────────────

export type ListDocumentsActionResult =
  | { ok: true; documents: SerializedDocumentView[] }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function listDocumentsAction(input: {
  ownerType: DocumentOwnerType;
  ownerId: string;
}): Promise<ListDocumentsActionResult> {
  const session = await auth();
  try {
    const result = await listDocuments(session, input);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, documents: result.documents.map(serializeDocument) };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── getDownloadUrlAction ─────────────────────────────────────────────────────

export type GetDownloadUrlActionResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_configured' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function getDownloadUrlAction(input: {
  documentId: string;
}): Promise<GetDownloadUrlActionResult> {
  const session = await auth();
  try {
    const result = await getDownloadUrl(session, input);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true, url: result.url };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}

// ─── deleteDocumentAction ─────────────────────────────────────────────────────

export type DeleteDocumentActionResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function deleteDocumentAction(input: {
  documentId: string;
}): Promise<DeleteDocumentActionResult> {
  const session = await auth();
  try {
    const result = await deleteDocument(session, input);
    if (!result.ok) {
      return { ok: false, reason: result.reason };
    }
    return { ok: true };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) {
      return { error: 'validation', message: stripPrefix(err.message) };
    }
    return { error: 'server' };
  }
}
