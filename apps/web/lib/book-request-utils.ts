/**
 * lib/book-request-utils.ts — Pure helpers for the public booking-request form.
 *
 * No DOM, no Next.js, no I/O — unit-testable in isolation.
 *
 * buildIsoDateTime: combines a local date string ("YYYY-MM-DD") and local time
 * string ("HH:MM") into an ISO-8601 datetime string with a UTC offset derived
 * from the browser's local timezone (via Date parsing).
 *
 * Used by the client form (apps/web/app/book/[slug]/_components/book-request-form.tsx)
 * before submitting to the API so that requestedStart / requestedEnd are valid
 * ISO-8601 datetime strings as required by bookingRequestSchema.
 *
 * DESIGN:
 *   - We parse with Date to pick up the local TZ offset at the exact instant.
 *   - toISOString() returns UTC ("Z") — this is correct for server storage.
 *   - If date is empty/invalid → returns null (form validation catches the empty case).
 *   - If time is empty → defaults to "00:00" (start of day, valid sentinel).
 */

/**
 * Combine a local date string ("YYYY-MM-DD") and an optional local time string
 * ("HH:MM") into a UTC ISO-8601 string suitable for `bookingRequestSchema.requestedStart`
 * or `.requestedEnd`.
 *
 * Returns null when `date` is empty or produces an invalid Date.
 */
export function buildIsoDateTime(date: string, time: string): string | null {
  if (!date.trim()) return null;

  const normalizedTime = time.trim() || '00:00';
  // Parsing "YYYY-MM-DDTHH:MM" without a TZ designator gives the local-time Date.
  const parsed = new Date(`${date}T${normalizedTime}`);

  // Invalid date (e.g. "2024-13-01")
  if (isNaN(parsed.getTime())) return null;

  return parsed.toISOString();
}
