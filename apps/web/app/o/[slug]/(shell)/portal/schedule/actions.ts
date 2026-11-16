/**
 * portal/schedule/actions.ts — Server action for the member Schedule
 * (/o/[slug]/portal/schedule).
 *
 * Pattern mirrors portal/actions.ts:
 *   1. await auth() → session (a session the server has ended → sign-in).
 *   2. Call @aeroops/api listMemberAvailability (portal:access inside).
 *   3. Map ForbiddenError / UnauthenticatedError / ValidationError → result.
 *
 * SELF-SCOPING: only the window crosses this boundary. The API reads "me"
 * from the session, so a member's own bookings are the only ones that carry
 * notes and labels; everyone else's say when, never who.
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 */
'use server';

import { actionAuth as auth } from '@/lib/action-auth';
import { listMemberAvailability } from '@aeroops/api';
import type { MemberAvailabilityResult } from '@aeroops/api';
import { mapActionError } from '@/lib/action-errors-result';
import type {
  AuthErrorResult,
  ValidationErrorResult,
  ServerErrorResult,
} from '@/lib/action-errors-result';

export type GetMemberScheduleActionResult =
  | { ok: true; availability: MemberAvailabilityResult }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

/**
 * getMemberScheduleAction — when the org's aircraft and instructors are taken
 * in the half-open window [from, to) (the page passes one day, dayWindow).
 */
export async function getMemberScheduleAction(input: {
  from: Date;
  to: Date;
}): Promise<GetMemberScheduleActionResult> {
  const session = await auth();
  try {
    // Only from/to are passed on — nothing else a caller sends reaches the API.
    const availability = await listMemberAvailability(session, {
      from: input.from,
      to: input.to,
    });
    return { ok: true, availability };
  } catch (err) {
    const mapped = mapActionError(err);
    if (mapped) return mapped;
    return { error: 'server' };
  }
}
