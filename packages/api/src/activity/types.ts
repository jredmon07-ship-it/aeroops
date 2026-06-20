/**
 * activity/types.ts — public types for the activity feed API (Slice A1.1).
 *
 * ActivityEntry: a single mapped audit-log row ready for display.
 * ActivityCursor: keyset cursor for paginated reads (created_at + id pair).
 * ListActivityResult: paginated result with optional nextCursor.
 */

// ─── ActivityEntry ────────────────────────────────────────────────────────────

/**
 * A single activity feed entry — a curated view of one audit_log row.
 *
 * actorName:   resolved display name; "System" when actor_user_id IS NULL;
 *              "A former user" when the join row is missing (user hard-deleted).
 * summary:     whitelist-only human string from summarizeAuditEntry (core, no raw jsonb).
 * entityType:  raw entity_type from audit_log (for UI icon selection).
 * entityPath:  relative nav path from activityPath, or null when no live target.
 * createdAt:   timestamp of the audit row.
 */
export interface ActivityEntry {
  id: string;
  actorName: string;
  summary: string;
  entityType: string;
  entityPath: string | null;
  createdAt: Date;
}

// ─── Cursor ───────────────────────────────────────────────────────────────────

/**
 * ActivityCursor — keyset cursor for stable pagination over (created_at, id).
 * Both fields must be provided; partial cursors are invalid.
 */
export interface ActivityCursor {
  createdAt: Date;
  id: string;
}

// ─── Result ───────────────────────────────────────────────────────────────────

/**
 * ListActivityResult — paginated result.
 *
 * nextCursor is present ONLY when a full page (limit rows) was returned,
 * indicating more pages may exist. Absent on the final page.
 */
export interface ListActivityResult {
  entries: ActivityEntry[];
  nextCursor?: ActivityCursor;
}

// ─── Options ──────────────────────────────────────────────────────────────────

/**
 * ListActivityOptions — caller-provided pagination options.
 *
 * limit:  rows per page; default 50, cap 100.
 * cursor: keyset cursor from a prior call's nextCursor.
 */
export interface ListActivityOptions {
  limit?: number;
  cursor?: ActivityCursor;
}
