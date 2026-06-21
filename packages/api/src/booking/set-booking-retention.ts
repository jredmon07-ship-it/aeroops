/**
 * set-booking-retention.ts — Booking-request PII retention config (Slice PB-LR.A).
 *
 * Manages the per-org booking retention policy stored in dispatch_config.
 * Absent row → canonical defaults { retentionDays: 365, includesConverted: false }.
 *
 * FUNCTIONS:
 *   getBookingRetention    — org:manage_settings → BookingRetentionView (defaults when absent)
 *   setBookingRetention    — org:manage_settings → upsert dispatch_config + ONE audit row
 *
 * GUARANTEES:
 *   - requireCapability(session, 'org:manage_settings') FIRST (before any data access).
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop).
 *   - setBookingRetention: zod validates { retentionDays: int 0–3650, includesConverted: bool }.
 *   - retentionDays = 0 means "retention disabled / keep forever" — NOT delete-all.
 *     The purge command enforces this; the setter merely stores it.
 *   - setBookingRetention: ON CONFLICT(org_id) DO UPDATE (upsert dispatch_config).
 *   - setBookingRetention: ONE audit row 'booking_retention.config_changed'
 *     { retentionDays, includesConverted, previousRetentionDays, previousIncludesConverted }.
 *     No requester PII in audit metadata.
 *   - getBookingRetention: read-only; NOT audited.
 *   - NO money, NO FAA determination.
 *
 * [VERIFY-PB1-COMP-1]: PII retention posture — compliance confirms hard-delete vs
 * anonymize, whether 365 days is acceptable, and whether status-change audit rows
 * (status+id, no PII) may be retained post-purge.
 *
 * TWO CALLING FORMS per function:
 *   fn(session, input)        — app code (uses getDb() internally).
 *   fnWithDb(db, session, in) — tests (inject pglite client).
 */

import { z } from 'zod';
import { sql, eq } from 'drizzle-orm';
import { dispatchConfig, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../auth/session.js';
import { getDb } from '../db.js';
import type { AppSession } from '../auth/types.js';
import { ValidationError } from '../scheduling/internal.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * BookingRetentionView — the booking-request retention config for an org.
 *
 * Absent dispatch_config row → defaults { retentionDays: 365, includesConverted: false }.
 *
 * retentionDays = 0 means "retention disabled / keep forever" — NOT delete-all.
 * The purge command treats days=0 as a no-op. Range: 0–3650.
 */
export interface BookingRetentionView {
  retentionDays: number;
  includesConverted: boolean;
}

export type GetBookingRetentionResult = BookingRetentionView;

export type SetBookingRetentionResult = {
  ok: true;
  retentionDays: number;
  includesConverted: boolean;
};

// ─── Input schema ─────────────────────────────────────────────────────────────

const setBookingRetentionInputSchema = z.object({
  retentionDays:     z.number().int().min(0).max(3650),
  includesConverted: z.boolean(),
});

export interface SetBookingRetentionInput {
  retentionDays:     number;
  includesConverted: boolean;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * loadBookingRetention — reads the booking retention config from dispatch_config.
 * Returns defaults { 365, false } when no row exists.
 * Called within an already-set org context (RLS scoped by tx).
 */
async function loadBookingRetention(
  tx: AnyDb,
  orgId: string,
): Promise<BookingRetentionView> {
  const rows = await tx
    .select({
      bookingRequestRetentionDays:              dispatchConfig.bookingRequestRetentionDays,
      bookingRequestRetentionIncludesConverted: dispatchConfig.bookingRequestRetentionIncludesConverted,
    })
    .from(dispatchConfig)
    .where(eq(dispatchConfig.orgId, orgId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return { retentionDays: 365, includesConverted: false };
  }

  return {
    retentionDays:     row.bookingRequestRetentionDays,
    includesConverted: row.bookingRequestRetentionIncludesConverted,
  };
}

// ─── getBookingRetention ──────────────────────────────────────────────────────

async function _getBookingRetentionImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<GetBookingRetentionResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'org:manage_settings');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    return loadBookingRetention(tx, sess.orgId);
  });
}

/**
 * getBookingRetention — read the org's booking-request retention config.
 *
 * @param session - AppSession; null/undefined → UnauthenticatedError.
 * @returns       - { retentionDays, includesConverted }. Defaults when absent.
 * @throws        - UnauthenticatedError | ForbiddenError.
 */
export async function getBookingRetention(
  session: AppSession | null | undefined,
): Promise<GetBookingRetentionResult> {
  const db = await getDb();
  return _getBookingRetentionImpl(db, session);
}

/** getBookingRetentionWithDb — test form; inject a pglite client. */
export async function getBookingRetentionWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<GetBookingRetentionResult> {
  return _getBookingRetentionImpl(db, session);
}

// ─── setBookingRetention ──────────────────────────────────────────────────────

async function _setBookingRetentionImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SetBookingRetentionResult> {
  // 1. AUTHZ FIRST.
  requireCapability(session, 'org:manage_settings');

  // 2. VALIDATE input.
  const parsed = setBookingRetentionInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(
      `[booking-retention] invalid setBookingRetention input: ${first?.message ?? 'unknown'}`,
    );
  }
  const { retentionDays, includesConverted } = parsed.data;

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    // 3. Load before-state for audit.
    const before: BookingRetentionView = await loadBookingRetention(tx, sess.orgId);

    // 4. Upsert dispatch_config — preserves ALL other columns via EXCLUDED merge.
    //    We set only the two retention columns + updated_at; all others use
    //    the EXCLUDED alias to leave them unchanged on conflict.
    await tx.execute(sql`
      INSERT INTO dispatch_config (
        org_id,
        eligibility_mode,
        balance_check_enabled,
        twilight_constraint_enabled,
        twilight_mode,
        twilight_exempt_tag,
        availability_constraint_enabled,
        availability_mode,
        booking_request_retention_days,
        booking_request_retention_includes_converted,
        created_at,
        updated_at
      )
      VALUES (
        ${sess.orgId}::uuid,
        'block',
        false,
        false,
        'warn',
        NULL,
        false,
        'warn',
        ${retentionDays},
        ${includesConverted},
        NOW(),
        NOW()
      )
      ON CONFLICT (org_id) DO UPDATE SET
        booking_request_retention_days               = EXCLUDED.booking_request_retention_days,
        booking_request_retention_includes_converted = EXCLUDED.booking_request_retention_includes_converted,
        updated_at                                   = NOW()
    `);

    // 5. ONE audit row — before/after snapshot. NO requester PII.
    await tx.insert(auditLog).values({
      orgId:       sess.orgId,
      actorUserId: sess.userId,
      action:      'booking_retention.config_changed',
      entityType:  'dispatch_config',
      entityId:    sess.orgId,
      metadata: {
        retentionDays,
        includesConverted,
        previousRetentionDays:     before.retentionDays,
        previousIncludesConverted: before.includesConverted,
      },
    });

    return { ok: true, retentionDays, includesConverted } as const;
  });
}

/**
 * setBookingRetention — upsert booking-request retention config for the session org.
 *
 * @param session  - AppSession; null/undefined → UnauthenticatedError.
 * @param rawInput - { retentionDays: int 0–3650, includesConverted: bool }.
 * @returns        - { ok: true, retentionDays, includesConverted }.
 * @throws         - UnauthenticatedError | ForbiddenError | ValidationError.
 */
export async function setBookingRetention(
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SetBookingRetentionResult> {
  const db = await getDb();
  return _setBookingRetentionImpl(db, session, rawInput);
}

/** setBookingRetentionWithDb — test form; inject a pglite client. */
export async function setBookingRetentionWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
): Promise<SetBookingRetentionResult> {
  return _setBookingRetentionImpl(db, session, rawInput);
}
