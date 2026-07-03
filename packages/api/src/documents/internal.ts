/**
 * documents/internal.ts — shared, NOT-publicly-exported helpers for the
 * document-storage slice (P1.6): storage-key generation (the tenant-
 * isolation guarantee), the polymorphic owner-existence check (the
 * migration-0030-documented FK-substitute), the content-type/size allowlist,
 * and view mapping.
 *
 * NOT exported from @aeroops/api's index.ts (except the types re-exported
 * alongside the command functions) — mirrors calendar/internal.ts /
 * portal/internal.ts's pattern: pure tx-scoped helpers the command files
 * import directly.
 */
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { appUser, resource, document } from '@aeroops/db';
import type { AnyDb, DocumentSelect } from '@aeroops/db';
import type { DocumentOwnerType, DocumentView } from './types.js';

// ─── UUID validation (shared across all documents/*.ts command files) ────────

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Content-type ALLOWLIST + size cap ────────────────────────────────────────
//
// ALLOWLIST (not a blocklist) — the safer default for arbitrary uploads.
// Executables, scripts, and archives are never accepted. Extend deliberately.

export const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

/** 25 MB — generous for scanned certificates/insurance docs/POH PDFs, small
 * enough to keep the pre-signed-URL flow snappy. */
export const MAX_DOCUMENT_SIZE_BYTES = 25 * 1024 * 1024;

export function isAllowedContentType(contentType: string): boolean {
  return ALLOWED_CONTENT_TYPES.has(contentType);
}

// ─── storage_key generation — THE tenant-isolation guarantee ─────────────────

/**
 * sanitizeFilenameForKey — strips path separators/control characters from a
 * filename before it becomes part of the storage KEY (path component). The
 * ORIGINAL filename is still stored verbatim in document.filename for
 * display — this only affects the object-storage path string.
 */
function sanitizeFilenameForKey(filename: string): string {
  const cleaned = filename
    .replace(/[/\\]/g, '_')
    .replace(/[^\w.\-]/g, '_')
    .slice(-80);
  return cleaned.length > 0 ? cleaned : 'file';
}

/**
 * generateStorageKey — THE structural tenant-isolation guarantee for the
 * object-storage side (migration 0030 §4). `orgId` MUST ALWAYS be the
 * session's own org_id (sess.orgId from withSessionOrgContextWithDb) —
 * NEVER a caller-supplied value. Every command in this slice calls this
 * with sess.orgId only; ownerId/filename come from validated request input
 * but can never influence which org's prefix the resulting key falls under.
 *
 * Format: org/<orgId>/<ownerType>/<ownerId>/<random-uuid>-<sanitized-filename>
 * The random UUID (122 bits of entropy) makes key collision/enumeration
 * infeasible even for a known owner.
 */
export function generateStorageKey(
  orgId: string,
  ownerType: DocumentOwnerType,
  ownerId: string,
  filename: string,
): string {
  const safeName = sanitizeFilenameForKey(filename);
  return `org/${orgId}/${ownerType}/${ownerId}/${randomUUID()}-${safeName}`;
}

// ─── Owner resolution (polymorphic — no DB FK, see migration 0030 §2) ────────

export type DocumentOwnerResolution = { ok: true } | { ok: false; reason: 'owner_not_found' };

/**
 * resolveDocumentOwner — verifies `ownerId` exists, in the caller's own org,
 * as the RIGHT KIND of entity for `ownerType`. `tx` MUST already be
 * org-scoped (withSessionOrgContextWithDb) — this function relies on RLS to
 * keep the read within the caller's org; it does not itself take an orgId
 * parameter.
 *
 * This is the app-level backstop the migration-0030 header documents in
 * place of a structural FK (which Postgres cannot express for a two-target
 * polymorphic association) — see document.ts schema file header.
 */
export async function resolveDocumentOwner(
  tx: AnyDb,
  ownerType: DocumentOwnerType,
  ownerId: string,
): Promise<DocumentOwnerResolution> {
  if (ownerType === 'member') {
    const rows = await tx
      .select({ id: appUser.id })
      .from(appUser)
      .where(eq(appUser.id, ownerId))
      .limit(1);
    return rows[0] ? { ok: true } : { ok: false, reason: 'owner_not_found' };
  }

  const rows = await tx
    .select({ id: resource.id })
    .from(resource)
    .where(and(eq(resource.id, ownerId), eq(resource.kind, 'aircraft')))
    .limit(1);
  return rows[0] ? { ok: true } : { ok: false, reason: 'owner_not_found' };
}

// ─── View mapping ─────────────────────────────────────────────────────────────

export function toDocumentView(row: DocumentSelect): DocumentView {
  return {
    id: row.id,
    ownerType: row.ownerType as DocumentOwnerType,
    ownerId: row.ownerId,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    category: row.category,
    status: row.status as DocumentView['status'],
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt,
  };
}

// ─── Capability mapping ────────────────────────────────────────────────────────
//
// members: people:access (read) / people:manage (write)
// aircraft: fleet:access (read) / fleet:manage (write)
// (confirmed against packages/core/src/capabilities.ts — Slice 5/6 caps.)

export function ownerReadCapability(ownerType: DocumentOwnerType): 'people:access' | 'fleet:access' {
  return ownerType === 'member' ? 'people:access' : 'fleet:access';
}

export function ownerWriteCapability(ownerType: DocumentOwnerType): 'people:manage' | 'fleet:manage' {
  return ownerType === 'member' ? 'people:manage' : 'fleet:manage';
}

// Re-export the table for command files that need direct query access
// (keeps every documents/*.ts import from '@aeroops/db' consistent/minimal).
export { document };
