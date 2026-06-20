/**
 * alerts-actions.ts — Server action for the Slice N1.2 alerts bell.
 *
 * Single action: getMyAlertsAction()
 *   1. await auth() → session.
 *   2. getMyAlerts(session) — requireCapability + RLS + self-scoping inside.
 *   3. Serialize Date fields (at → ISO string) for JSON transport.
 *   4. UnauthenticatedError → safe { error: 'unauthenticated' }.
 *   5. Genuine server errors → { error: 'server' }.
 *
 * INVARIANTS:
 *   - No db import — @aeroops/api only.
 *   - Date serialization: `at` (Date) → ISO string at this boundary.
 *   - app:access is held by ALL 8 roles — every authenticated user gets the bell.
 *   - Self-scoped: getMyAlerts uses session.userId only (zero IDOR).
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 */
'use server';

import { auth } from '@/auth';
import { getMyAlerts, UnauthenticatedError } from '@aeroops/api';
import type { AlertKind } from '@aeroops/api';

// ─── Serialized result types ──────────────────────────────────────────────────

/** MyAlert with `at` serialized to ISO string (safe for JSON transport). */
export interface SerializedAlert {
  id: string;
  kind: AlertKind;
  title: string;
  detail: string;
  path: string | null;
  /** ISO 8601 string — serialized from the Date at this action boundary. */
  at: string;
}

export interface SerializedAlertsResult {
  alerts: SerializedAlert[];
  count: number;
}

export type AlertsActionResult =
  | SerializedAlertsResult
  | { error: 'unauthenticated' }
  | { error: 'server' };

// ─── getMyAlertsAction ────────────────────────────────────────────────────────

/**
 * getMyAlertsAction — fetch the current user's derived in-app alerts.
 *
 * Returns a serialized result (Dates → ISO) so the client component
 * can receive a plain JSON payload.
 *
 * Returns `{ error: 'unauthenticated' }` when the session is invalid.
 * Returns `{ error: 'server' }` for genuine server errors.
 */
export async function getMyAlertsAction(): Promise<AlertsActionResult> {
  const session = await auth();
  try {
    const result = await getMyAlerts(session);
    // Serialize Dates at the action boundary.
    const alerts: SerializedAlert[] = result.alerts.map((a) => ({
      id: a.id,
      kind: a.kind,
      title: a.title,
      detail: a.detail,
      path: a.path,
      at: a.at.toISOString(),
    }));
    return { alerts, count: alerts.length };
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      return { error: 'unauthenticated' };
    }
    return { error: 'server' };
  }
}
