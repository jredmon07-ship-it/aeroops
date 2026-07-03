/**
 * documents/request-upload.ts — requestUpload write path (Slice P1.6).
 *
 * Begins a direct-to-storage upload: validates the caller-supplied metadata
 * (owner, filename, content-type against an ALLOWLIST, size against a cap),
 * verifies the owner exists in the caller's own org, generates a
 * server-side, org-prefixed storage_key (NEVER client-supplied — see
 * documents/internal.ts generateStorageKey), inserts a 'pending' document
 * row, and returns a short-lived pre-signed PUT URL for the BROWSER to
 * upload the file bytes directly to object storage — the file never passes
 * through this server.
 *
 * GUARANTEES:
 *   - authz FIRST: ownerType is caller-supplied directly (not row-dependent),
 *     so the SPECIFIC write capability (people:manage | fleet:manage) is
 *     knowable and enforced before any data access.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - content-type ALLOWLIST + size cap enforced BEFORE any DB/provider call
 *     → ValidationError on violation (never a silently-accepted executable).
 *   - owner must exist, in-org, as the right kind → owner_not_found.
 *   - storage_key is ALWAYS `org/<sess.orgId>/...` — the tenant-isolation
 *     guarantee (migration 0030 §4). No document row is inserted unless a
 *     signed URL was successfully produced (not_configured → no orphan row).
 *   - Audited 'document.upload_requested'.
 *
 * TWO CALLING FORMS:
 *   requestUpload(session, input, storageProvider?)          — app code.
 *   requestUploadWithDb(db, session, input, storageProvider?) — tests.
 */
import { z } from 'zod';
import { auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';
import { getStorageProvider } from '../storage/provider.js';
import type { StorageProvider } from '../storage/provider.js';
import {
  document,
  UUID_RE,
  MAX_DOCUMENT_SIZE_BYTES,
  isAllowedContentType,
  generateStorageKey,
  resolveDocumentOwner,
  toDocumentView,
  ownerWriteCapability,
} from './internal.js';
import type { RequestUploadResult } from './types.js';

const requestUploadInputSchema = z.object({
  ownerType: z.enum(['member', 'aircraft']),
  ownerId: z.string().regex(UUID_RE, { message: 'ownerId must be a UUID' }),
  filename: z.string().trim().min(1, { message: 'filename must not be empty' }).max(255),
  contentType: z.string().trim().min(1, { message: 'contentType must not be empty' }),
  sizeBytes: z.number().int().positive().finite(),
  category: z.string().trim().max(100).optional(),
});

export type RequestUploadInput = z.infer<typeof requestUploadInputSchema>;

// ─── Shared implementation ────────────────────────────────────────────────────

async function _requestUploadImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
  storageProvider: StorageProvider = getStorageProvider(),
): Promise<RequestUploadResult> {
  const parsed = requestUploadInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[documents] invalid requestUpload input: ${first?.message ?? 'unknown'}`);
  }
  const { ownerType, ownerId, filename, contentType, sizeBytes, category } = parsed.data;

  // 1. AUTHZ FIRST — ownerType is known from input directly.
  requireCapability(session, ownerWriteCapability(ownerType));

  // 2. VALIDATE the allowlist + size cap (app-code backstop; the browser's
  //    PUT is unconstrained by the signature — see storage/sigv4.ts header).
  if (!isAllowedContentType(contentType)) {
    throw new ValidationError(
      `[documents] content type '${contentType}' is not allowed for upload.`,
    );
  }
  if (sizeBytes > MAX_DOCUMENT_SIZE_BYTES) {
    throw new ValidationError(
      `[documents] file is too large (${sizeBytes} bytes); the max is ${MAX_DOCUMENT_SIZE_BYTES} bytes.`,
    );
  }

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3a. Owner must exist, in-org, as the right kind.
    const ownerResult = await resolveDocumentOwner(tx, ownerType, ownerId);
    if (!ownerResult.ok) {
      return { ok: false, reason: 'owner_not_found' } as const;
    }

    // 3b. storage_key is ALWAYS server-generated from sess.orgId — NEVER
    //     client input. THE tenant-isolation guarantee.
    const storageKey = generateStorageKey(sess.orgId, ownerType, ownerId, filename);

    // 3c. Sign BEFORE inserting — if storage is unconfigured, no orphan row.
    const signResult = await storageProvider.signUploadUrl({ key: storageKey, contentType });
    if (!signResult.ok) {
      return { ok: false, reason: 'not_configured' } as const;
    }

    // 3d. INSERT the 'pending' metadata row.
    const [inserted] = await tx
      .insert(document)
      .values({
        orgId: sess.orgId,
        ownerType,
        ownerId,
        storageKey,
        filename,
        contentType,
        sizeBytes,
        category: category ?? null,
        status: 'pending',
        uploadedBy: sess.userId,
      })
      .returning();

    // 3e. Audit row.
    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'document.upload_requested',
      entityType: 'document',
      entityId: inserted!.id,
      metadata: { ownerType, ownerId, filename, contentType, sizeBytes, category: category ?? null },
    });

    return {
      ok: true,
      document: toDocumentView(inserted!),
      uploadUrl: signResult.url,
      uploadMethod: 'PUT',
      expiresAt: signResult.expiresAt,
    } as const;
  });
}

// ─── App-code form ────────────────────────────────────────────────────────────

export async function requestUpload(
  session: AppSession | null | undefined,
  input: unknown,
  storageProvider?: StorageProvider,
): Promise<RequestUploadResult> {
  const db = await getDb();
  return _requestUploadImpl(db, session, input, storageProvider);
}

// ─── Test/injectable form ─────────────────────────────────────────────────────

export async function requestUploadWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  storageProvider?: StorageProvider,
): Promise<RequestUploadResult> {
  return _requestUploadImpl(db, session, input, storageProvider);
}
