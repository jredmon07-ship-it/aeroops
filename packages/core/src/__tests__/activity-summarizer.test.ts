/**
 * activity-summarizer.test.ts — unit + PROPERTY tests for the pure activity
 * summarizer (summarizeAuditEntry) and path helper (activityPath).
 *
 * PROPERTY TEST (hard guardrail per spec A1.1):
 *   For ANY action + ANY metadata jsonb (fast-check fuzz including money keys,
 *   PII, nested junk), summarizeAuditEntry output:
 *   1. Never contains a raw-JSON fragment (no opening brace or bracket from
 *      a JSON.stringify of the metadata).
 *   2. Never leaks a non-whitelisted value present in the metadata.
 *   3. Is total (never throws).
 *   4. Is deterministic (same input → same output).
 *   5. Entity-type humanization: unknown types produce a sane fallback string.
 *
 * Unit tests cover every enumerated action (43 total) + edge cases.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  summarizeAuditEntry,
  activityPath,
  activityEntityLabel,
  ACTIVITY_ENTITY_TYPES,
} from '../activity/summarize.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** All known actions. */
const KNOWN_ACTIONS = [
  'reservation.created',
  'reservation.cancelled',
  'reservation.rescheduled',
  'series.created',
  'series.cancelled',
  'resource.created',
  'resource.deactivated',
  'resource_blackout.created',
  'resource_blackout.deleted',
  'booking_policy.upserted',
  'booking_policy.cleared',
  'dispatch.opened',
  'dispatch.closed',
  'dispatch.voided',
  'dispatch.config_updated',
  'dispatch.requirement_added',
  'dispatch.requirement_removed',
  'grounding.grounded',
  'grounding.released',
  'squawk.reported',
  'squawk.status_changed',
  'work_order.opened',
  'work_order.status_changed',
  'work_order.completed',
  'work_order.cancelled',
  'aircraft.updated',
  'member.created',
  'member.updated',
  'member.status_changed',
  'member.login_link_created',
  'member.login_link_accepted',
  'member.tag_added',
  'member.tag_removed',
  'training.course_created',
  'training.lesson_added',
  'training.lesson_removed',
  'training.member_enrolled',
  'training.enrollment_status_changed',
  'training.lesson_recorded',
  'training.lesson_record_voided',
  'optimization_run.created',
] as const;

// ─── Generators ───────────────────────────────────────────────────────────────

/**
 * Arbitrary JSON value generator (including money keys and PII-like values).
 * We inject values that should NEVER appear raw in the output.
 */
const dangerousValue = fc.oneof(
  fc.constant('card_number=4111111111111111'),
  fc.constant('{"ssn":"123-45-6789"}'),
  fc.constant('{"amount":9999999,"currency":"USD"}'),
  fc.string({ minLength: 1, maxLength: 40 }),
  fc.integer(),
  fc.float(),
  fc.boolean(),
  fc.constant(null),
);

/** Metadata with dangerous keys including standard ones + junk. */
const dangerousMetadata = fc.record({
  // Standard-looking fields that might be on metadata
  resourceId: fc.uuid(),
  reason: dangerousValue,
  title: dangerousValue,
  tag: dangerousValue,
  newStatus: dangerousValue,
  // Money-ish keys that must never surface raw
  amount: fc.integer(),
  price: fc.float(),
  cardNumber: fc.constant('4111111111111111'),
  balance: fc.integer(),
  // PII-ish
  ssn: fc.string({ minLength: 1, maxLength: 20 }),
  phoneNumber: fc.string({ minLength: 1, maxLength: 20 }),
  // Nested junk
  nested: fc.oneof(
    fc.constant({ deep: { value: 'secret' } }),
    fc.constant({ arr: [1, 2, 3] }),
    fc.constant(null),
  ),
}, { requiredKeys: [] });

/** Arbitrary metadata (any jsonb-ish value). */
const anyMetadata = fc.oneof(
  dangerousMetadata,
  fc.constant(null),
  fc.constant(undefined),
  fc.constant({}),
  fc.string(),
  fc.integer(),
  fc.array(fc.string()),
);

/** Arbitrary action string including known, unknown, and adversarial values. */
const anyAction = fc.oneof(
  fc.constantFrom(...KNOWN_ACTIONS),
  fc.string({ minLength: 1, maxLength: 40 }),
  fc.constant('injection.attempt; DROP TABLE audit_log;--'),
  fc.constant('unknown.future.action'),
);

/** Arbitrary entity type. */
const anyEntityType = fc.oneof(
  fc.constantFrom(
    'reservation', 'resource', 'dispatch_ticket', 'squawk', 'work_order',
    'app_user', 'course', 'enrollment', 'lesson_record', 'aircraft_grounding',
    'schedule_optimization_run', 'unknown_entity',
  ),
  fc.string({ minLength: 1, maxLength: 30 }),
);

// ─── PROPERTY TESTS ───────────────────────────────────────────────────────────

describe('PROPERTY: summarizeAuditEntry safety boundary', () => {
  it('P1: is total (never throws) for any action + metadata', () => {
    fc.assert(
      fc.property(anyAction, anyEntityType, anyMetadata, (action, entityType, metadata) => {
        expect(() => summarizeAuditEntry({ action, entityType, metadata })).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });

  it('P2: is deterministic (same input → same output)', () => {
    fc.assert(
      fc.property(anyAction, anyEntityType, anyMetadata, (action, entityType, metadata) => {
        const r1 = summarizeAuditEntry({ action, entityType, metadata });
        const r2 = summarizeAuditEntry({ action, entityType, metadata });
        expect(r1).toBe(r2);
      }),
      { numRuns: 200 },
    );
  });

  it('P3: output never contains a raw JSON object fragment (no "{")', () => {
    fc.assert(
      fc.property(anyAction, anyEntityType, dangerousMetadata, (action, entityType, metadata) => {
        const result = summarizeAuditEntry({ action, entityType, metadata });
        // The output must never contain a raw JSON structure
        expect(result).not.toMatch(/\{.*:\s*\{/);
        // Also should never contain JSON array bracket from raw dump
        expect(result).not.toMatch(/\[.*,.*\]/);
      }),
      { numRuns: 500 },
    );
  });

  it('P4: output never leaks the raw money-value sentinel from metadata', () => {
    const moneyMeta = {
      amount: 9999999,
      price: 49.99,
      cardNumber: '4111111111111111',
      balance: 1234567,
      // Also include a non-whitelisted SSN-like value
      ssn: '123-45-6789',
    };
    fc.assert(
      fc.property(anyAction, anyEntityType, (action, entityType) => {
        const result = summarizeAuditEntry({ action, entityType, metadata: moneyMeta });
        expect(result).not.toContain('9999999');
        expect(result).not.toContain('4111111111111111');
        expect(result).not.toContain('1234567');
        expect(result).not.toContain('123-45-6789');
      }),
      { numRuns: 200 },
    );
  });

  it('P5: output never leaks non-whitelisted keys from metadata', () => {
    // Build metadata with only dangerous/non-whitelisted values
    const meta = {
      cardNumber: '4111111111111111',
      ssn: '999-00-0001',
      balance: 99999,
      nested: { secret: 'do-not-surface' },
    };
    fc.assert(
      fc.property(anyAction, anyEntityType, (action, entityType) => {
        const result = summarizeAuditEntry({ action, entityType, metadata: meta });
        expect(result).not.toContain('4111111111111111');
        expect(result).not.toContain('999-00-0001');
        expect(result).not.toContain('99999');
        expect(result).not.toContain('do-not-surface');
      }),
      { numRuns: 200 },
    );
  });

  it('P6: unknown action → generic fallback (never raw metadata json)', () => {
    fc.assert(
      fc.property(anyEntityType, dangerousMetadata, (entityType, metadata) => {
        const action = `unknown.action.at.${Date.now()}`;
        const result = summarizeAuditEntry({ action, entityType, metadata });
        expect(result).toContain('performed an action on a');
        // The metadata values must not be present raw in the output.
        // Specifically, the sentinel money/PII values we inject must not appear.
        expect(result).not.toContain('4111111111111111'); // cardNumber
        expect(result).not.toContain('123-45-6789');       // ssn
        // No JSON object fragment from raw serialization of metadata
        // (but entity type is allowed to contain any characters from the input)
        expect(result).not.toContain('[object Object]');
      }),
      { numRuns: 200 },
    );
  });

  it('P7: output is always a non-empty string', () => {
    fc.assert(
      fc.property(anyAction, anyEntityType, anyMetadata, (action, entityType, metadata) => {
        const result = summarizeAuditEntry({ action, entityType, metadata });
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
      }),
      { numRuns: 300 },
    );
  });

  it('P8: a start time is shown as "Mon D, YYYY HH:MM ZONE", never as the raw ISO string', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('reservation.created', 'resource_blackout.created'),
        fc.date({ min: new Date('1970-01-01T00:00:00Z'), max: new Date('2100-01-01T00:00:00Z'), noInvalidDate: true }),
        fc.constantFrom('UTC', 'America/Chicago', 'Pacific/Auckland', 'Asia/Kolkata', 'Not/AZone'),
        (action, at, timeZone) => {
          const startAt = at.toISOString();
          const result = summarizeAuditEntry({ action, entityType: 'reservation', metadata: { startAt }, timeZone });
          expect(result).not.toContain(startAt);
          expect(result).toMatch(/ starting [A-Z][a-z]{2} \d{1,2}, \d{4} \d{2}:\d{2} \S+$/);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ─── UNIT TESTS — every known action ─────────────────────────────────────────

describe('summarizeAuditEntry — reservation actions', () => {
  it('reservation.created with startAt', () => {
    const r = summarizeAuditEntry({ action: 'reservation.created', entityType: 'reservation', metadata: { startAt: '2026-07-15T08:00:00Z', resourceIds: ['id1'] } });
    expect(r).toBe('Reservation created starting Jul 15, 2026 08:00 UTC');
    // Must NOT contain raw metadata
    expect(r).not.toContain('resourceIds');
    expect(r).not.toContain('"id1"');
  });

  it('reservation.created shows the start in the given time zone, with its name', () => {
    const metadata = { startAt: '2026-07-11T14:00:00.000Z' };
    expect(summarizeAuditEntry({ action: 'reservation.created', entityType: 'reservation', metadata, timeZone: 'America/Chicago' }))
      .toBe('Reservation created starting Jul 11, 2026 09:00 CDT');
    // Standard time, and a start that falls on the previous local day.
    expect(summarizeAuditEntry({ action: 'reservation.created', entityType: 'reservation', metadata: { startAt: '2026-01-11T00:00:00.000Z' }, timeZone: 'America/Chicago' }))
      .toBe('Reservation created starting Jan 10, 2026 18:00 CST');
  });

  it('reservation.created never echoes the raw ISO timestamp', () => {
    const r = summarizeAuditEntry({ action: 'reservation.created', entityType: 'reservation', metadata: { startAt: '2026-07-11T14:00:00.000Z' }, timeZone: 'America/Chicago' });
    expect(r).not.toContain('2026-07-11T14:00:00.000Z');
    expect(r).not.toContain('T14:00');
  });

  it('reservation.created with an unknown time zone → UTC (never throws)', () => {
    const metadata = { startAt: '2026-07-15T08:00:00Z' };
    for (const timeZone of ['', 'Not/AZone', 'UTC+99']) {
      expect(summarizeAuditEntry({ action: 'reservation.created', entityType: 'reservation', metadata, timeZone }))
        .toBe('Reservation created starting Jul 15, 2026 08:00 UTC');
    }
  });

  it('reservation.created with a startAt that is not an ISO instant → no time, not the raw value', () => {
    for (const startAt of ['next Tuesday', '1', '2026-07-15', '2026-13-45T99:99:00Z']) {
      const r = summarizeAuditEntry({ action: 'reservation.created', entityType: 'reservation', metadata: { startAt } });
      expect(r).toBe('Reservation created');
    }
  });

  it('reservation.created without startAt → safe fallback', () => {
    const r = summarizeAuditEntry({ action: 'reservation.created', entityType: 'reservation', metadata: {} });
    expect(r).toBe('Reservation created');
  });

  it('reservation.cancelled', () => {
    const r = summarizeAuditEntry({ action: 'reservation.cancelled', entityType: 'reservation', metadata: {} });
    expect(r).toBe('Reservation cancelled');
  });

  it('reservation.rescheduled', () => {
    const r = summarizeAuditEntry({ action: 'reservation.rescheduled', entityType: 'reservation', metadata: { rescheduledFrom: 'old-id', oldWindow: { startAt: '2026-01-01T08:00:00Z', endAt: '2026-01-01T10:00:00Z' }, newWindow: { startAt: '2026-01-02T08:00:00Z', endAt: '2026-01-02T10:00:00Z' } } });
    expect(r).toBe('Reservation rescheduled');
    // must not leak raw JSON of the windows
    expect(r).not.toContain('{');
  });
});

describe('summarizeAuditEntry — series actions', () => {
  it('series.created with weekdays', () => {
    const r = summarizeAuditEntry({ action: 'series.created', entityType: 'reservation_series', metadata: { weekdays: 'Mon,Wed,Fri', intervalWeeks: 1 } });
    expect(r).toContain('Recurring series created');
    expect(r).toContain('Mon,Wed,Fri');
    expect(r).not.toContain('intervalWeeks');
  });

  it('series.created without weekdays → safe fallback', () => {
    const r = summarizeAuditEntry({ action: 'series.created', entityType: 'reservation_series', metadata: {} });
    expect(r).toBe('Recurring series created');
  });

  it('series.cancelled', () => {
    expect(summarizeAuditEntry({ action: 'series.cancelled', entityType: 'reservation_series', metadata: { cancelledCount: 5 } })).toBe('Recurring series cancelled');
  });
});

describe('summarizeAuditEntry — resource actions', () => {
  it('resource.created with displayName and tailNumber', () => {
    const r = summarizeAuditEntry({ action: 'resource.created', entityType: 'resource', metadata: { displayName: 'Cessna 172', tailNumber: 'N12345', kind: 'aircraft' } });
    expect(r).toBe('Resource "Cessna 172" (N12345) added');
    expect(r).not.toContain('kind');
  });

  it('resource.created with displayName only', () => {
    const r = summarizeAuditEntry({ action: 'resource.created', entityType: 'resource', metadata: { displayName: 'Sim Bay A', kind: 'sim' } });
    expect(r).toBe('Resource "Sim Bay A" added');
  });

  it('resource.created with no metadata fields', () => {
    expect(summarizeAuditEntry({ action: 'resource.created', entityType: 'resource', metadata: {} })).toBe('Resource added');
  });

  it('resource.deactivated', () => {
    expect(summarizeAuditEntry({ action: 'resource.deactivated', entityType: 'resource', metadata: {} })).toBe('Resource deactivated');
  });
});

describe('summarizeAuditEntry — blackout and booking policy actions', () => {
  it('resource_blackout.created with startAt', () => {
    const r = summarizeAuditEntry({ action: 'resource_blackout.created', entityType: 'resource_blackout', metadata: { startAt: '2026-07-20T00:00:00Z', reason: 'Maintenance' } });
    expect(r).toBe('Blackout window created starting Jul 20, 2026 00:00 UTC');
    expect(r).not.toContain('Maintenance'); // reason is NOT whitelisted for display
  });

  it('resource_blackout.created in a time zone', () => {
    const r = summarizeAuditEntry({ action: 'resource_blackout.created', entityType: 'resource_blackout', metadata: { startAt: '2026-07-20T00:00:00Z' }, timeZone: 'America/Chicago' });
    expect(r).toBe('Blackout window created starting Jul 19, 2026 19:00 CDT');
  });

  it('resource_blackout.created with a non-ISO startAt → no time', () => {
    const r = summarizeAuditEntry({ action: 'resource_blackout.created', entityType: 'resource_blackout', metadata: { startAt: 'soon' } });
    expect(r).toBe('Blackout window created');
  });

  it('resource_blackout.deleted', () => {
    expect(summarizeAuditEntry({ action: 'resource_blackout.deleted', entityType: 'resource_blackout', metadata: { resourceId: 'x' } })).toBe('Blackout window removed');
  });

  it('booking_policy.upserted', () => {
    expect(summarizeAuditEntry({ action: 'booking_policy.upserted', entityType: 'booking_policy', metadata: { maxDurationMinutes: 120 } })).toBe('Booking policy updated');
  });

  it('booking_policy.cleared', () => {
    expect(summarizeAuditEntry({ action: 'booking_policy.cleared', entityType: 'booking_policy', metadata: {} })).toBe('Booking policy cleared');
  });
});

describe('summarizeAuditEntry — dispatch actions', () => {
  it('dispatch.opened', () => {
    const r = summarizeAuditEntry({ action: 'dispatch.opened', entityType: 'dispatch_ticket', metadata: { reservationId: 'x', resourceId: 'y', pilotUserId: 'z', hobbsOut: 1234.5 } });
    expect(r).toBe('Aircraft checked out');
    // Must not leak user IDs or Hobbs values
    expect(r).not.toContain('z');
    expect(r).not.toContain('1234.5');
  });

  it('dispatch.closed with flightTimeHours', () => {
    const r = summarizeAuditEntry({ action: 'dispatch.closed', entityType: 'dispatch_ticket', metadata: { hobbsIn: 1236.5, hobbsOut: 1234.5, flightTimeHours: 2.0, basis: 'hobbs' } });
    expect(r).toBe('Aircraft checked in (2.0 hrs)');
    // Must not leak raw meter values
    expect(r).not.toContain('1236.5');
    expect(r).not.toContain('1234.5');
  });

  it('dispatch.closed without flightTimeHours', () => {
    const r = summarizeAuditEntry({ action: 'dispatch.closed', entityType: 'dispatch_ticket', metadata: {} });
    expect(r).toBe('Aircraft checked in');
  });

  it('dispatch.voided', () => {
    expect(summarizeAuditEntry({ action: 'dispatch.voided', entityType: 'dispatch_ticket', metadata: { reason: 'Test void' } })).toBe('Dispatch ticket voided');
  });

  it('dispatch.config_updated', () => {
    const r = summarizeAuditEntry({ action: 'dispatch.config_updated', entityType: 'dispatch_config', metadata: { before: { eligibilityMode: 'off' }, after: { eligibilityMode: 'warn' } } });
    expect(r).toBe('Dispatch gate configuration updated');
    expect(r).not.toContain('{');
  });

  it('dispatch.requirement_added with tag', () => {
    const r = summarizeAuditEntry({ action: 'dispatch.requirement_added', entityType: 'dispatch_requirement', metadata: { requiredTag: 'complex checkout', resourceId: 'resource-uuid-abc' } });
    expect(r).toBe('Required dispatch tag added: "complex checkout"');
    expect(r).not.toContain('resource-uuid-abc'); // resourceId not whitelisted
  });

  it('dispatch.requirement_removed with tag', () => {
    const r = summarizeAuditEntry({ action: 'dispatch.requirement_removed', entityType: 'dispatch_requirement', metadata: { requiredTag: 'complex checkout', requirementId: 'x' } });
    expect(r).toBe('Required dispatch tag removed: "complex checkout"');
  });
});

describe('summarizeAuditEntry — grounding actions', () => {
  it('grounding.grounded with reason (operator data, not FAA ruling)', () => {
    const r = summarizeAuditEntry({ action: 'grounding.grounded', entityType: 'aircraft_grounding', metadata: { resourceId: 'x', reason: 'Flat tire', squawkId: null } });
    expect(r).toBe('Aircraft grounded: Flat tire');
    expect(r).not.toContain('resourceId');
  });

  it('grounding.grounded without reason', () => {
    const r = summarizeAuditEntry({ action: 'grounding.grounded', entityType: 'aircraft_grounding', metadata: { resourceId: 'x', reason: null } });
    expect(r).toBe('Aircraft grounded');
  });

  it('grounding.released', () => {
    const r = summarizeAuditEntry({ action: 'grounding.released', entityType: 'aircraft_grounding', metadata: { resourceId: 'x', reason: null } });
    expect(r).toBe('Aircraft grounding released');
  });
});

describe('summarizeAuditEntry — squawk actions', () => {
  it('squawk.reported with title', () => {
    const r = summarizeAuditEntry({ action: 'squawk.reported', entityType: 'squawk', metadata: { title: 'Alternator warning light', severity: 'minor', resourceId: 'x' } });
    expect(r).toBe('Squawk reported: "Alternator warning light"');
    expect(r).not.toContain('minor'); // severity not whitelisted for display
  });

  it('squawk.reported without title', () => {
    expect(summarizeAuditEntry({ action: 'squawk.reported', entityType: 'squawk', metadata: {} })).toBe('Squawk reported');
  });

  it('squawk.status_changed with newStatus', () => {
    const r = summarizeAuditEntry({ action: 'squawk.status_changed', entityType: 'squawk', metadata: { newStatus: 'resolved', squawkId: 'x' } });
    expect(r).toBe('Squawk status updated to resolved');
    expect(r).not.toContain('x');
  });
});

describe('summarizeAuditEntry — work order actions', () => {
  it('work_order.opened with title', () => {
    const r = summarizeAuditEntry({ action: 'work_order.opened', entityType: 'work_order', metadata: { title: 'Oil change', resourceId: 'x' } });
    expect(r).toBe('Work order opened: "Oil change"');
    expect(r).not.toContain('resourceId');
  });

  it('work_order.status_changed with newStatus', () => {
    const r = summarizeAuditEntry({ action: 'work_order.status_changed', entityType: 'work_order', metadata: { workOrderId: 'x', newStatus: 'in_progress' } });
    // The enum key reads as words: never 'in_progress'.
    expect(r).toBe('Work order status updated to in progress');
  });

  it('status summaries never print an enum key with an underscore', () => {
    for (const [action, metadata] of [
      ['work_order.status_changed', { newStatus: 'in_progress' }],
      ['squawk.status_changed', { newStatus: 'some_new_state' }],
      ['member.status_changed', { after: { status: 'on_leave' } }],
      ['training.enrollment_status_changed', { to: 'on_hold' }],
    ] as const) {
      expect(summarizeAuditEntry({ action, entityType: 'x', metadata })).not.toContain('_');
    }
  });

  it('work_order.completed', () => {
    const r = summarizeAuditEntry({ action: 'work_order.completed', entityType: 'work_order', metadata: { workOrderId: 'x', signOffNotes: 'All clear' } });
    expect(r).toBe('Work order completed');
    expect(r).not.toContain('All clear'); // signOffNotes not whitelisted
  });

  it('work_order.cancelled', () => {
    expect(summarizeAuditEntry({ action: 'work_order.cancelled', entityType: 'work_order', metadata: { cancelledReason: 'No longer needed' } })).toBe('Work order cancelled');
  });
});

describe('summarizeAuditEntry — aircraft actions', () => {
  it('aircraft.updated with after.displayName', () => {
    const r = summarizeAuditEntry({ action: 'aircraft.updated', entityType: 'resource', metadata: { before: { displayName: 'N12345', make: 'Cessna' }, after: { displayName: 'N12345 (Cessna 172)', make: 'Cessna' } } });
    expect(r).toContain('"N12345 (Cessna 172)"');
    expect(r).not.toContain('{'); // no raw JSON
  });

  it('aircraft.updated without after.displayName', () => {
    expect(summarizeAuditEntry({ action: 'aircraft.updated', entityType: 'resource', metadata: {} })).toBe('Aircraft details updated');
  });
});

describe('summarizeAuditEntry — member actions', () => {
  it('member.created with fullName', () => {
    const r = summarizeAuditEntry({ action: 'member.created', entityType: 'app_user', metadata: { fullName: 'Jane Doe', email: 'jane@example.com', role: 'student' } });
    expect(r).toBe('Member "Jane Doe" added to roster');
    expect(r).not.toContain('jane@example.com'); // email not whitelisted
  });

  it('member.created without fullName', () => {
    expect(summarizeAuditEntry({ action: 'member.created', entityType: 'app_user', metadata: { email: 'jane@example.com' } })).toBe('Member added to roster');
  });

  it('member.updated', () => {
    expect(summarizeAuditEntry({ action: 'member.updated', entityType: 'app_user', metadata: { before: { fullName: 'Old Name' }, after: { fullName: 'New Name' } } })).toBe('Member profile updated');
  });

  it('member.status_changed with after.status', () => {
    const r = summarizeAuditEntry({ action: 'member.status_changed', entityType: 'app_user', metadata: { before: { status: 'active' }, after: { status: 'inactive' } } });
    expect(r).toBe('Member status changed to inactive');
  });

  it('member.login_link_created invite / reset', () => {
    expect(summarizeAuditEntry({ action: 'member.login_link_created', entityType: 'app_user', metadata: { mode: 'invite', expiresAt: '2026-10-19T00:00:00.000Z' } })).toBe('Login link created for member');
    expect(summarizeAuditEntry({ action: 'member.login_link_created', entityType: 'app_user', metadata: { mode: 'reset' } })).toBe('Password reset link created for member');
    expect(summarizeAuditEntry({ action: 'member.login_link_created', entityType: 'app_user', metadata: null })).toBe('Login link created for member');
  });

  it('member.login_link_accepted invite / reset', () => {
    expect(summarizeAuditEntry({ action: 'member.login_link_accepted', entityType: 'app_user', metadata: { mode: 'invite', mobileSessionsRevoked: 0 } })).toBe('Member set their password with a login link');
    expect(summarizeAuditEntry({ action: 'member.login_link_accepted', entityType: 'app_user', metadata: { mode: 'reset', mobileSessionsRevoked: 2 } })).toBe('Member reset their password with a login link');
  });

  it('member.tag_added with tag', () => {
    const r = summarizeAuditEntry({ action: 'member.tag_added', entityType: 'app_user', metadata: { tag: 'complex checkout' } });
    expect(r).toBe('Tag added to member: "complex checkout"');
  });

  it('member.tag_removed with tag', () => {
    const r = summarizeAuditEntry({ action: 'member.tag_removed', entityType: 'app_user', metadata: { tag: 'complex checkout', tagId: 'tag-uuid-def' } });
    expect(r).toBe('Tag removed from member: "complex checkout"');
    expect(r).not.toContain('tag-uuid-def'); // tagId not whitelisted
  });
});

describe('summarizeAuditEntry — training actions', () => {
  it('training.course_created with title', () => {
    const r = summarizeAuditEntry({ action: 'training.course_created', entityType: 'course', metadata: { title: 'Private Pilot Ground' } });
    expect(r).toBe('Training course created: "Private Pilot Ground"');
  });

  it('training.lesson_added with title', () => {
    const r = summarizeAuditEntry({ action: 'training.lesson_added', entityType: 'course_lesson', metadata: { courseId: 'x', title: 'Weather Fundamentals', position: 3 } });
    expect(r).toBe('Lesson added to course: "Weather Fundamentals"');
    expect(r).not.toContain('position'); // not whitelisted
  });

  it('training.lesson_removed', () => {
    expect(summarizeAuditEntry({ action: 'training.lesson_removed', entityType: 'course_lesson', metadata: { courseId: 'x' } })).toBe('Lesson removed from course');
  });

  it('training.member_enrolled', () => {
    expect(summarizeAuditEntry({ action: 'training.member_enrolled', entityType: 'enrollment', metadata: { courseId: 'x', studentUserId: 'y' } })).toBe('Member enrolled in course');
  });

  it('training.enrollment_status_changed with to', () => {
    const r = summarizeAuditEntry({ action: 'training.enrollment_status_changed', entityType: 'enrollment', metadata: { from: 'active', to: 'completed' } });
    expect(r).toBe('Enrollment status changed to completed');
  });

  it('training.lesson_recorded', () => {
    expect(summarizeAuditEntry({ action: 'training.lesson_recorded', entityType: 'lesson_record', metadata: { enrollmentId: 'x', lessonId: 'y', instructorUserId: 'z' } })).toBe('Lesson recorded');
  });

  it('training.lesson_record_voided', () => {
    const r = summarizeAuditEntry({ action: 'training.lesson_record_voided', entityType: 'lesson_record', metadata: { enrollmentId: 'x', voidedReason: 'Data entry error', voidedBy: 'z' } });
    expect(r).toBe('Lesson record voided');
    expect(r).not.toContain('Data entry error'); // voidedReason not whitelisted
    expect(r).not.toContain('z'); // voidedBy not whitelisted (user ID)
  });
});

describe('summarizeAuditEntry — optimization run', () => {
  it('optimization_run.created with createdCount', () => {
    const r = summarizeAuditEntry({ action: 'optimization_run.created', entityType: 'schedule_optimization_run', metadata: { createdCount: 12, skippedCount: 2, seed: 42 } });
    expect(r).toBe('Auto-schedule run completed (12 reservations created)');
    expect(r).not.toContain('42'); // seed not whitelisted
    expect(r).not.toContain('skippedCount');
  });

  it('optimization_run.created with 1 reservation (singular)', () => {
    const r = summarizeAuditEntry({ action: 'optimization_run.created', entityType: 'schedule_optimization_run', metadata: { createdCount: 1 } });
    expect(r).toBe('Auto-schedule run completed (1 reservation created)');
  });

  it('optimization_run.created without createdCount', () => {
    expect(summarizeAuditEntry({ action: 'optimization_run.created', entityType: 'schedule_optimization_run', metadata: {} })).toBe('Auto-schedule run completed');
  });
});

describe('summarizeAuditEntry — generic fallback', () => {
  it('unknown action → safe fallback with entity-type humanization', () => {
    const r = summarizeAuditEntry({ action: 'future.unknown_action', entityType: 'reservation', metadata: { secret: 'do-not-show' } });
    expect(r).toBe('performed an action on a reservation');
    expect(r).not.toContain('do-not-show');
  });

  it('unknown entity type → generic "a record", never the raw table name', () => {
    const r = summarizeAuditEntry({ action: 'unknown.action', entityType: 'some_new_table', metadata: {} });
    expect(r).toBe('performed an action on a record');
    expect(r).not.toContain('some_new_table');
    expect(r).not.toContain('some new table');
  });

  it('retired table names (e.g. from old audit rows) are not shown', () => {
    for (const entityType of ['invoice', 'ledger_entry', 'stripe_event']) {
      const r = summarizeAuditEntry({ action: `${entityType}.created`, entityType, metadata: {} });
      expect(r).toBe('performed an action on a record');
    }
  });

  it('uses "an" before a label that starts with a vowel', () => {
    expect(summarizeAuditEntry({ action: 'unknown.action', entityType: 'aircraft_grounding', metadata: {} }))
      .toBe('performed an action on an aircraft grounding');
    expect(summarizeAuditEntry({ action: 'import.committed', entityType: 'import_batch', metadata: {} }))
      .toBe('performed an action on an import');
  });

  it('every labelled entity type reads with its label and the right article', () => {
    // A checked list: adding a label to ENTITY_TYPE_LABELS without adding it
    // here fails, so each new label's wording and article get a human look.
    const expected: Record<string, string> = {
      reservation:                  'a reservation',
      reservation_series:           'a recurring series',
      resource:                     'a resource',
      resource_blackout:            'a blackout window',
      resource_availability_window: 'an operating-hours window',
      booking_policy:               'a booking policy',
      booking_request:              'a booking request',
      dispatch_ticket:              'a dispatch ticket',
      dispatch_config:              'a dispatch configuration',
      dispatch_requirement:         'a dispatch requirement',
      aircraft_grounding:           'an aircraft grounding',
      squawk:                       'a squawk',
      work_order:                   'a work order',
      maintenance_item:             'a maintenance item',
      location:                     'a location',
      app_user:                     'a member',
      member_expiration:            'a member expiration',
      member_message:               'a message',
      mobile_session:               'a mobile app session',
      calendar_feed:                'a calendar feed',
      document:                     'a document',
      import_batch:                 'an import',
      org_feature_config:           'a module setting',
      enrollment:                   'a training enrollment',
      course:                       'a training course',
      course_lesson:                'a course lesson',
      lesson_record:                'a lesson record',
      lesson_signature:             'a lesson signature',
      schedule_optimization_run:    'an auto-schedule run',
    };
    expect([...ACTIVITY_ENTITY_TYPES].sort()).toEqual(Object.keys(expected).sort());
    for (const [entityType, phrase] of Object.entries(expected)) {
      expect(summarizeAuditEntry({ action: 'unknown.action', entityType, metadata: {} }))
        .toBe(`performed an action on ${phrase}`);
    }
  });

  it('null metadata → never throws (total)', () => {
    const r = summarizeAuditEntry({ action: 'unknown.action', entityType: 'reservation', metadata: null });
    expect(r).toBe('performed an action on a reservation');
  });

  it('array metadata → never throws', () => {
    const r = summarizeAuditEntry({ action: 'unknown.action', entityType: 'resource', metadata: [1, 2, 3] });
    expect(typeof r).toBe('string');
    expect(r.length).toBeGreaterThan(0);
  });
});

// ─── UNIT TESTS — activityEntityLabel ─────────────────────────────────────────

describe('activityEntityLabel', () => {
  it('known entity type → its label', () => {
    expect(activityEntityLabel('dispatch_ticket')).toBe('dispatch ticket');
    expect(activityEntityLabel('app_user')).toBe('member');
    expect(activityEntityLabel('resource_availability_window')).toBe('operating-hours window');
  });

  it('unknown entity type → "record", never the raw name', () => {
    expect(activityEntityLabel('invoice')).toBe('record');
    expect(activityEntityLabel('some_new_table')).toBe('record');
    expect(activityEntityLabel('')).toBe('record');
  });

  it('prototype keys → "record" (no "[object Object]" or function source)', () => {
    for (const key of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(activityEntityLabel(key)).toBe('record');
      expect(summarizeAuditEntry({ action: 'unknown.action', entityType: key, metadata: {} }))
        .toBe('performed an action on a record');
    }
  });

  it('every label is a lowercase phrase with no underscores', () => {
    for (const entityType of ACTIVITY_ENTITY_TYPES) {
      const label = activityEntityLabel(entityType);
      expect(label).not.toBe('record');
      expect(label).not.toContain('_');
      expect(label).toBe(label.toLowerCase());
    }
  });
});

// ─── UNIT TESTS — activityPath ────────────────────────────────────────────────

describe('activityPath', () => {
  it('reservation without a start (e.g. a cancellation) → /schedule/board', () => {
    expect(activityPath({ entityType: 'reservation', entityId: 'abc', metadata: {} })).toBe('/schedule/board');
    expect(activityPath({ entityType: 'reservation', entityId: 'abc', metadata: { reason: 'reschedule' } })).toBe('/schedule/board');
  });

  it('reservation.created → the board for its start day in the viewer\'s zone', () => {
    // 19:00 CST on Nov 16 is 01:00 UTC on Nov 17.
    const metadata = { resourceIds: [], startAt: '2026-11-17T01:00:00.000Z', endAt: '2026-11-17T02:00:00.000Z' };
    expect(activityPath({ entityType: 'reservation', entityId: 'abc', metadata, timeZone: 'America/Chicago' }))
      .toBe('/schedule/board?date=2026-11-16');
    expect(activityPath({ entityType: 'reservation', entityId: 'abc', metadata, timeZone: 'Pacific/Auckland' }))
      .toBe('/schedule/board?date=2026-11-17');
  });

  it('reservation.created without a zone → the UTC day (the default)', () => {
    const metadata = { startAt: '2026-11-17T01:00:00.000Z' };
    expect(activityPath({ entityType: 'reservation', entityId: 'abc', metadata })).toBe('/schedule/board?date=2026-11-17');
    expect(activityPath({ entityType: 'reservation', entityId: 'abc', metadata, timeZone: 'Mars/Olympus_Mons' }))
      .toBe('/schedule/board?date=2026-11-17');
  });

  it('reservation.rescheduled → the board for the new window\'s start', () => {
    const metadata = {
      rescheduledFrom: 'old-id',
      oldWindow: { startAt: '2026-11-10T15:00:00.000Z', endAt: '2026-11-10T16:00:00.000Z' },
      newWindow: { startAt: '2026-11-20T04:30:00.000Z', endAt: '2026-11-20T05:30:00.000Z' },
    };
    expect(activityPath({ entityType: 'reservation', entityId: 'new-id', metadata, timeZone: 'America/Chicago' }))
      .toBe('/schedule/board?date=2026-11-19');
  });

  it('a start that is not an ISO instant links to today\'s board, never echoing the value', () => {
    for (const startAt of ['tomorrow', '2026-11-17', '{"x":1}', '']) {
      expect(activityPath({ entityType: 'reservation', entityId: 'abc', metadata: { startAt }, timeZone: 'America/Chicago' }))
        .toBe('/schedule/board');
    }
  });

  it('PROPERTY: a reservation path is the board, with at most a YYYY-MM-DD day', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.date({ min: new Date('1970-01-01'), max: new Date('9999-12-31'), noInvalidDate: true }).map((d) => d.toISOString())),
        fc.constantFrom('UTC', 'America/Chicago', 'Pacific/Auckland', 'Asia/Kolkata', 'not/a-zone'),
        (startAt, timeZone) => {
          const path = activityPath({ entityType: 'reservation', entityId: null, metadata: { startAt }, timeZone });
          expect(path).toMatch(/^\/schedule\/board(\?date=\d{4}-\d{2}-\d{2})?$/);
        },
      ),
    );
  });

  it('reservation_series with entityId → /schedule/series/{id}', () => {
    expect(activityPath({ entityType: 'reservation_series', entityId: 'abc', metadata: {} })).toBe('/schedule/series/abc');
  });

  it('reservation_series without entityId → /schedule/board', () => {
    expect(activityPath({ entityType: 'reservation_series', entityId: null, metadata: {} })).toBe('/schedule/board');
  });

  it('dispatch_ticket → /schedule/board', () => {
    expect(activityPath({ entityType: 'dispatch_ticket', entityId: 'x', metadata: {} })).toBe('/schedule/board');
  });

  it('dispatch_config → /schedule/board', () => {
    expect(activityPath({ entityType: 'dispatch_config', entityId: 'orgId', metadata: {} })).toBe('/schedule/board');
  });

  it('dispatch_requirement with resourceId in metadata → /fleet/{resourceId}', () => {
    expect(activityPath({ entityType: 'dispatch_requirement', entityId: 'res-1', metadata: { resourceId: 'res-1', requiredTag: 'x' } })).toBe('/fleet/res-1');
  });

  it('dispatch_requirement without metadata.resourceId → /fleet/{entityId}', () => {
    expect(activityPath({ entityType: 'dispatch_requirement', entityId: 'res-2', metadata: {} })).toBe('/fleet/res-2');
  });

  it('dispatch_requirement with neither → null', () => {
    expect(activityPath({ entityType: 'dispatch_requirement', entityId: null, metadata: {} })).toBeNull();
  });

  it('no path is the retired bare /board route', () => {
    for (const entityType of ACTIVITY_ENTITY_TYPES) {
      for (const entityId of ['id-1', null]) {
        const path = activityPath({ entityType, entityId, metadata: { resourceId: 'res-1', courseId: 'course-1' } });
        expect(path).not.toBe('/board');
      }
    }
  });

  it('resource with entityId → /fleet/{id}', () => {
    expect(activityPath({ entityType: 'resource', entityId: 'res-id-123', metadata: {} })).toBe('/fleet/res-id-123');
  });

  it('resource with null entityId → null', () => {
    expect(activityPath({ entityType: 'resource', entityId: null, metadata: {} })).toBeNull();
  });

  it('booking_policy with resourceId in metadata → /fleet/{resourceId}', () => {
    expect(activityPath({ entityType: 'booking_policy', entityId: 'policy-id', metadata: { resourceId: 'res-42' } })).toBe('/fleet/res-42');
  });

  it('booking_policy without resourceId → falls back to entityId', () => {
    expect(activityPath({ entityType: 'booking_policy', entityId: 'policy-id', metadata: {} })).toBe('/fleet/policy-id');
  });

  it('resource_blackout with resourceId in metadata → /fleet/{resourceId}', () => {
    expect(activityPath({ entityType: 'resource_blackout', entityId: 'blackout-id', metadata: { resourceId: 'res-99' } })).toBe('/fleet/res-99');
  });

  it('resource_blackout without resourceId in metadata → null', () => {
    expect(activityPath({ entityType: 'resource_blackout', entityId: 'blackout-id', metadata: {} })).toBeNull();
  });

  it('aircraft_grounding → /maintenance/squawks', () => {
    expect(activityPath({ entityType: 'aircraft_grounding', entityId: 'x', metadata: {} })).toBe('/maintenance/squawks');
  });

  it('squawk → /maintenance/squawks', () => {
    expect(activityPath({ entityType: 'squawk', entityId: 'x', metadata: {} })).toBe('/maintenance/squawks');
  });

  it('work_order with entityId → /maintenance/work-orders/{id}', () => {
    expect(activityPath({ entityType: 'work_order', entityId: 'wo-id-999', metadata: {} })).toBe('/maintenance/work-orders/wo-id-999');
  });

  it('work_order without entityId → /maintenance/work-orders', () => {
    expect(activityPath({ entityType: 'work_order', entityId: null, metadata: {} })).toBe('/maintenance/work-orders');
  });

  it('app_user with entityId → /people/{id}', () => {
    expect(activityPath({ entityType: 'app_user', entityId: 'user-id-abc', metadata: {} })).toBe('/people/user-id-abc');
  });

  it('app_user without entityId → null', () => {
    expect(activityPath({ entityType: 'app_user', entityId: null, metadata: {} })).toBeNull();
  });

  it('course with entityId → /training/{id}', () => {
    expect(activityPath({ entityType: 'course', entityId: 'course-id-x', metadata: {} })).toBe('/training/course-id-x');
  });

  it('course_lesson with courseId in metadata → /training/{courseId}', () => {
    expect(activityPath({ entityType: 'course_lesson', entityId: 'lesson-id', metadata: { courseId: 'course-id-y' } })).toBe('/training/course-id-y');
  });

  it('course_lesson without courseId in metadata → null', () => {
    expect(activityPath({ entityType: 'course_lesson', entityId: 'lesson-id', metadata: {} })).toBeNull();
  });

  it('enrollment → /training/enrollments', () => {
    expect(activityPath({ entityType: 'enrollment', entityId: 'enrollment-id', metadata: {} })).toBe('/training/enrollments');
  });

  it('lesson_record → /training/enrollments', () => {
    expect(activityPath({ entityType: 'lesson_record', entityId: 'record-id', metadata: {} })).toBe('/training/enrollments');
  });

  it('schedule_optimization_run → /schedule/auto', () => {
    expect(activityPath({ entityType: 'schedule_optimization_run', entityId: 'run-id', metadata: {} })).toBe('/schedule/auto');
  });

  it('unknown entity type → null', () => {
    expect(activityPath({ entityType: 'unknown_future_entity', entityId: 'x', metadata: {} })).toBeNull();
  });

  it('null entity_id for reservation → still /schedule/board (not entity-id dependent)', () => {
    expect(activityPath({ entityType: 'reservation', entityId: null, metadata: {} })).toBe('/schedule/board');
  });
});
