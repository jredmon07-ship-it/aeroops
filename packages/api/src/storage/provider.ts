/**
 * storage/provider.ts — the object-storage provider SEAM (Slice P1.6).
 *
 * Mirrors the house pattern established by booking/captcha.ts and
 * notifications/email-provider.ts: an
 * interface + a stub that is INERT when unconfigured + a real implementation
 * selected by env, behind a single memoized factory.
 *
 * ── ARCHITECTURE (the load-bearing decision) ──────────────────────────────────
 * Files live in S3-compatible object storage. The app NEVER streams file
 * bytes through the Node server and NEVER stores blobs in Postgres — it only
 * stores metadata rows (packages/db/src/schema/document.ts) + a storage_key,
 * and hands the browser a PRE-SIGNED URL to PUT/GET the object directly
 * against storage. This is the standard scalable pattern and keeps the app
 * server out of the (potentially large, slow) file-transfer path entirely.
 *
 * ── PROVIDER SEAM ─────────────────────────────────────────────────────────────
 *   getStorageProvider() reads STORAGE_BUCKET / STORAGE_REGION /
 *   STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY (+ optional STORAGE_ENDPOINT) from
 *   env:
 *     - Any of bucket/region/accessKey/secretKey unset → StubStorageProvider
 *       (default — every method returns { ok:false, reason:'not_configured' },
 *       NEVER throws). Callers (packages/api/src/documents/*) turn this into a
 *       typed refusal the UI renders as "file storage not enabled by your
 *       operator" — never a crash, never a 500.
 *     - All four set → RealStorageProvider — SigV4 presigned URLs computed
 *       locally (storage/sigv4.ts, node:crypto only — NO aws-sdk / S3 client
 *       library; mirrors the email/captcha "raw fetch, no heavy SDK"
 *       posture). STORAGE_ENDPOINT overrides the default AWS endpoint for
 *       S3-compatible providers (R2/MinIO/Backblaze/etc).
 *   Memoized per-process (module-level singleton) — mirrors getEmailProvider's
 *   memoization rationale. __resetStorageProviderForTests clears it.
 *
 * ── SECURITY: the ORG-PREFIX guarantee lives OUTSIDE this file ────────────────
 * This provider signs whatever `key` it is given — it does NOT itself
 * enforce org scoping. The structural guarantee ("one org can never sign a
 * URL into another org's prefix") lives in packages/api/src/documents/
 * internal.ts's generateStorageKey, which is ALWAYS called with the
 * session's own org_id — never a caller-supplied value. This file is a pure
 * mechanism; documents/*.ts is the policy.
 */
import { presignS3Url } from './sigv4.js';

// ─── Config ───────────────────────────────────────────────────────────────────

/** Upload URLs are short-lived — just long enough for the browser to start the PUT. */
const UPLOAD_URL_TTL_SECONDS = 900; // 15 minutes

/** Download URLs are short-lived and audited (getDownloadUrl records who/when). */
const DOWNLOAD_URL_TTL_SECONDS = 300; // 5 minutes

const DEFAULT_AWS_ENDPOINT = (region: string) => `https://s3.${region}.amazonaws.com`;

// ─── Result types ─────────────────────────────────────────────────────────────

export type StorageSignResult =
  | { ok: true; url: string; method: 'PUT' | 'GET'; expiresAt: Date }
  | { ok: false; reason: 'not_configured' };

export type StorageDeleteResult =
  | { ok: true }
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'provider_error'; message: string };

// ─── Interface ────────────────────────────────────────────────────────────────

/**
 * StorageProvider — the abstraction boundary for object storage.
 *
 * CONTRACT:
 *   - StubStorageProvider's methods NEVER throw — unconfigured always returns
 *     { ok:false, reason:'not_configured' } as a normal, renderable value.
 *   - RealStorageProvider.signUploadUrl / signDownloadUrl are PURE local
 *     computation (no network call — SigV4 presigning needs no round trip)
 *     and so also never throw on the happy path.
 *   - RealStorageProvider.deleteObject makes a real HTTP call and can return
 *     { ok:false, reason:'provider_error' } — callers MUST treat this as
 *     best-effort (see documents/delete-document.ts: the metadata row is
 *     still removed even if the underlying object delete fails).
 */
export interface StorageProvider {
  signUploadUrl(input: { key: string; contentType: string }): Promise<StorageSignResult>;
  signDownloadUrl(input: { key: string }): Promise<StorageSignResult>;
  deleteObject(input: { key: string }): Promise<StorageDeleteResult>;
}

// ─── Stub (default — unconfigured) ───────────────────────────────────────────

/**
 * StubStorageProvider — the DEFAULT implementation.
 *
 * Used when STORAGE_* env vars are not fully configured. Every method
 * resolves to { ok:false, reason:'not_configured' } — NEVER throws, NEVER
 * makes a network call. Callers render this as "file storage not enabled by
 * your operator" (never a crash), same posture as StubEmailProvider /
 * NoopCaptchaVerifier's "byte-identical when unconfigured" contract.
 */
export class StubStorageProvider implements StorageProvider {
  async signUploadUrl(): Promise<StorageSignResult> {
    return { ok: false, reason: 'not_configured' };
  }

  async signDownloadUrl(): Promise<StorageSignResult> {
    return { ok: false, reason: 'not_configured' };
  }

  async deleteObject(): Promise<StorageDeleteResult> {
    return { ok: false, reason: 'not_configured' };
  }
}

// ─── Real implementation (S3-compatible, SigV4 presigned URLs) ──────────────

export class RealStorageProvider implements StorageProvider {
  private readonly bucket: string;
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly endpoint: string;

  constructor(
    bucket: string,
    region: string,
    accessKeyId: string,
    secretAccessKey: string,
    endpoint?: string,
  ) {
    this.bucket = bucket;
    this.region = region;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.endpoint = endpoint || DEFAULT_AWS_ENDPOINT(region);
  }

  private sign(method: 'GET' | 'PUT' | 'DELETE', key: string, expiresSeconds: number): string {
    return presignS3Url({
      method,
      endpoint: this.endpoint,
      region: this.region,
      bucket: this.bucket,
      key,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      expiresSeconds,
    });
  }

  async signUploadUrl(input: { key: string; contentType: string }): Promise<StorageSignResult> {
    // contentType is recorded in the document row (documents/internal.ts) but
    // is NOT a signed header here — see sigv4.ts header for the rationale.
    void input.contentType;
    const url = this.sign('PUT', input.key, UPLOAD_URL_TTL_SECONDS);
    return {
      ok: true,
      url,
      method: 'PUT',
      expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000),
    };
  }

  async signDownloadUrl(input: { key: string }): Promise<StorageSignResult> {
    const url = this.sign('GET', input.key, DOWNLOAD_URL_TTL_SECONDS);
    return {
      ok: true,
      url,
      method: 'GET',
      expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000),
    };
  }

  async deleteObject(input: { key: string }): Promise<StorageDeleteResult> {
    const url = this.sign('DELETE', input.key, 60);
    try {
      const res = await fetch(url, { method: 'DELETE' });
      // 204/200 = deleted; 404 = already gone (treat as success — idempotent delete).
      if (res.ok || res.status === 404) {
        return { ok: true };
      }
      return { ok: false, reason: 'provider_error', message: `HTTP ${res.status}` };
    } catch (err) {
      return {
        ok: false,
        reason: 'provider_error',
        message: err instanceof Error ? err.message : 'unknown error',
      };
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

let _memoizedProvider: StorageProvider | null = null;

/**
 * getStorageProvider — factory that reads process.env and returns the
 * configured StorageProvider.
 *
 * Resolution:
 *   1. Any of STORAGE_BUCKET / STORAGE_REGION / STORAGE_ACCESS_KEY /
 *      STORAGE_SECRET_KEY absent → StubStorageProvider.
 *   2. All four present → RealStorageProvider(bucket, region, accessKeyId,
 *      secretAccessKey, STORAGE_ENDPOINT [optional]).
 */
export function getStorageProvider(): StorageProvider {
  if (_memoizedProvider) return _memoizedProvider;

  const bucket = process.env['STORAGE_BUCKET'];
  const region = process.env['STORAGE_REGION'];
  const accessKeyId = process.env['STORAGE_ACCESS_KEY'];
  const secretAccessKey = process.env['STORAGE_SECRET_KEY'];
  const endpoint = process.env['STORAGE_ENDPOINT'];

  if (!bucket || !region || !accessKeyId || !secretAccessKey) {
    _memoizedProvider = new StubStorageProvider();
    return _memoizedProvider;
  }

  _memoizedProvider = new RealStorageProvider(bucket, region, accessKeyId, secretAccessKey, endpoint);
  return _memoizedProvider;
}

/** Test-only: reset the memoized provider so tests can reconfigure env + re-resolve. */
export function __resetStorageProviderForTests(): void {
  _memoizedProvider = null;
}
