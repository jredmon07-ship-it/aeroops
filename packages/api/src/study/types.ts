/**
 * types.ts — wire/domain types for the AeroStudy integration (Slice STUDY-1).
 *
 * See docs: the AeroStudy integration design doc §4.
 * org_id NEVER appears on any of these shapes (mobile-wire convention,
 * mirrors MobileReservationDTO / MobileAircraftListDTO).
 */

// ─── Entitlements (GET /api/mobile/v1/study/entitlements) ─────────────────────

/**
 * StudyEntitlementState — the pure fold of a member's unrevoked grant
 * scopes; maps 1:1 onto AeroStudy's client-side EntitlementState
 * (hasAllAccess + unlockedProductIDs; the code→productID map lives in the
 * iOS app).
 */
export interface StudyEntitlementState {
  hasAllAccess: boolean;
  /** Deduplicated, sorted cert codes (e.g. ['IRA', 'PAR']). */
  unlockedCertCodes: string[];
}

/**
 * StudyEntitlementsResult — the full response body: the entitlement state
 * plus a signed-in-band cache TTL (now + 7 days). After expiresAt the
 * on-device cache stops unlocking, so revocation propagates without the
 * app needing to be online at revocation time.
 */
export interface StudyEntitlementsResult extends StudyEntitlementState {
  /** ISO-8601 instant: fetch time + 7 days (client cache TTL). */
  expiresAt: string;
}

// ─── Progress (POST /api/mobile/v1/study/progress) ────────────────────────────

/**
 * StudyProgressInput — a VALIDATED progress upsert payload (the output of
 * parseStudyProgressInput; routes never pass raw JSON to the data layer).
 */
export interface StudyProgressInput {
  /** Cert code, e.g. 'PAR' — never 'all_access'. */
  certCode: string;
  /** Fraction in [0, 1]. */
  readinessPercent: number;
  /** Non-negative integer. */
  questionsLogged: number;
  /** Normalized from the ISO string by parseStudyProgressInput. */
  lastStudiedAt: Date;
}

/** StudyProgressView — the persisted row, as returned after the upsert. */
export interface StudyProgressView {
  certCode: string;
  readinessPercent: number;
  questionsLogged: number;
  /** ISO-8601. */
  lastStudiedAt: string;
  /** ISO-8601. */
  updatedAt: string;
}
