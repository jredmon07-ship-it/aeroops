/**
 * billing/ar-aging.ts — pure Accounts-Receivable aging bucketer (the
 * @aeroops/core half of the Financial/AR reporting slice).
 *
 * No I/O, no Drizzle, no React, no clock (the "current time" is ALWAYS an
 * injected `asOf`, never `new Date()` read internally), no randomness, NO
 * Stripe. Pure arithmetic over caller-supplied {balanceCents, asOf,
 * referenceDate} items.
 *
 * MONEY = INTEGER CENTS throughout. NEVER a float in the money path.
 *
 * ── METRIC DEFINITION (pin here — two people must compute the same number) ──
 *
 * ageDays(asOf, referenceDate) = floor((asOf − referenceDate) / 86_400_000 ms),
 *   clamped to >= 0 (a referenceDate in the future relative to asOf — e.g. a
 *   clock skew or a not-yet-issued invoice — is never a negative age; it is
 *   "current").
 *
 * Bucket assignment (closed-interval boundaries on ageDays):
 *   'current'  — ageDays <= 0            (aged zero full days: same-day)
 *   'd30'      — 1  <= ageDays <= 30      ("1-30 days")
 *   'd60'      — 31 <= ageDays <= 60      ("31-60 days")
 *   'd90'      — 61 <= ageDays <= 90      ("61-90 days")
 *   'd90plus'  — ageDays > 90             ("90+ days")
 *
 * A single AgingItem's ENTIRE balanceCents is assigned to exactly ONE bucket
 * (the bucket its `referenceDate` ages into) — this module does not split one
 * balance across multiple buckets. Callers that want a true per-invoice split
 * pass one AgingItem per invoice and let `aggregateAging` sum the buckets
 * across items.
 *
 * SANITIZATION (never throws — a hard requirement for a reporting surface):
 *   - `balanceCents` that is not a positive finite integer is treated as 0
 *     (this is also how "a member with a credit/zero balance is excluded" is
 *     expressed at the call site — see getAccountsReceivable, which only
 *     passes AgingItems for members with balanceCents > 0 in the first place;
 *     this module's own zero-clamp is a defense-in-depth backstop, not the
 *     primary exclusion mechanism).
 *   - Invalid Dates (NaN getTime()) are treated as ageDays = 0 ('current').
 *
 * [VERIFY-AR-AGING-1]: this system has no per-invoice payment ALLOCATION (a
 * payment is a credit against the whole account, not tied to a specific
 * invoice) — so "age of the oldest UNPAID invoice" is necessarily an
 * approximation at the call site (getAccountsReceivable documents exactly
 * which reference date it passes in). This module itself is agnostic to that
 * choice; it only buckets whatever (balanceCents, referenceDate) pair it is given.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type AgingBucketKey = 'current' | 'd30' | 'd60' | 'd90' | 'd90plus';

/** Ordered rank of each bucket, oldest-last — used to prove monotonic aging. */
const BUCKET_RANK: Record<AgingBucketKey, number> = {
  current: 0,
  d30: 1,
  d60: 2,
  d90: 3,
  d90plus: 4,
};

export interface AgingBuckets {
  readonly current: number;
  readonly d30: number;
  readonly d60: number;
  readonly d90: number;
  readonly d90plus: number;
}

/**
 * One outstanding-balance observation to age.
 *
 * @param balanceCents   The outstanding amount, in integer cents. Should be a
 *                       positive integer for a meaningful result — non-positive
 *                       or malformed values are sanitized to 0 (see module doc).
 * @param asOf           The "as of" instant the aging is computed relative to
 *                       (normally "now", injected by the caller for determinism).
 * @param referenceDate  The date the outstanding amount is aged FROM (e.g. the
 *                       date of the oldest unpaid invoice_finalized ledger entry).
 */
export interface AgingItem {
  readonly balanceCents: number;
  readonly asOf: Date;
  readonly referenceDate: Date;
}

/** The result of bucketing a single AgingItem. */
export interface AgingItemResult extends AgingBuckets {
  /** The single bucket this item's whole (sanitized) balance was assigned to. */
  readonly bucket: AgingBucketKey;
  /** The non-negative integer number of full days aged (see module doc). */
  readonly ageDays: number;
  /** The sanitized balance actually bucketed (0 if the input was invalid/non-positive). */
  readonly balanceCents: number;
}

export interface AggregateAgingResult {
  readonly buckets: AgingBuckets;
  /** Σ of every item's sanitized balanceCents — equals Σ of the 5 bucket totals. */
  readonly totalCents: number;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isValidDate(d: Date): boolean {
  return d instanceof Date && Number.isFinite(d.getTime());
}

function sanitizeBalanceCents(v: number): number {
  return Number.isFinite(v) && Number.isInteger(v) && v > 0 ? v : 0;
}

export function emptyAgingBuckets(): AgingBuckets {
  return { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * ageDaysBetween — the non-negative integer number of full days between
 * `referenceDate` and `asOf`.
 *
 * NEVER throws, NEVER negative, NEVER NaN:
 *   - Invalid Dates (either argument) → 0.
 *   - `referenceDate` after `asOf` (future-dated reference — clock skew, or a
 *     not-yet-issued item) → 0 (clamped, never negative).
 *
 * @returns floor((asOf − referenceDate) / 1 day), clamped to >= 0.
 */
export function ageDaysBetween(asOf: Date, referenceDate: Date): number {
  if (!isValidDate(asOf) || !isValidDate(referenceDate)) return 0;
  const diffMs = asOf.getTime() - referenceDate.getTime();
  if (diffMs <= 0) return 0;
  return Math.floor(diffMs / MS_PER_DAY);
}

/**
 * classifyAgingBucket — maps a non-negative age-in-days to one of the 5
 * AR-aging buckets. See module-level METRIC DEFINITION for the exact boundaries.
 *
 * NEVER throws: a negative/NaN/non-finite input is treated as 0 ('current').
 */
export function classifyAgingBucket(ageDays: number): AgingBucketKey {
  const days = Number.isFinite(ageDays) && ageDays > 0 ? Math.floor(ageDays) : 0;
  if (days <= 0) return 'current';
  if (days <= 30) return 'd30';
  if (days <= 60) return 'd60';
  if (days <= 90) return 'd90';
  return 'd90plus';
}

/**
 * bucketAgingItem — buckets ONE outstanding-balance item.
 *
 * The item's entire sanitized balanceCents is assigned to exactly one bucket
 * (the one its ageDays falls into); the other four buckets are 0.
 *
 * NEVER throws — malformed balanceCents sanitizes to 0; malformed Dates
 * sanitize to ageDays=0 ('current').
 */
export function bucketAgingItem(item: AgingItem): AgingItemResult {
  const balanceCents = sanitizeBalanceCents(item.balanceCents);
  const ageDays = ageDaysBetween(item.asOf, item.referenceDate);
  const bucket = classifyAgingBucket(ageDays);
  const buckets = emptyAgingBuckets();
  return {
    ...buckets,
    [bucket]: balanceCents,
    bucket,
    ageDays,
    balanceCents,
  } as AgingItemResult;
}

/**
 * sumAgingBuckets — sums a list of AgingBuckets into one totals object.
 * Integer summation only (every input field is already an integer) — no
 * rounding needed. Empty input → emptyAgingBuckets().
 */
export function sumAgingBuckets(buckets: readonly AgingBuckets[]): AgingBuckets {
  const totals = { current: 0, d30: 0, d60: 0, d90: 0, d90plus: 0 };
  for (const b of buckets) {
    totals.current += b.current;
    totals.d30 += b.d30;
    totals.d60 += b.d60;
    totals.d90 += b.d90;
    totals.d90plus += b.d90plus;
  }
  return totals;
}

/**
 * aggregateAging — buckets EACH item independently (bucketAgingItem) then sums
 * across all items into org-level bucket totals + a grand total.
 *
 * INVARIANT (property-tested): buckets.current + buckets.d30 + buckets.d60 +
 * buckets.d90 + buckets.d90plus === totalCents, for ANY input (including the
 * empty array, which returns all-zero).
 *
 * NEVER throws.
 */
export function aggregateAging(items: readonly AgingItem[]): AggregateAgingResult {
  const perItem = items.map(bucketAgingItem);
  const buckets = sumAgingBuckets(perItem);
  const totalCents = perItem.reduce((acc, r) => acc + r.balanceCents, 0);
  return { buckets, totalCents };
}
