/**
 * stripe-webhook-verify.test.ts — unit + property tests for
 * integrations/stripe/webhook-verify.ts (Slice B3-foundation).
 *
 * NON-NEGOTIABLE per the task: "valid sig passes, tampered payload fails,
 * replayed timestamp outside tolerance fails" — all three are covered, plus
 * additional edge cases (missing header, malformed header, no v1, multi-sig
 * rotation window, v0-only header rejected).
 */

import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { verifyStripeSignature } from '../integrations/stripe/webhook-verify.js';

const SECRET = 'whsec_test_secret_not_a_real_key';

function sign(payload: string, t: number, secret: string = SECRET): string {
  const signedPayload = `${t}.${payload}`;
  return createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
}

function header(payload: string, t: number, secret: string = SECRET): string {
  return `t=${t},v1=${sign(payload, t, secret)}`;
}

describe('verifyStripeSignature — valid signature passes', () => {
  it('a correctly-signed payload at the current time verifies', () => {
    const payload = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });
    const nowSeconds = 1_700_000_000;
    const h = header(payload, nowSeconds);
    const result = verifyStripeSignature(payload, h, SECRET, { nowSeconds });
    expect(result).toEqual({ ok: true });
  });

  it('multiple v1 signatures (secret-rotation window): matches the SECOND one', () => {
    const payload = '{"id":"evt_2"}';
    const nowSeconds = 1_700_000_000;
    const goodSig = sign(payload, nowSeconds, SECRET);
    const staleSig = sign(payload, nowSeconds, 'whsec_old_rotated_out');
    const h = `t=${nowSeconds},v1=${staleSig},v1=${goodSig}`;
    const result = verifyStripeSignature(payload, h, SECRET, { nowSeconds });
    expect(result).toEqual({ ok: true });
  });

  it('extra v0 (legacy) scheme alongside a valid v1 is ignored, still verifies', () => {
    const payload = '{"id":"evt_3"}';
    const nowSeconds = 1_700_000_000;
    const goodSig = sign(payload, nowSeconds, SECRET);
    const h = `t=${nowSeconds},v1=${goodSig},v0=deadbeef`;
    const result = verifyStripeSignature(payload, h, SECRET, { nowSeconds });
    expect(result).toEqual({ ok: true });
  });

  it('timestamp exactly at the tolerance boundary still verifies', () => {
    const payload = '{"id":"evt_boundary"}';
    const nowSeconds = 1_700_000_000;
    const t = nowSeconds - 300; // exactly at the default 300s tolerance
    const h = header(payload, t);
    const result = verifyStripeSignature(payload, h, SECRET, { nowSeconds });
    expect(result).toEqual({ ok: true });
  });
});

describe('verifyStripeSignature — tampered payload fails', () => {
  it('a signature computed over a DIFFERENT payload fails', () => {
    const originalPayload = '{"id":"evt_orig","amount":1000}';
    const tamperedPayload = '{"id":"evt_orig","amount":9999999}';
    const nowSeconds = 1_700_000_000;
    const h = header(originalPayload, nowSeconds); // signed over the ORIGINAL
    const result = verifyStripeSignature(tamperedPayload, h, SECRET, { nowSeconds });
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('a single tampered byte in the payload invalidates the signature', () => {
    const payload = '{"id":"evt_x","status":"succeeded"}';
    const nowSeconds = 1_700_000_000;
    const h = header(payload, nowSeconds);
    const tampered = payload.replace('succeeded', 'succeeeded'); // one extra char
    const result = verifyStripeSignature(tampered, h, SECRET, { nowSeconds });
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('signed with the WRONG secret fails', () => {
    const payload = '{"id":"evt_wrong_secret"}';
    const nowSeconds = 1_700_000_000;
    const h = header(payload, nowSeconds, 'whsec_not_the_configured_secret');
    const result = verifyStripeSignature(payload, h, SECRET, { nowSeconds });
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('a garbage (non-hex) v1 value fails cleanly (no throw)', () => {
    const payload = '{"id":"evt_garbage"}';
    const nowSeconds = 1_700_000_000;
    const h = `t=${nowSeconds},v1=not-hex-at-all!!`;
    const result = verifyStripeSignature(payload, h, SECRET, { nowSeconds });
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });

  it('a wrong-length hex v1 value fails cleanly (no throw)', () => {
    const payload = '{"id":"evt_shortsig"}';
    const nowSeconds = 1_700_000_000;
    const h = `t=${nowSeconds},v1=deadbeef`;
    const result = verifyStripeSignature(payload, h, SECRET, { nowSeconds });
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
  });
});

describe('verifyStripeSignature — replayed/stale timestamp fails', () => {
  it('a timestamp 301s in the past (just past the default 300s tolerance) fails', () => {
    const payload = '{"id":"evt_stale"}';
    const nowSeconds = 1_700_000_000;
    const t = nowSeconds - 301;
    const h = header(payload, t);
    const result = verifyStripeSignature(payload, h, SECRET, { nowSeconds });
    expect(result).toEqual({ ok: false, reason: 'timestamp_too_old' });
  });

  it('a timestamp far in the FUTURE also fails (clock-skew/replay both ways)', () => {
    const payload = '{"id":"evt_future"}';
    const nowSeconds = 1_700_000_000;
    const t = nowSeconds + 10_000;
    const h = header(payload, t);
    const result = verifyStripeSignature(payload, h, SECRET, { nowSeconds });
    expect(result).toEqual({ ok: false, reason: 'timestamp_too_old' });
  });

  it('a custom (narrower) tolerance is respected', () => {
    const payload = '{"id":"evt_custom_tol"}';
    const nowSeconds = 1_700_000_000;
    const t = nowSeconds - 61;
    const h = header(payload, t);
    const result = verifyStripeSignature(payload, h, SECRET, { nowSeconds, toleranceSeconds: 60 });
    expect(result).toEqual({ ok: false, reason: 'timestamp_too_old' });
  });

  it('replaying the SAME valid signature+timestamp after tolerance expires fails (time moves on)', () => {
    const payload = '{"id":"evt_replay"}';
    const originalNow = 1_700_000_000;
    const h = header(payload, originalNow);
    // Verified once at issuance — valid.
    expect(verifyStripeSignature(payload, h, SECRET, { nowSeconds: originalNow })).toEqual({ ok: true });
    // Replayed 10 minutes later — the SAME header/payload now fails.
    const laterNow = originalNow + 600;
    expect(verifyStripeSignature(payload, h, SECRET, { nowSeconds: laterNow })).toEqual({
      ok: false,
      reason: 'timestamp_too_old',
    });
  });
});

describe('verifyStripeSignature — structural edge cases', () => {
  it('missing header (null) ⇒ missing_header', () => {
    expect(verifyStripeSignature('{}', null, SECRET)).toEqual({ ok: false, reason: 'missing_header' });
  });

  it('missing header (undefined) ⇒ missing_header', () => {
    expect(verifyStripeSignature('{}', undefined, SECRET)).toEqual({ ok: false, reason: 'missing_header' });
  });

  it('empty string header ⇒ missing_header', () => {
    expect(verifyStripeSignature('{}', '', SECRET)).toEqual({ ok: false, reason: 'missing_header' });
  });

  it('header with no t= field ⇒ malformed_header', () => {
    expect(verifyStripeSignature('{}', 'v1=abcd1234', SECRET)).toEqual({ ok: false, reason: 'malformed_header' });
  });

  it('header with non-numeric t= ⇒ malformed_header', () => {
    expect(verifyStripeSignature('{}', 't=notanumber,v1=abcd1234', SECRET)).toEqual({
      ok: false,
      reason: 'malformed_header',
    });
  });

  it('header with t= but NO v1= (only v0=) ⇒ no_v1_signature (downgrade-attack rejected)', () => {
    const nowSeconds = 1_700_000_000;
    expect(
      verifyStripeSignature('{}', `t=${nowSeconds},v0=deadbeef`, SECRET, { nowSeconds }),
    ).toEqual({ ok: false, reason: 'no_v1_signature' });
  });

  it('header with ONLY t= and nothing else ⇒ no_v1_signature', () => {
    const nowSeconds = 1_700_000_000;
    expect(verifyStripeSignature('{}', `t=${nowSeconds}`, SECRET, { nowSeconds })).toEqual({
      ok: false,
      reason: 'no_v1_signature',
    });
  });
});

// ─── Property tests ─────────────────────────────────────────────────────────

describe('P1 — a correctly-signed (payload, timestamp, secret) triple always verifies', () => {
  it('holds for arbitrary JSON-ish payload strings and timestamps within tolerance', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 500 }),
        fc.integer({ min: 1_600_000_000, max: 1_900_000_000 }),
        (payload, t) => {
          const h = header(payload, t);
          const result = verifyStripeSignature(payload, h, SECRET, { nowSeconds: t });
          expect(result).toEqual({ ok: true });
        },
      ),
    );
  });
});

describe('P2 — any single-character mutation of the payload invalidates the signature', () => {
  it('holds for arbitrary non-empty payloads', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.length > 0),
        fc.integer({ min: 1_600_000_000, max: 1_900_000_000 }),
        fc.integer({ min: 0, max: 199 }),
        (payload, t, mutateAtRaw) => {
          const mutateAt = mutateAtRaw % payload.length;
          const original = payload;
          // Flip one character's code point by 1 (wrapping) to guarantee a change.
          const chars = original.split('');
          const code = chars[mutateAt]!.codePointAt(0) ?? 65;
          chars[mutateAt] = String.fromCodePoint((code + 1) % 0x10ffff || 65);
          const mutated = chars.join('');
          if (mutated === original) return; // extremely unlikely, but skip if no-op

          const h = header(original, t);
          const result = verifyStripeSignature(mutated, h, SECRET, { nowSeconds: t });
          expect(result).toEqual({ ok: false, reason: 'signature_mismatch' });
        },
      ),
    );
  });
});

describe('P3 — timestamps outside tolerance always fail, inside always pass (given a valid sig)', () => {
  it('holds across the tolerance boundary', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 100 }),
        fc.integer({ min: 1_700_000_000, max: 1_700_000_000 }),
        fc.integer({ min: -1000, max: 1000 }),
        (payload, t, deltaSeconds) => {
          const h = header(payload, t);
          const nowSeconds = t + deltaSeconds;
          const result = verifyStripeSignature(payload, h, SECRET, { nowSeconds, toleranceSeconds: 300 });
          if (Math.abs(deltaSeconds) <= 300) {
            expect(result).toEqual({ ok: true });
          } else {
            expect(result).toEqual({ ok: false, reason: 'timestamp_too_old' });
          }
        },
      ),
    );
  });
});
