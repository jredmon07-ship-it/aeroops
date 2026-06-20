/**
 * booking/booking-request-schema.ts — Zod validation schema for the public
 * booking-request submit path (Slice PB1.1 / ADR-0013).
 *
 * SHARED: imported by both:
 *   - packages/api/src/booking/submit-booking-request.ts (the orchestrator)
 *   - apps/web/app/book/[slug]/page.tsx (the public form — PB1.3)
 *
 * SECURITY CONTRACT (ADR-0013):
 *   - The schema validates REQUESTER input from the wire body.
 *   - It does NOT include org_id or slug — those are derived server-side
 *     from the URL path (never from the client body).
 *   - `website` is the honeypot field; presence-non-empty is handled by the
 *     orchestrator (not the schema) so the schema itself is field-agnostic.
 *   - Validation errors return a GENERIC { ok:false, reason:'invalid' } at
 *     the API layer — no field enumeration to the client.
 *
 * BOUNDS (mirror the migration-0015 DB CHECKs and spec PB1.1):
 *   name          1–120 chars (trimmed, nonempty after trim)
 *   email         valid format, ≤254 chars (lowercased + trimmed)
 *   phone?        ≤40 chars
 *   requestedStart ISO datetime required (basic ISO-8601; future check in orchestrator)
 *   requestedEnd?  ISO datetime, must be after requestedStart when provided
 *   aircraftTypePref?  ≤80 free-text
 *   message?       ≤2000
 *   website        honeypot — any value accepted by schema; non-empty handled in orchestrator
 *
 * DETERMINISM NOTE:
 *   The now-bound (≥now−1h, ≤now+365d) check is NOT baked into this schema
 *   because it would make the schema time-dependent and harder to property-test.
 *   A basic ISO datetime check here is sufficient; the orchestrator may add a
 *   future-bound check if desired without touching this file.
 */

import { z } from 'zod';

export const bookingRequestSchema = z
  .object({
    // Requester's full name. Trimmed; must be non-empty after trim; ≤120 chars.
    name: z
      .string()
      .trim()
      .min(1, 'Name is required')
      .max(120, 'Name must be 120 characters or fewer'),

    // Requester's email. Trimmed, lowercased, valid format, ≤254 chars.
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email('A valid email address is required')
      .max(254, 'Email must be 254 characters or fewer'),

    // Optional phone number. ≤40 chars.
    phone: z.string().max(40, 'Phone must be 40 characters or fewer').optional(),

    // Requested start datetime. Must be a valid ISO-8601 datetime string.
    // Future-bound validation ([now−1h, now+365d]) is the orchestrator's responsibility
    // to keep the schema deterministic.
    requestedStart: z
      .string()
      .datetime({ message: 'requestedStart must be a valid ISO-8601 datetime string' }),

    // Optional end datetime. When provided, must be a valid ISO datetime.
    // The cross-field end > start check is a .refine() below.
    requestedEnd: z
      .string()
      .datetime({ message: 'requestedEnd must be a valid ISO-8601 datetime string' })
      .optional(),

    // Free-text aircraft type preference (e.g. "Cessna 172"). ≤80 chars.
    // NOT a FK to resource — the requester types whatever they want.
    aircraftTypePref: z
      .string()
      .max(80, 'Aircraft type preference must be 80 characters or fewer')
      .optional(),

    // Optional free-text message from the requester. ≤2000 chars.
    message: z.string().max(2000, 'Message must be 2000 characters or fewer').optional(),

    // Honeypot field — bots fill hidden fields; humans don't see it and leave it empty.
    // The schema accepts any value (string, undefined, etc.); the ORCHESTRATOR checks
    // for non-empty presence and returns fake success without any DB access.
    // Typed as optional string so TypeScript callers can omit it.
    website: z.string().optional(),
  })
  .refine(
    (data) => {
      // Cross-field: requestedEnd must be after requestedStart when both are provided.
      if (!data.requestedEnd) return true;
      return new Date(data.requestedEnd) > new Date(data.requestedStart);
    },
    {
      message: 'requestedEnd must be after requestedStart',
      path: ['requestedEnd'],
    },
  );

/** Inferred TypeScript type for a validated booking-request input. */
export type BookingRequestInput = z.infer<typeof bookingRequestSchema>;
