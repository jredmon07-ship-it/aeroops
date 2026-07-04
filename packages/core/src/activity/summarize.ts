/**
 * activity/summarize.ts — Pure audit-entry summarizer (the safety boundary).
 *
 * WHITELIST-ONLY: each known action reads ONLY specific, named metadata fields
 * to compose a human string. Unknown/future actions fall through to a generic
 * safe fallback. Raw JSON, money values, PII, and non-whitelisted fields are
 * NEVER included in the output.
 *
 * NOTE: grounding = operator data ("grounded N66RG"), NOT an FAA/Part-43/91
 * determination. No money in any string. No computed FAA determination.
 *
 * Two exported functions:
 *   summarizeAuditEntry({ action, entityType, metadata }) → string
 *   activityPath({ entityType, entityId, metadata }) → string | null
 */

// ─── Entity-type humanization ─────────────────────────────────────────────────

const ENTITY_TYPE_LABELS: Record<string, string> = {
  reservation:               'reservation',
  reservation_series:        'recurring series',
  resource:                  'resource',
  resource_blackout:         'blackout window',
  booking_policy:            'booking policy',
  dispatch_ticket:           'dispatch ticket',
  dispatch_config:           'dispatch configuration',
  dispatch_requirement:      'dispatch requirement',
  aircraft_grounding:        'aircraft grounding',
  squawk:                    'squawk',
  work_order:                'work order',
  app_user:                  'member',
  enrollment:                'training enrollment',
  course:                    'training course',
  course_lesson:             'course lesson',
  lesson_record:             'lesson record',
  schedule_optimization_run: 'auto-schedule run',
};

function humanizeEntityType(entityType: string): string {
  // Guard on the VALUE's type, not just nullishness: a prototype key like
  // "__proto__"/"constructor"/"toString" resolves to a truthy object/function
  // on a plain-object lookup, which the `??` would let through and then
  // stringify to "[object Object]" — leaking a raw object into the summary.
  // Only accept an own string value; otherwise humanize the key itself.
  const label = ENTITY_TYPE_LABELS[entityType];
  return typeof label === 'string' ? label : entityType.replace(/_/g, ' ');
}

// ─── Safe field accessors (whitelist-only) ────────────────────────────────────

/**
 * safeString — safely read a string field from metadata.
 * Returns the value only when it is a non-empty string; otherwise undefined.
 * NEVER falls back to JSON.stringify or any other dump.
 */
function safeString(metadata: unknown, key: string): string | undefined {
  if (metadata == null || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const val = (metadata as Record<string, unknown>)[key];
  if (typeof val === 'string' && val.length > 0) return val;
  return undefined;
}

/**
 * safeNumber — safely read a finite number field from metadata.
 * Returns the value only when it is a finite number; otherwise undefined.
 */
function safeNumber(metadata: unknown, key: string): number | undefined {
  if (metadata == null || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const val = (metadata as Record<string, unknown>)[key];
  if (typeof val === 'number' && isFinite(val)) return val;
  return undefined;
}

/**
 * safeNestedString — safely read a string from a nested object field.
 * E.g. safeNestedString(meta, 'after', 'status') reads meta.after.status.
 */
function safeNestedString(metadata: unknown, outer: string, inner: string): string | undefined {
  if (metadata == null || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const outerVal = (metadata as Record<string, unknown>)[outer];
  return safeString(outerVal, inner);
}

// ─── Action → summary templates ───────────────────────────────────────────────

export interface SummarizeAuditEntryInput {
  action: string;
  entityType: string;
  metadata: unknown;
}

/**
 * summarizeAuditEntry — returns a curated, human-readable summary string for
 * a given audit log entry. Reads ONLY whitelisted metadata fields per action.
 * Unknown/future actions → generic safe fallback (never raw jsonb).
 *
 * INVARIANT: output never contains a raw JSON fragment, never leaks a
 * non-whitelisted or PII value, is total (never throws), and is deterministic.
 */
export function summarizeAuditEntry({ action, entityType, metadata }: SummarizeAuditEntryInput): string {
  switch (action) {
    // ── Reservation ──────────────────────────────────────────────────────────
    case 'reservation.created': {
      const start = safeString(metadata, 'startAt');
      if (start) return `Reservation created starting ${start}`;
      return 'Reservation created';
    }
    case 'reservation.cancelled':
      return 'Reservation cancelled';
    case 'reservation.rescheduled': {
      return 'Reservation rescheduled';
    }

    // ── Series ────────────────────────────────────────────────────────────────
    case 'series.created': {
      const days = safeString(metadata, 'weekdays');
      if (days) return `Recurring series created (${days})`;
      return 'Recurring series created';
    }
    case 'series.cancelled':
      return 'Recurring series cancelled';

    // ── Resource ──────────────────────────────────────────────────────────────
    case 'resource.created': {
      const displayName = safeString(metadata, 'displayName');
      const tail = safeString(metadata, 'tailNumber');
      if (displayName && tail) return `Resource "${displayName}" (${tail}) added`;
      if (displayName) return `Resource "${displayName}" added`;
      return 'Resource added';
    }
    case 'resource.deactivated':
      return 'Resource deactivated';

    // ── Blackout ──────────────────────────────────────────────────────────────
    case 'resource_blackout.created': {
      const start = safeString(metadata, 'startAt');
      if (start) return `Blackout window created starting ${start}`;
      return 'Blackout window created';
    }
    case 'resource_blackout.deleted':
      return 'Blackout window removed';

    // ── Booking policy ────────────────────────────────────────────────────────
    case 'booking_policy.upserted':
      return 'Booking policy updated';
    case 'booking_policy.cleared':
      return 'Booking policy cleared';

    // ── Dispatch ──────────────────────────────────────────────────────────────
    case 'dispatch.opened': {
      return 'Aircraft checked out';
    }
    case 'dispatch.closed': {
      const hours = safeNumber(metadata, 'flightTimeHours');
      if (hours !== undefined) return `Aircraft checked in (${hours.toFixed(1)} hrs)`;
      return 'Aircraft checked in';
    }
    case 'dispatch.voided':
      return 'Dispatch ticket voided';

    // ── Dispatch gate config ──────────────────────────────────────────────────
    case 'dispatch.config_updated':
      return 'Dispatch gate configuration updated';
    case 'dispatch.requirement_added': {
      const tag = safeString(metadata, 'requiredTag');
      if (tag) return `Required dispatch tag added: "${tag}"`;
      return 'Required dispatch tag added';
    }
    case 'dispatch.requirement_removed': {
      const tag = safeString(metadata, 'requiredTag');
      if (tag) return `Required dispatch tag removed: "${tag}"`;
      return 'Required dispatch tag removed';
    }

    // ── Grounding ─────────────────────────────────────────────────────────────
    case 'grounding.grounded': {
      const reason = safeString(metadata, 'reason');
      if (reason) return `Aircraft grounded: ${reason}`;
      return 'Aircraft grounded';
    }
    case 'grounding.released':
      return 'Aircraft grounding released';

    // ── Squawk ────────────────────────────────────────────────────────────────
    case 'squawk.reported': {
      const title = safeString(metadata, 'title');
      if (title) return `Squawk reported: "${title}"`;
      return 'Squawk reported';
    }
    case 'squawk.status_changed': {
      const newStatus = safeString(metadata, 'newStatus');
      if (newStatus) return `Squawk status updated to ${newStatus}`;
      return 'Squawk status updated';
    }

    // ── Work orders ───────────────────────────────────────────────────────────
    case 'work_order.opened': {
      const title = safeString(metadata, 'title');
      if (title) return `Work order opened: "${title}"`;
      return 'Work order opened';
    }
    case 'work_order.status_changed': {
      const newStatus = safeString(metadata, 'newStatus');
      if (newStatus) return `Work order status updated to ${newStatus}`;
      return 'Work order status updated';
    }
    case 'work_order.completed':
      return 'Work order completed';
    case 'work_order.cancelled':
      return 'Work order cancelled';

    // ── Aircraft ─────────────────────────────────────────────────────────────
    case 'aircraft.updated': {
      const afterName = safeNestedString(metadata, 'after', 'displayName');
      if (afterName) return `Aircraft "${afterName}" updated`;
      return 'Aircraft details updated';
    }

    // ── Members ───────────────────────────────────────────────────────────────
    case 'member.created': {
      const fullName = safeString(metadata, 'fullName');
      if (fullName) return `Member "${fullName}" added to roster`;
      return 'Member added to roster';
    }
    case 'member.updated':
      return 'Member profile updated';
    case 'member.status_changed': {
      const after = safeNestedString(metadata, 'after', 'status');
      if (after) return `Member status changed to ${after}`;
      return 'Member status changed';
    }
    case 'member.tag_added': {
      const tag = safeString(metadata, 'tag');
      if (tag) return `Tag added to member: "${tag}"`;
      return 'Tag added to member';
    }
    case 'member.tag_removed': {
      const tag = safeString(metadata, 'tag');
      if (tag) return `Tag removed from member: "${tag}"`;
      return 'Tag removed from member';
    }

    // ── Training ──────────────────────────────────────────────────────────────
    case 'training.course_created': {
      const title = safeString(metadata, 'title');
      if (title) return `Training course created: "${title}"`;
      return 'Training course created';
    }
    case 'training.lesson_added': {
      const title = safeString(metadata, 'title');
      if (title) return `Lesson added to course: "${title}"`;
      return 'Lesson added to course';
    }
    case 'training.lesson_removed':
      return 'Lesson removed from course';
    case 'training.member_enrolled':
      return 'Member enrolled in course';
    case 'training.enrollment_status_changed': {
      const to = safeString(metadata, 'to');
      if (to) return `Enrollment status changed to ${to}`;
      return 'Enrollment status changed';
    }
    case 'training.lesson_recorded':
      return 'Lesson recorded';
    case 'training.lesson_record_voided':
      return 'Lesson record voided';

    // ── Auto-scheduler ────────────────────────────────────────────────────────
    case 'optimization_run.created': {
      const created = safeNumber(metadata, 'createdCount');
      if (created !== undefined) return `Auto-schedule run completed (${created} reservation${created === 1 ? '' : 's'} created)`;
      return 'Auto-schedule run completed';
    }

    // ── Generic fallback (unknown/future actions) ─────────────────────────────
    default:
      return `performed an action on a ${humanizeEntityType(entityType)}`;
  }
}

// ─── activityPath ─────────────────────────────────────────────────────────────

export interface ActivityPathInput {
  entityType: string;
  entityId: string | null | undefined;
  metadata: unknown;
}

/**
 * activityPath — returns a slug-less relative path to the affected entity,
 * or null when there is no live navigable target.
 *
 * Routes:
 *   reservation / reservation_series → /board (dispatch board)
 *   resource / booking_policy / resource_blackout → /fleet/{entityId}
 *     (resource entityId IS the resourceId, or read resourceId from metadata)
 *   dispatch_ticket → /board
 *   dispatch_config / dispatch_requirement → /board (gate settings)
 *   aircraft_grounding / squawk → /maintenance/squawks
 *   work_order → /maintenance/work-orders/{entityId}
 *   app_user → /people/{entityId}
 *   course / course_lesson → /training/{courseId}
 *   enrollment / lesson_record → /training/enrollments
 *   schedule_optimization_run → /schedule/auto
 *
 * NOTE: there is NO bare /maintenance page.
 */
export function activityPath({ entityType, entityId, metadata }: ActivityPathInput): string | null {
  switch (entityType) {
    case 'reservation':
    case 'reservation_series':
    case 'dispatch_ticket':
    case 'dispatch_config':
    case 'dispatch_requirement':
      return '/board';

    case 'resource': {
      if (entityId) return `/fleet/${entityId}`;
      return null;
    }
    case 'booking_policy': {
      // booking_policy entityId is the policy row id; metadata.resourceId is the resource
      const resourceId = safeString(metadata, 'resourceId');
      if (resourceId) return `/fleet/${resourceId}`;
      if (entityId) return `/fleet/${entityId}`;
      return null;
    }
    case 'resource_blackout': {
      const resourceId = safeString(metadata, 'resourceId');
      if (resourceId) return `/fleet/${resourceId}`;
      return null;
    }

    case 'aircraft_grounding':
    case 'squawk':
      return '/maintenance/squawks';

    case 'work_order': {
      if (entityId) return `/maintenance/work-orders/${entityId}`;
      return '/maintenance/work-orders';
    }

    case 'app_user': {
      if (entityId) return `/people/${entityId}`;
      return null;
    }

    case 'course': {
      if (entityId) return `/training/${entityId}`;
      return null;
    }
    case 'course_lesson': {
      // courseId is in metadata
      const courseId = safeString(metadata, 'courseId');
      if (courseId) return `/training/${courseId}`;
      return null;
    }
    case 'enrollment':
    case 'lesson_record':
      return '/training/enrollments';

    case 'schedule_optimization_run':
      return '/schedule/auto';

    default:
      return null;
  }
}
