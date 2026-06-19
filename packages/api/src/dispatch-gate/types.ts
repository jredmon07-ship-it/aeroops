/**
 * dispatch-gate/types.ts — public result/IO types for the dispatch gate API
 * (Slice 3c / ADR-0009). Framework-agnostic; no I/O.
 *
 * DESIGN POSTURE:
 *   - Operational refusals (not_found, duplicate) are RETURNED as discriminated-
 *     union values, NOT thrown. The UI renders them as messages.
 *   - Auth failures are THROWN as ForbiddenError / UnauthenticatedError.
 *   - Validation failures (empty tag, invalid mode) are THROWN as ValidationError.
 *
 * [VERIFY-3c-A] (HARD COMPLIANCE LINE): RequiredTagView.requiredTag is a FREE-TEXT
 * operator label ONLY. No FAA currency, medical, flight-review, Part 61/141,
 * endorsement, or eligibility status is computed or inferred from any tag value.
 *
 * [VERIFY-3c-MONEY] (HARD MONEY BOUNDARY): DispatchConfigView.balanceCheckEnabled
 * is a FEATURE FLAG ONLY. There is NO dollar value, minimum balance, account
 * balance, Stripe reference, or financial data in these types.
 */

// ─── RequiredTagView ──────────────────────────────────────────────────────────

/**
 * RequiredTagView — one dispatch_requirement row as seen by API callers.
 *
 * [VERIFY-3c-A]: requiredTag is a FREE-TEXT operator label only.
 * No FAA/currency/medical/endorsement meaning is attached.
 */
export interface RequiredTagView {
  id: string;
  /** The free-text operator label. [VERIFY-3c-A] */
  requiredTag: string;
  createdBy: string;
  createdAt: Date;
}

// ─── DispatchConfigView ───────────────────────────────────────────────────────

/**
 * DispatchConfigView — the dispatch gate config for an org.
 *
 * Absent row in dispatch_config → defaults apply (per spec):
 *   { eligibilityMode: 'block', balanceCheckEnabled: false }
 *
 * [VERIFY-3c-MONEY]: balanceCheckEnabled is a FEATURE FLAG, NOT a billing toggle.
 * No dollar value, minimum, Stripe, or payment data in this type.
 */
export interface DispatchConfigView {
  /** 'block' → missing tag blocks dispatch; 'warn' → advisory only. */
  eligibilityMode: 'block' | 'warn';
  /**
   * Feature flag for the balance seam. Default false. In Phase 1 the stub
   * always returns { ok: true } regardless of this flag.
   * [VERIFY-3c-MONEY]: NOT a real balance check. No money concept.
   */
  balanceCheckEnabled: boolean;
}

// ─── getResourceRequiredTags result ───────────────────────────────────────────

export type GetResourceRequiredTagsResult =
  | { ok: true; tags: RequiredTagView[] }
  | { ok: false; reason: 'not_found' };

// ─── addResourceRequiredTag result ────────────────────────────────────────────

export type AddResourceRequiredTagResult =
  | { ok: true; tags: RequiredTagView[] }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'duplicate' };

// ─── removeResourceRequiredTag result ─────────────────────────────────────────

export type RemoveResourceRequiredTagResult =
  | { ok: true; tags: RequiredTagView[] }
  | { ok: false; reason: 'not_found' };

// ─── getDispatchConfig result ──────────────────────────────────────────────────

// getDispatchConfig always returns DispatchConfigView (applying defaults when
// no row exists); it never returns not_found.
export type GetDispatchConfigResult = DispatchConfigView;

// ─── updateDispatchConfig result ──────────────────────────────────────────────

export type UpdateDispatchConfigResult =
  | { ok: true; config: DispatchConfigView }
  | { ok: false; reason: 'not_found' }; // reserved; upsert should never not_found
