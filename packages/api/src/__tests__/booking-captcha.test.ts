/**
 * booking-captcha.test.ts — Slice PB-LR.B: CAPTCHA verification seam tests.
 *
 * COVERAGE (per spec PB-LR.B):
 *
 *   NOOP-1  Unconfigured (no env vars) → NoopCaptchaVerifier → byte-identical to PB1.
 *           The INSERT happens; result is { ok:true }; row count increases.
 *
 *   NOOP-2  captchaToken absent from body → NoopCaptchaVerifier → INSERT happens
 *           (existing callers that omit captchaToken are unaffected).
 *
 *   VALID-1 Fake verifier returning true → INSERT happens, { ok:true }.
 *
 *   INVALID-1 Fake verifier returning false → NO insert, { ok:true } (anti-enum
 *             silent-drop — same shape as honeypot/rate-guard drops).
 *
 *   FAILOPEN-1 Verifier throws → FAIL-OPEN → INSERT happens, { ok:true }.
 *              Provider outage must NOT kill lead capture.
 *
 *   OPT-1   captchaToken field is optional: body without it validates (zod schema).
 *
 *   ORDER-1 Hook runs BEFORE any DB access on a drop:
 *           honeypot-drop and captcha-drop both return before resolveOrgBySlug.
 *           We verify this by using an unknown slug — if DB were accessed the
 *           result would be { ok:false, reason:'unavailable' }, but since the
 *           drop (honeypot / captcha-false) happens first, we get { ok:true }.
 *
 *   FACTORY-1 Factory returns NoopCaptchaVerifier when env unset.
 *   FACTORY-2 Factory returns TurnstileCaptchaVerifier when
 *             CAPTCHA_PROVIDER=turnstile + CAPTCHA_SECRET_KEY are set.
 *   FACTORY-3 Factory returns NoopCaptchaVerifier when CAPTCHA_PROVIDER is set
 *             but CAPTCHA_SECRET_KEY is missing (partial config → Noop).
 *   FACTORY-4 Factory returns NoopCaptchaVerifier for an unknown provider
 *             (conservative default — unknown config treated as unconfigured).
 *
 * NO property test (boolean gate per spec).
 * No real HTTP calls. No money. No FAA determination.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  withPlatformAdminContext,
  seedTwoOrgs,
} from '@aeroops/db';
import { org } from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';

import { submitBookingRequestWithDb } from '../booking/submit-booking-request.js';
import {
  getCaptchaVerifier,
  NoopCaptchaVerifier,
  TurnstileCaptchaVerifier,
} from '../booking/captcha.js';
import type { CaptchaVerifier } from '../booking/captcha.js';
import { bookingRequestSchema } from '@aeroops/core';

// ── Path resolution ───────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const MIGRATION_SQL = [
  readFileSync(resolve(__dirname, '../../../db/migrations/0000_loud_prodigy.sql'),      'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0001_auth_credential.sql'),   'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0002_scheduling.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0003_booking_policies.sql'),  'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0004_recurrence.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0005_dispatch.sql'),          'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0006_squawks_grounding.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0007_fleet.sql'),             'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0008_people.sql'),            'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0009_dispatch_gate.sql'),     'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0010_civil_twilight.sql'),    'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0011_optimizer_run.sql'),     'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0012_training.sql'),          'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0013_work_orders.sql'),       'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0014_availability.sql'),      'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0015_booking_request.sql'),   'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0016_booking_request_convert.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0017_booking_retention.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0018_dispatch_ticket_correction.sql'),        'utf-8'),
  readFileSync(resolve(__dirname, '../../../db/migrations/0019_billing_records.sql'),        'utf-8'),
];

// ── Test environment ──────────────────────────────────────────────────────────

interface TestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  slugA: string;
}

let env: TestEnv;

// A future date well in range: 2027-06-15T14:00:00Z
const FUTURE_START = '2027-06-15T14:00:00.000Z';

function minimalValid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Captcha Test',
    email: 'captcha@example.com',
    requestedStart: FUTURE_START,
    ...overrides,
  };
}

async function countRows(db: PgliteTestClient, orgId: string): Promise<number> {
  return withOrgContext(db, orgId, async (tx) => {
    const result = await (tx as PgliteTestClient).execute(
      sql`SELECT COUNT(*)::int AS cnt FROM booking_request WHERE org_id = ${orgId}::uuid`,
    );
    const rows = result.rows as Array<{ cnt: number }>;
    return rows[0]?.cnt ?? 0;
  });
}

// ── Fake verifiers ─────────────────────────────────────────────────────────────

/** A fake verifier that always returns true (valid CAPTCHA). */
class AlwaysOkVerifier implements CaptchaVerifier {
  async verify(_token: string | undefined, _remoteIp?: string): Promise<boolean> {
    return true;
  }
}

/** A fake verifier that always returns false (invalid CAPTCHA). */
class AlwaysBlockVerifier implements CaptchaVerifier {
  async verify(_token: string | undefined, _remoteIp?: string): Promise<boolean> {
    return false;
  }
}

/** A fake verifier that always throws (simulates a provider outage). */
class AlwaysThrowVerifier implements CaptchaVerifier {
  async verify(_token: string | undefined, _remoteIp?: string): Promise<boolean> {
    throw new Error('Simulated provider outage');
  }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  const seed = await seedTwoOrgs(db);

  env = {
    db,
    pglite,
    orgAId: seed.orgAId,
    slugA: 'alpha',
  };

  // Switch to the restricted aeroops_app role so FORCE RLS is exercised.
  await setTestAppRole({ pglite });
}, 60_000);

// ─────────────────────────────────────────────────────────────────────────────
// NOOP — byte-identical to pre-PB-LR.B when unconfigured
// ─────────────────────────────────────────────────────────────────────────────

describe('NOOP — Unconfigured default is byte-identical to PB1', () => {
  it('NOOP-1: no verifier injected, no env vars → Noop → INSERT happens, { ok:true }', async () => {
    // No verifier argument → _submitImpl calls getCaptchaVerifier() → NoopCaptchaVerifier
    // (in the test process, CAPTCHA_SECRET_KEY and CAPTCHA_PROVIDER are not set).
    const { db, orgAId, slugA } = env;

    const before = await countRows(db, orgAId);
    const result = await submitBookingRequestWithDb(db, slugA, minimalValid({ name: 'Noop-1' }));
    expect(result).toEqual({ ok: true });
    const after = await countRows(db, orgAId);
    expect(after).toBe(before + 1);
  });

  it('NOOP-2: captchaToken absent from body → Noop verifier → INSERT happens', async () => {
    // Existing callers that never send captchaToken remain unaffected.
    const { db, orgAId, slugA } = env;

    const before = await countRows(db, orgAId);
    const result = await submitBookingRequestWithDb(
      db,
      slugA,
      // Body WITHOUT captchaToken — the field is optional.
      { name: 'Noop-2', email: 'noop2@example.com', requestedStart: FUTURE_START },
      new NoopCaptchaVerifier(),
    );
    expect(result).toEqual({ ok: true });
    const after = await countRows(db, orgAId);
    expect(after).toBe(before + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// VALID — token accepted → INSERT
// ─────────────────────────────────────────────────────────────────────────────

describe('VALID — valid token (verifier → true) → INSERT', () => {
  it('VALID-1: AlwaysOkVerifier returns true → row inserted, { ok:true }', async () => {
    const { db, orgAId, slugA } = env;

    const before = await countRows(db, orgAId);
    const result = await submitBookingRequestWithDb(
      db,
      slugA,
      minimalValid({ name: 'Valid-1', captchaToken: 'fake-valid-token' }),
      new AlwaysOkVerifier(),
    );
    expect(result).toEqual({ ok: true });
    const after = await countRows(db, orgAId);
    expect(after).toBe(before + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INVALID — token rejected → silent-drop, { ok:true }, NO insert
// ─────────────────────────────────────────────────────────────────────────────

describe('INVALID — invalid token (verifier → false) → silent-drop, no insert', () => {
  it('INVALID-1: AlwaysBlockVerifier → { ok:true }, 0 new rows (anti-enum silent-drop)', async () => {
    const { db, orgAId, slugA } = env;

    const before = await countRows(db, orgAId);
    const result = await submitBookingRequestWithDb(
      db,
      slugA,
      minimalValid({ name: 'Invalid-1', captchaToken: 'bot-token' }),
      new AlwaysBlockVerifier(),
    );

    // Anti-enumeration: the response is { ok:true } — same as honeypot drop.
    // A bot cannot tell its token was rejected.
    expect(result).toEqual({ ok: true });

    // CRITICAL: no row was inserted.
    const after = await countRows(db, orgAId);
    expect(after).toBe(before);
  });

  it('INVALID-2: AlwaysBlockVerifier with no captchaToken → still silent-drop', async () => {
    // When the verifier decides false, even a missing token is a drop.
    const { db, orgAId, slugA } = env;

    const before = await countRows(db, orgAId);
    const result = await submitBookingRequestWithDb(
      db,
      slugA,
      // No captchaToken in body.
      { name: 'Invalid-2', email: 'invalid2@example.com', requestedStart: FUTURE_START },
      new AlwaysBlockVerifier(),
    );

    expect(result).toEqual({ ok: true });
    const after = await countRows(db, orgAId);
    expect(after).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FAILOPEN — verifier throws → fail-open, INSERT proceeds
// ─────────────────────────────────────────────────────────────────────────────

describe('FAILOPEN — verifier throws → fail-open → INSERT proceeds', () => {
  it('FAILOPEN-1: AlwaysThrowVerifier → fail-OPEN → { ok:true }, row inserted', async () => {
    // Provider outage must NOT kill lead capture.
    const { db, orgAId, slugA } = env;

    const before = await countRows(db, orgAId);
    const result = await submitBookingRequestWithDb(
      db,
      slugA,
      minimalValid({ name: 'Failopen-1', captchaToken: 'some-token' }),
      new AlwaysThrowVerifier(),
    );

    // The request was allowed through (fail-open).
    expect(result).toEqual({ ok: true });
    const after = await countRows(db, orgAId);
    expect(after).toBe(before + 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OPT — captchaToken is optional in the zod schema
// ─────────────────────────────────────────────────────────────────────────────

describe('OPT — captchaToken is optional in bookingRequestSchema', () => {
  it('OPT-1: body without captchaToken validates successfully', () => {
    const result = bookingRequestSchema.safeParse({
      name: 'No Token',
      email: 'notoken@example.com',
      requestedStart: FUTURE_START,
      // captchaToken intentionally absent
    });
    expect(result.success).toBe(true);
  });

  it('OPT-2: body with captchaToken ≤4096 chars validates successfully', () => {
    const result = bookingRequestSchema.safeParse({
      name: 'Has Token',
      email: 'hastoken@example.com',
      requestedStart: FUTURE_START,
      captchaToken: 'a'.repeat(100),
    });
    expect(result.success).toBe(true);
  });

  it('OPT-3: captchaToken > 4096 chars → validation failure', () => {
    const result = bookingRequestSchema.safeParse({
      name: 'Big Token',
      email: 'bigtoken@example.com',
      requestedStart: FUTURE_START,
      captchaToken: 'x'.repeat(4097),
    });
    expect(result.success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ORDER — CAPTCHA / honeypot run BEFORE any DB access on a drop
// ─────────────────────────────────────────────────────────────────────────────

describe('ORDER — honeypot/CAPTCHA drop before DB access (unknown slug)', () => {
  it('ORDER-1: honeypot non-empty → { ok:true } even with an unknown slug (no DB access)', async () => {
    // If the honeypot guard ran AFTER resolveOrgBySlug, we would get { ok:false, reason:'unavailable' }
    // for an unknown slug. Getting { ok:true } proves the honeypot ran first with zero DB access.
    const { db } = env;

    const result = await submitBookingRequestWithDb(db, 'never-exists-slug-99', {
      ...minimalValid(),
      website: 'https://bot.example.com', // non-empty honeypot
    });

    // Fake success — honeypot was checked BEFORE slug resolution.
    expect(result).toEqual({ ok: true });
  });

  it('ORDER-2: CAPTCHA false → { ok:true } even with an unknown slug (no DB access)', async () => {
    // If the CAPTCHA guard ran AFTER resolveOrgBySlug, we would get
    // { ok:false, reason:'unavailable' } for an unknown slug. Getting { ok:true }
    // proves the CAPTCHA check ran first with zero DB access.
    const { db } = env;

    const result = await submitBookingRequestWithDb(
      db,
      'never-exists-slug-captcha-99',
      minimalValid({ captchaToken: 'bad-token' }),
      new AlwaysBlockVerifier(),
    );

    // Silent-drop — CAPTCHA was checked BEFORE slug resolution.
    expect(result).toEqual({ ok: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY — getCaptchaVerifier() reads env at call time
// ─────────────────────────────────────────────────────────────────────────────

describe('FACTORY — getCaptchaVerifier() env resolution', () => {
  // Store original env values and restore after each test.
  const originalProvider  = process.env['CAPTCHA_PROVIDER'];
  const originalSecretKey = process.env['CAPTCHA_SECRET_KEY'];

  afterEach(() => {
    // Restore original values (undefined → delete the key).
    if (originalProvider === undefined) {
      delete process.env['CAPTCHA_PROVIDER'];
    } else {
      process.env['CAPTCHA_PROVIDER'] = originalProvider;
    }
    if (originalSecretKey === undefined) {
      delete process.env['CAPTCHA_SECRET_KEY'];
    } else {
      process.env['CAPTCHA_SECRET_KEY'] = originalSecretKey;
    }
  });

  it('FACTORY-1: both env vars absent → NoopCaptchaVerifier', () => {
    delete process.env['CAPTCHA_PROVIDER'];
    delete process.env['CAPTCHA_SECRET_KEY'];

    const verifier = getCaptchaVerifier();
    expect(verifier).toBeInstanceOf(NoopCaptchaVerifier);
  });

  it('FACTORY-2: CAPTCHA_PROVIDER=turnstile + CAPTCHA_SECRET_KEY set → TurnstileCaptchaVerifier', () => {
    process.env['CAPTCHA_PROVIDER']  = 'turnstile';
    process.env['CAPTCHA_SECRET_KEY'] = 'test-secret-key';

    const verifier = getCaptchaVerifier();
    expect(verifier).toBeInstanceOf(TurnstileCaptchaVerifier);
  });

  it('FACTORY-3: CAPTCHA_PROVIDER set but CAPTCHA_SECRET_KEY absent → NoopCaptchaVerifier', () => {
    process.env['CAPTCHA_PROVIDER'] = 'turnstile';
    delete process.env['CAPTCHA_SECRET_KEY'];

    const verifier = getCaptchaVerifier();
    expect(verifier).toBeInstanceOf(NoopCaptchaVerifier);
  });

  it('FACTORY-4: unknown CAPTCHA_PROVIDER → NoopCaptchaVerifier (conservative default)', () => {
    process.env['CAPTCHA_PROVIDER']   = 'recaptcha-v99-unknown';
    process.env['CAPTCHA_SECRET_KEY'] = 'some-key';

    const verifier = getCaptchaVerifier();
    expect(verifier).toBeInstanceOf(NoopCaptchaVerifier);
  });

  it('FACTORY-5: NoopCaptchaVerifier.verify() always returns true (no HTTP call)', async () => {
    const noop = new NoopCaptchaVerifier();
    // With token.
    expect(await noop.verify('some-token', '1.2.3.4')).toBe(true);
    // Without token.
    expect(await noop.verify(undefined)).toBe(true);
    // With empty string.
    expect(await noop.verify('')).toBe(true);
  });
});
