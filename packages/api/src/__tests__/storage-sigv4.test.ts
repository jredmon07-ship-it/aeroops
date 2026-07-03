/**
 * storage-sigv4.test.ts — unit tests for the dependency-free SigV4
 * presigned-URL signer (Slice P1.6, storage/sigv4.ts). Pure function, no I/O.
 */
import { describe, it, expect } from 'vitest';
import { presignS3Url } from '../storage/sigv4.js';

const FIXED_NOW = new Date('2026-07-01T12:00:00.000Z');

const BASE_INPUT = {
  method: 'PUT' as const,
  endpoint: 'https://s3.us-east-1.amazonaws.com',
  region: 'us-east-1',
  bucket: 'aeroops-docs',
  key: 'org/11111111-1111-1111-1111-111111111111/member/22222222-2222-2222-2222-222222222222/abc-file.pdf',
  accessKeyId: 'AKIAFAKEEXAMPLE',
  secretAccessKey: 'fakeSecretKeyExample1234567890',
  expiresSeconds: 900,
  now: FIXED_NOW,
};

describe('presignS3Url', () => {
  it('produces a deterministic URL for a fixed clock (regression pin via snapshot)', () => {
    const url = presignS3Url(BASE_INPUT);
    expect(url).toMatchSnapshot();
  });

  it('is pure: the same input always produces the same signature', () => {
    const url1 = presignS3Url(BASE_INPUT);
    const url2 = presignS3Url(BASE_INPUT);
    expect(url1).toBe(url2);
  });

  it('a different key produces a different signature', () => {
    const url1 = presignS3Url(BASE_INPUT);
    const url2 = presignS3Url({ ...BASE_INPUT, key: 'org/other-org-id/member/x/y-file.pdf' });
    expect(url1).not.toBe(url2);
  });

  it('a different secret key produces a different signature (the key material actually matters)', () => {
    const url1 = presignS3Url(BASE_INPUT);
    const url2 = presignS3Url({ ...BASE_INPUT, secretAccessKey: 'differentSecretKey0987654321' });
    expect(url1).not.toBe(url2);
  });

  it('includes UNSIGNED-PAYLOAD posture implicitly (no request body hash param) and the 5 required query params', () => {
    const url = presignS3Url(BASE_INPUT);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(parsed.searchParams.get('X-Amz-Date')).toBe('20260701T120000Z');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(parsed.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(parsed.searchParams.get('X-Amz-Credential')).toBe(
      'AKIAFAKEEXAMPLE/20260701/us-east-1/s3/aws4_request',
    );
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('path-style URL: bucket + key both appear in the URL path (works for AWS AND S3-compatible endpoints)', () => {
    const url = presignS3Url(BASE_INPUT);
    const parsed = new URL(url);
    expect(parsed.pathname.startsWith('/aeroops-docs/org/')).toBe(true);
  });

  it('a custom STORAGE_ENDPOINT (S3-compatible provider) is honored as the origin', () => {
    const url = presignS3Url({ ...BASE_INPUT, endpoint: 'https://my-r2-endpoint.example.com' });
    expect(url.startsWith('https://my-r2-endpoint.example.com/aeroops-docs/')).toBe(true);
  });

  it('GET vs PUT vs DELETE change the signature (method is part of the canonical request)', () => {
    const putUrl = presignS3Url({ ...BASE_INPUT, method: 'PUT' });
    const getUrl = presignS3Url({ ...BASE_INPUT, method: 'GET' });
    const deleteUrl = presignS3Url({ ...BASE_INPUT, method: 'DELETE' });
    const sigOf = (u: string) => new URL(u).searchParams.get('X-Amz-Signature');
    expect(sigOf(putUrl)).not.toBe(sigOf(getUrl));
    expect(sigOf(getUrl)).not.toBe(sigOf(deleteUrl));
  });
});
