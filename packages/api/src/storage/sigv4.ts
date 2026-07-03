/**
 * storage/sigv4.ts — a dependency-free AWS Signature Version 4 QUERY-STRING
 * (presigned URL) signer for S3-compatible object storage (Slice P1.6).
 *
 * Deliberately NOT using the aws-sdk (or any S3 client library) — this repo's
 * standing posture is "no heavy provider SDKs" (mirrors integrations/stripe/
 * client.ts and notifications/email-provider.ts, both raw `fetch`). SigV4
 * query-string auth needs only node:crypto (HMAC-SHA256 + SHA256), so a thin
 * ~120-line signer keeps the zero-heavy-dependency posture while still being
 * a correct, standard implementation.
 *
 * CONFIRMED (2026-07, docs.aws.amazon.com/AmazonS3 SigV4 query-string auth):
 *   - CanonicalRequest = METHOD \n CanonicalURI \n CanonicalQueryString \n
 *       CanonicalHeaders \n SignedHeaders \n HashedPayload
 *   - HashedPayload = "UNSIGNED-PAYLOAD" for presigned URLs (the payload is
 *       never available to hash at sign time — the browser sends it later).
 *   - StringToSign = "AWS4-HMAC-SHA256" \n AmzDate \n CredentialScope \n
 *       Hex(SHA256(CanonicalRequest))
 *   - Signing key = HMAC chain: kDate → kRegion → kService("s3") →
 *       kSigning("aws4_request"); Signature = Hex(HMAC(kSigning, StringToSign)).
 *   - SignedHeaders here is 'host' ONLY — content-type is NOT signed, so the
 *     browser's PUT does not need to send a byte-identical Content-Type
 *     header for the signature to validate (simplicity trade-off; the actual
 *     authorization boundary is the URL/key, not the content-type value).
 *
 * PATH-STYLE URLs are used unconditionally (`${origin}/${bucket}/${key}`) —
 * this works uniformly for real AWS S3 AND for S3-compatible providers
 * (R2/MinIO/Backblaze/etc via STORAGE_ENDPOINT), which is why the STORAGE_*
 * env seam includes an optional STORAGE_ENDPOINT override (see provider.ts).
 *
 * PURE / NO I/O: presignS3Url performs no network calls — it only computes a
 * URL string. `now` is injectable so tests are deterministic.
 */
import { createHash, createHmac } from 'node:crypto';

export interface SigV4PresignInput {
  method: 'GET' | 'PUT' | 'DELETE';
  /** Origin only, e.g. "https://s3.us-east-1.amazonaws.com" or a custom endpoint. No trailing slash. */
  endpoint: string;
  region: string;
  bucket: string;
  /** The raw (unencoded) object key/path — e.g. "org/<uuid>/member/<uuid>/<uuid>-file.pdf". */
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** 1..604800 (7 days) per the SigV4 spec. */
  expiresSeconds: number;
  /** Injectable clock for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
}

// ─── Low-level helpers ────────────────────────────────────────────────────────

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** RFC 3986 URI-encode (stricter than encodeURIComponent — also escapes !'()*). */
function rfc3986Encode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Encode a path (`/`-separated) segment-by-segment, preserving the slashes. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => rfc3986Encode(segment))
    .join('/');
}

function amzDateParts(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

// ─── presignS3Url ─────────────────────────────────────────────────────────────

export function presignS3Url(input: SigV4PresignInput): string {
  const now = input.now ?? new Date();
  const { amzDate, dateStamp } = amzDateParts(now);
  const credentialScope = `${dateStamp}/${input.region}/s3/aws4_request`;
  const credential = `${input.accessKeyId}/${credentialScope}`;

  const origin = input.endpoint.replace(/\/+$/, '');
  const host = new URL(origin).host;
  const canonicalUri = encodePath(`/${input.bucket}/${input.key}`);

  const queryParams: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', credential],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(input.expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  queryParams.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const canonicalQueryString = queryParams
    .map(([k, v]) => `${rfc3986Encode(k)}=${rfc3986Encode(v)}`)
    .join('&');

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = 'host';

  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  return `${origin}${canonicalUri}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}
