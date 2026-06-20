/**
 * convert-dialog-utils.ts — Pure display helpers for the convert-dialog (Slice PB2.2).
 *
 * PURE: no I/O, no DOM, no Next.js, no React. Unit-testable in isolation.
 * Extracted from convert-dialog.tsx so vitest (node environment) can import them
 * without parsing JSX (mirrors the booking-utils.ts / booking-utils.test.ts pattern).
 *
 * Exported for use by ConvertDialog (client component) and tests.
 */

import type { ConflictHit, PolicyViolationView, TwilightHit } from '@aeroops/api';

// ─── toDatetimeLocal ───────────────────────────────────────────────────────────

/**
 * toDatetimeLocal — formats a Date as "YYYY-MM-DDTHH:MM" for datetime-local inputs.
 * Uses LOCAL time (not UTC) so the pre-filled value matches what the user expects.
 *
 * @param d - A valid Date object.
 * @returns  - "YYYY-MM-DDTHH:MM" string in local time.
 */
export function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

// ─── defaultEndAt ──────────────────────────────────────────────────────────────

/**
 * defaultEndAt — returns the datetime-local string for the default endAt.
 *
 * If requestedEnd is a valid ISO string, uses it (formatted via toDatetimeLocal).
 * Otherwise defaults to startAt + 1 hour (the spec default when end is null).
 * Returns '' when startAt is also invalid/empty.
 *
 * @param requestedStart - ISO string for the request's requestedStart.
 * @param requestedEnd   - ISO string for the request's requestedEnd, or null.
 * @returns               - datetime-local string, or '' on parse failure.
 */
export function defaultEndAt(requestedStart: string, requestedEnd: string | null): string {
  if (requestedEnd) {
    try {
      const d = new Date(requestedEnd);
      if (!isNaN(d.getTime())) return toDatetimeLocal(d);
    } catch { /* fall through */ }
  }
  try {
    const start = new Date(requestedStart);
    if (!isNaN(start.getTime())) {
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      return toDatetimeLocal(end);
    }
  } catch { /* fall through */ }
  return '';
}

// ─── violationMessage ─────────────────────────────────────────────────────────

/**
 * violationMessage — produce a human-readable string for a PolicyViolationView.
 * PolicyViolationView is a discriminated union over `kind` (not a `message` field).
 *
 * @param v - A PolicyViolationView from the API (enriched with resourceDisplayName).
 * @returns   - A short human-readable copy string.
 */
export function violationMessage(v: PolicyViolationView): string {
  switch (v.kind) {
    case 'max_duration_exceeded':
      return `Exceeds the maximum duration of ${v.limitMinutes} min for ${v.resourceDisplayName}.`;
    case 'too_far_in_advance':
      return `Too far in advance — maximum ${v.limitDays} day(s) ahead for ${v.resourceDisplayName}.`;
    case 'insufficient_lead_time':
      return `Too soon — requires at least ${v.requiredMinutes} min lead time for ${v.resourceDisplayName}.`;
    case 'blackout_overlap':
      return `Overlaps a blackout window on ${v.resourceDisplayName}.`;
    default:
      return `Policy violation on ${(v as PolicyViolationView).resourceDisplayName}.`;
  }
}

// ─── refusalReasonCopy ────────────────────────────────────────────────────────

/**
 * refusalReasonCopy — per-reason human copy for the inline refusal panel
 * in the convert-dialog. Mirrors the language used in new-reservation-form.tsx.
 *
 * Returns { headline, detail } where detail may be null. The caller is responsible
 * for appending "No reservation was created." to the rendered output.
 *
 * [VERIFY-PB2-COMP-1]: twilight copy is astronomy-only; NOT an FAA §61.57
 * night-currency determination. The disclaimer in the twilight `detail` is verbatim.
 *
 * @param reason    - The ok:false reason string from ConvertBookingRequestResult.
 * @param conflicts - Conflict hits (for 'conflict' / 'conflict_and_policy').
 * @param violations - Policy violation views (for 'policy' / 'conflict_and_policy').
 * @param twilight  - Twilight hits (for 'twilight').
 * @returns           - { headline: string; detail: string | null }
 */
export function refusalReasonCopy(
  reason: string,
  conflicts?: ConflictHit[],
  violations?: PolicyViolationView[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  twilight?: TwilightHit[],
): { headline: string; detail: string | null } {
  switch (reason) {
    case 'conflict': {
      const windows = (conflicts ?? []).map((c) => {
        try {
          const start = new Intl.DateTimeFormat(undefined, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
          }).format(new Date(c.start));
          const end = new Intl.DateTimeFormat(undefined, {
            hour: '2-digit', minute: '2-digit',
          }).format(new Date(c.end));
          return `${c.resourceDisplayName} ${start}–${end}`;
        } catch {
          return c.resourceDisplayName;
        }
      });
      return {
        headline: 'That tail is already booked. Pick another time or aircraft.',
        detail: windows.length > 0 ? windows.join('; ') : null,
      };
    }
    case 'policy': {
      const msgs = (violations ?? []).map(violationMessage).join(' ');
      return {
        headline: 'A booking policy prevents this reservation.',
        detail: msgs || null,
      };
    }
    case 'conflict_and_policy': {
      const windows = (conflicts ?? []).map((c) => {
        try {
          const start = new Intl.DateTimeFormat(undefined, {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
          }).format(new Date(c.start));
          const end = new Intl.DateTimeFormat(undefined, {
            hour: '2-digit', minute: '2-digit',
          }).format(new Date(c.end));
          return `${c.resourceDisplayName} ${start}–${end}`;
        } catch {
          return c.resourceDisplayName;
        }
      });
      const msgs = (violations ?? []).map(violationMessage).join(' ');
      return {
        headline: 'That tail is already booked and a policy was violated. Pick another time or aircraft.',
        detail: [windows.join('; '), msgs].filter(Boolean).join(' — ') || null,
      };
    }
    case 'twilight':
      return {
        headline:
          'This flight crosses civil dusk/dawn and the operator blocks night ops for this aircraft.',
        // Verbatim disclaimer per spec + compliance [VERIFY-PB2-COMP-1].
        // NOT an FAA §61.57 determination.
        detail:
          'Note: this is an astronomy/operator-config check only — it is NOT an FAA §61.57 night-currency or night-flight determination.',
      };
    case 'availability':
      return {
        headline: "That time is outside the aircraft's operating hours.",
        detail: 'Adjust the time or contact your operator to change availability settings.',
      };
    default:
      return {
        headline: 'The reservation could not be created.',
        detail: null,
      };
  }
}
