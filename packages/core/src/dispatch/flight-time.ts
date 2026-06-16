/**
 * dispatch/flight-time.ts — pure billable-flight-time derivation.
 *
 * The `@aeroops/core` half of ADR-0007 §4. No I/O, no Drizzle, no React, no
 * clock (`Date.now()`), no randomness. This computes the billable flight-time
 * HOURS for a dispatch ticket from its meter pair. It produces OPS/RECORDS data
 * — a duration in hours — and is NEVER a price. Pricing/billing live in Phase 2
 * and consume this number; they do not live here.
 *
 * BASIS-AGNOSTIC: the caller passes whichever meter pair is the billing basis
 * (Hobbs by default per ADR-0007 §4; tach is stored for maintenance, Phase 4).
 * This function does not know or care which basis it was handed.
 *
 * AUTHORITY: at the API boundary `closeDispatch` validates `meterIn >= meterOut`
 * and rejects with a ValidationError BEFORE calling this function. This pure
 * function nonetheless keeps its own precondition guard so it is safe to call in
 * isolation (and the property suite pins that guard): `meterIn < meterOut`
 * throws `RangeError`. Meter rollover/replacement is OUT of Slice 3a — a
 * smaller `in` than `out` is rejected, not wrapped ([VERIFY-A]).
 */

/**
 * deriveFlightTime — billable flight-time hours from a meter pair.
 *
 * Returns `meterIn - meterOut` as decimal HOURS, rounded to one decimal place.
 *
 * DOMAIN: `meterIn >= meterOut >= 0`. Meters are decimal hours (e.g. 1234.5).
 *   - Equality (`meterIn === meterOut`) ⇒ `0` — a ground check-out (an aircraft
 *     released and returned with no engine time). This is ALLOWED, not an error.
 *   - `meterIn < meterOut` ⇒ throws `RangeError` (rollover is out of 3a).
 *
 * ROUNDING RULE — round-half-up, applied ONCE to the final difference:
 *   result = Math.round((meterIn - meterOut) * 10) / 10
 *   `Math.round` rounds a value of exactly x.5 UP toward +∞; because the domain
 *   guarantees a non-negative difference, "toward +∞" is "away from zero", i.e.
 *   conventional round-half-up. The multiply-by-10 / `Math.round` / divide-by-10
 *   keeps the result on the 0.1 grid (a multiple of 0.1) within 0.05 of the
 *   exact difference. Rounding is applied to the DIFFERENCE only — never to the
 *   individual meter inputs — so the rule composes predictably for callers.
 *
 *   Float note: meter readings are persisted as `numeric(10,1)` and the API
 *   validates inputs to ≤1 decimal, so for in-domain inputs the difference is an
 *   exact tenth and the rounding is a no-op stabiliser. For arbitrary off-grid
 *   inputs (only reachable via a direct in-isolation call) it rounds half-up to
 *   the nearest tenth. We round the scaled value with `Math.round` rather than
 *   trusting `toFixed`/string formatting, keeping the function total and pure.
 *
 * @param meterOut - meter reading at check-out (decimal hours), `>= 0`.
 * @param meterIn  - meter reading at check-in (decimal hours), `>= meterOut`.
 * @returns billable flight-time hours, a non-negative multiple of 0.1.
 * @throws RangeError if `meterIn < meterOut` (out-of-domain; rollover not in 3a).
 */
export function deriveFlightTime(meterOut: number, meterIn: number): number {
  if (meterIn < meterOut) {
    throw new RangeError(
      `deriveFlightTime: meterIn (${meterIn}) must be >= meterOut (${meterOut})`,
    );
  }
  // Round-half-up applied ONCE to the difference, snapped to the 0.1 grid.
  // +0 normalises a potential -0 (e.g. Math.round(-0) === -0) to 0.
  return Math.round((meterIn - meterOut) * 10) / 10 + 0;
}
