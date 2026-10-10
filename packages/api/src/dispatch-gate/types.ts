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
 *   { eligibilityMode: 'block' }
 */
export interface DispatchConfigView {
  /** 'block' → missing tag blocks dispatch; 'warn' → advisory only. */
  eligibilityMode: 'block' | 'warn';
  /**
   * Civil-twilight scheduling constraint (Slice 4a). Default false. When enabled,
   * bookings crossing civil dawn/dusk warn or block per `twilightMode`.
   * [VERIFY-4a-A]: an operator scheduling rule from ASTRONOMICAL civil-twilight times —
   * NOT an FAA night-currency / §61.57 / §1.1 determination.
   */
  twilightConstraintEnabled: boolean;
  /** 'block' → night-crossing booking refused; 'warn' → advisory only. Default 'warn'. */
  twilightMode: 'block' | 'warn';
  /**
   * Free-text operator label exempting a pilot from the twilight constraint
   * ([VERIFY-4a-D]: opaque operator tag, NO computed currency). Exemption wiring is
   * DEFERRED in 4a (recorded, not yet applied). null = no exempt tag configured.
   */
  twilightExemptTag: string | null;
  /**
   * Resource operating-hours availability constraint (Slice AV1.2). Default false.
   * When enabled, bookings outside a resource's defined operating-hours windows
   * warn or block per `availabilityMode`. INERT when false OR the resource has no
   * windows.
   * [VERIFY-AV1-A]: an OPERATOR scheduling / operating-hours rule — NOT an FAA
   * duty-time, rest-period, Part-117/135/121, or flight-time-limit determination.
   */
  availabilityConstraintEnabled: boolean;
  /** 'block' → out-of-hours booking refused; 'warn' → advisory only. Default 'warn'. */
  availabilityMode: 'block' | 'warn';
  /**
   * Number of days after creation to retain booking_request rows for the purge.
   * 0 = retention disabled (keep forever — NOT delete-all). Range: 0–3650.
   * Default 365 (absent row or newly-created org without explicit config).
   * [VERIFY-PB1-COMP-1]: PII retention posture — compliance confirms hard-delete
   * vs anonymize and whether 365 days is acceptable.
   */
  bookingRequestRetentionDays: number;
  /**
   * When false (default): the purge excludes 'converted' booking_request rows
   * (they represent confirmed leads / reservations). When true: the retention
   * window also applies to 'converted' rows. The linked reservation is NOT deleted.
   */
  bookingRequestRetentionIncludesConverted: boolean;
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
