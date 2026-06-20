/**
 * search-actions.ts — Server action for the Slice S1.2 command palette.
 *
 * Single action: searchOrgAction(query: string)
 *   1. await auth() → session.
 *   2. searchOrg(session, { query }) — requireCapability + RLS inside.
 *   3. UnauthenticatedError → safe { groups: [] } (palette shows empty, not forbidden).
 *
 * INVARIANTS:
 *   - No db import — @aeroops/api only.
 *   - No Date serialization needed — SearchResult only contains strings.
 *   - searchOrg already short-circuits for query.length < 2 (server-side guard).
 *   - The client enforces the same < 2 gate for perf, but the server is authoritative.
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 */
'use server';

import { auth } from '@/auth';
import { searchOrg, UnauthenticatedError } from '@aeroops/api';
import type { SearchOrgResult } from '@aeroops/api';

const EMPTY_RESULT: SearchOrgResult = { groups: [] };

/**
 * searchOrgAction — search the authenticated user's org for matching entities.
 *
 * Returns `{ groups: [] }` for:
 *   - unauthenticated sessions (UnauthenticatedError mapped to empty)
 *   - roles with no search caps (student/renter/accountant)
 *   - query < 2 chars (server short-circuits)
 *
 * Returns `{ error: true }` only for genuine server errors (not auth/empty).
 */
export async function searchOrgAction(
  query: string,
): Promise<SearchOrgResult | { error: true }> {
  const session = await auth();
  try {
    return await searchOrg(session, { query });
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      // Palette shows the "no matches" / empty state — not an error screen.
      return EMPTY_RESULT;
    }
    // Genuine server error — palette shows "Search is unavailable right now."
    return { error: true };
  }
}
