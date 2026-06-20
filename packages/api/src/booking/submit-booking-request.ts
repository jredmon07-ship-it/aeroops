/**
 * booking/submit-booking-request.ts — Public booking-request submit orchestrator.
 * (Slice PB1.1 / ADR-0013)
 *
 * ── ADR-0013 INVARIANTS (reviewer must reject any violation) ─────────────────
 *   1. The tx body is INSERT-ONLY into booking_request — no SELECT/JOIN/UPDATE/
 *      second-write of any tenant table inside the withOrgContext callback.
 *   2. org_id is derived SOLELY from resolveOrgBySlug (server-side resolve).
 *      It is NEVER read from the client input (the wire body has no org_id).
 *   3. withOrgContext (normal RLS) is used — NOT withPlatformAdminContext.
 *      The RLS booking_request_insert WITH CHECK(org_id=GUC) is the backstop.
 *   4. Unknown slug and suspended org return BYTE-IDENTICAL responses (anti-
 *      enumeration: callers cannot distinguish the two cases).
 *   5. Honeypot non-empty → return fake { ok:true } with ZERO DB access.
 *   6. Per-org rate guard: ≥ RATE_LIMIT_PER_ORG_PER_MIN submissions in the
 *      last 1 minute → return fake { ok:true }, NO insert (silent drop).
 *   7. The public route (apps/web) NEVER imports @aeroops/db or has SQL.
 *      It calls submitBookingRequest(db, slug, body) and returns the result.
 *   8. No tenant data is echoed back — result is always { ok:true } or
 *      { ok:false, reason:'invalid'|'unavailable' }.
 *
 * TWO CALLING FORMS:
 *   submitBookingRequest(slug, input)         — app code; uses getDb() internally.
 *   submitBookingRequestWithDb(db, slug, input) — tests; inject pglite client.
 *
 * Note: the *WithDb form takes (db, slug, input) — db first, then slug, then input.
 */

import { sql } from 'drizzle-orm';
import { bookingRequest } from '@aeroops/db';
import { withOrgContext } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { bookingRequestSchema } from '@aeroops/core';
import { resolveOrgBySlug } from '../auth/resolve-org.js';
import { getDb } from '../db.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Per-org rate limit: if ≥ this many rows were inserted in the last 1 minute,
 * silently drop the request (fake success, no insert, no bot signal).
 */
const RATE_LIMIT_PER_ORG_PER_MIN = 10;

// ─── Result type ──────────────────────────────────────────────────────────────

/**
 * SubmitBookingRequestResult — the public result of the submit orchestrator.
 *
 * ok:true  → accepted (or silently dropped by honeypot/rate-guard).
 * ok:false → input invalid (no enumeration of which field) OR org unavailable
 *            (unknown slug and suspended org are indistinguishable — anti-enumeration).
 *
 * SECURITY: NO id, NO org data, NO tenant data is ever echoed in the result.
 */
export type SubmitBookingRequestResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'unavailable' };

// ─── Shared implementation ────────────────────────────────────────────────────

/**
 * _submitImpl — the shared implementation.
 *
 * Execution order (ADR-0013):
 *   (a) Honeypot: if website is non-empty → return { ok:true } with NO DB access.
 *   (b) Validate with bookingRequestSchema → generic invalid on failure (no enumeration).
 *   (c) resolveOrgBySlug + active gate → unknown/suspended → generic unavailable.
 *   (d) withOrgContext tx body:
 *       - per-org rate count guard (SELECT COUNT from booking_request).
 *       - if under limit: ONE INSERT INTO booking_request RETURNING id.
 *       - if over limit: return fake { ok:true }, no insert.
 *   (e) return { ok:true } — NO id, NO tenant data.
 */
async function _submitImpl(
  db: AnyDb,
  slug: string,
  rawInput: unknown,
): Promise<SubmitBookingRequestResult> {
  // ── (a) Honeypot guard ──────────────────────────────────────────────────────
  // Bots fill hidden fields; humans leave `website` empty.
  // Non-empty → fake success with ZERO DB access (no timing signal either).
  const rawObj = rawInput as Record<string, unknown> | null | undefined;
  if (rawObj && typeof rawObj === 'object' && rawObj['website']) {
    return { ok: true };
  }

  // ── (b) Validate input ──────────────────────────────────────────────────────
  // Generic 'invalid' on ANY failure — no field enumeration to the client.
  const parsed = bookingRequestSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid' };
  }

  const input = parsed.data;

  // ── (b2) Sanity-bound requestedStart (ADR-0013: [now-1h, now+365d]) ─────────
  // The zod schema is deterministic (cannot reference "now"), so the temporal
  // bound is enforced here. Out-of-window → the SAME generic 'invalid' (no
  // enumeration). Rejects junk/spam far-past/far-future requests.
  const startMs = new Date(input.requestedStart).getTime();
  const nowMs = Date.now();
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const ONE_YEAR_MS = 365 * 24 * ONE_HOUR_MS;
  if (Number.isNaN(startMs) || startMs < nowMs - ONE_HOUR_MS || startMs > nowMs + ONE_YEAR_MS) {
    return { ok: false, reason: 'invalid' };
  }

  // ── (c) Resolve org + active gate ──────────────────────────────────────────
  // resolveOrgBySlug is the ONLY sanctioned anon read (uses withPlatformAdminContext;
  // returns {id,name,slug,status} only). Unknown slug → null. Suspended → status!=='active'.
  // Both cases return the SAME generic response (anti-enumeration: no way to distinguish).
  const resolvedOrg = await resolveOrgBySlug(db, slug);
  if (!resolvedOrg || resolvedOrg.status !== 'active') {
    return { ok: false, reason: 'unavailable' };
  }

  // ── (d) withOrgContext tx — INSERT only ────────────────────────────────────
  // INVARIANT (ADR-0013): this callback is INSERT-ONLY into booking_request.
  //   - ONE SELECT COUNT for the rate guard (reading booking_request, not cross-table).
  //   - ONE INSERT INTO booking_request on success.
  //   - NO UPDATE / second-write / JOIN of any other tenant table.
  //   - org_id is resolvedOrg.id (NEVER from client input).
  //   - withOrgContext (normal RLS) NOT withPlatformAdminContext.
  //   - The RLS WITH CHECK(org_id=GUC) backstop applies to the INSERT.
  const orgId = resolvedOrg.id;

  await withOrgContext(db, orgId, async (tx) => {
    // ── Per-org rate guard ────────────────────────────────────────────────────
    // Count submissions for this org in the last 1 minute.
    // The index booking_request_org_status_created_idx covers this scan.
    const countResult = await (tx as AnyDb).execute(
      sql`SELECT COUNT(*)::int AS cnt FROM booking_request
          WHERE org_id = ${orgId}::uuid
          AND created_at > now() - interval '1 minute'`,
    );

    const rows = countResult.rows as Array<{ cnt: number }>;
    const recentCount = rows[0]?.cnt ?? 0;

    if (recentCount >= RATE_LIMIT_PER_ORG_PER_MIN) {
      // Silent drop — no bot signal (same fake-ok as honeypot).
      // Returning early from the tx callback will commit with no rows written.
      return;
    }
    // NOTE: this count-then-insert guard is BEST-EFFORT under concurrency (no
    // lock), so a burst can slightly overshoot the cap. That is acceptable for a
    // soft anti-abuse measure — the REAL defense before public exposure is the
    // edge rate-limiter/WAF + CAPTCHA launch predecessor ([VERIFY-PB1-SEC-1]).

    // ── INSERT booking_request ─────────────────────────────────────────────
    // org_id is set from resolvedOrg.id (NEVER from client input).
    // status defaults to 'new' (DB default; we set it explicitly for clarity).
    // Requester fields are normalized: email is already lowercased by the schema.
    await tx.insert(bookingRequest).values({
      orgId,
      status: 'new',
      requesterName: input.name,
      requesterEmail: input.email,
      requesterPhone: input.phone ?? null,
      requestedStart: new Date(input.requestedStart),
      requestedEnd: input.requestedEnd ? new Date(input.requestedEnd) : null,
      aircraftTypePref: input.aircraftTypePref ?? null,
      message: input.message ?? null,
      // handledBy / handledAt / triageNotes are NULL on insert (status='new')
    });
  });

  // ── (e) Return success ──────────────────────────────────────────────────────
  // SECURITY: no id, no org data, no tenant data echoed.
  return { ok: true };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * submitBookingRequest — app-code form (the caller passes the db client).
 *
 * Called by the public route handler (apps/web/app/api/public/booking/[slug]/route.ts),
 * which obtains the client via getDb() and passes it in.
 * The slug comes from the URL path parameter — NEVER from the request body.
 *
 * @param db    - The Drizzle database client.
 * @param slug  - The org's URL slug (from the URL path, NOT from the body).
 * @param input - The raw (unvalidated) request body from the client.
 */
export async function submitBookingRequest(
  db: Awaited<ReturnType<typeof getDb>>,
  slug: string,
  input: unknown,
): Promise<SubmitBookingRequestResult> {
  return _submitImpl(db, slug, input);
}

/**
 * submitBookingRequestWithDb — test form (inject PGlite client).
 *
 * Mirrors submitBookingRequest exactly but accepts any AnyDb so test code
 * can inject the pglite client without calling getDb().
 *
 * @param db    - Any Drizzle-compatible DB client (prod or PGlite).
 * @param slug  - The org URL slug.
 * @param input - The raw (unvalidated) input object.
 */
export async function submitBookingRequestWithDb(
  db: AnyDb,
  slug: string,
  input: unknown,
): Promise<SubmitBookingRequestResult> {
  return _submitImpl(db, slug, input);
}
