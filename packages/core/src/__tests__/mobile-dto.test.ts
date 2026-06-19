/**
 * mobile-dto.test.ts — Unit tests for Slice 4M.2 mobile DTOs and mappers.
 *
 * CI-VERIFIABLE: all tests are pure — no DB, no I/O.
 *
 * COVERAGE:
 *   1. toMobileReservationDTO — Date→ISO correctly; org_id ABSENT from output.
 *   2. toMobileResourceDTO — maps id/kind/displayName/tailNumber; org_id absent.
 *   3. mobileScheduleWindowSchema — accepts a valid ≤31-day window; rejects
 *      a >31-day window; rejects malformed ISO strings; rejects to <= from.
 */

import { describe, it, expect } from 'vitest';
import {
  toMobileReservationDTO,
  toMobileResourceDTO,
  mobileScheduleWindowSchema,
} from '../mobile/dto.js';

// ─── 1. toMobileReservationDTO ─────────────────────────────────────────────────

describe('1. toMobileReservationDTO', () => {
  const startAt = new Date('2026-06-19T10:00:00.000Z');
  const endAt   = new Date('2026-06-19T11:00:00.000Z');

  const row = {
    id: 'res-uuid-001',
    orgId: 'org-uuid-should-not-appear',
    startAt,
    endAt,
    status: 'booked' as const,
    notes: 'Solo cross-country',
    resourceIds: ['rsc-001', 'rsc-002'],
    seriesId: null,
  };

  it('1a. startAt is serialized to ISO string', () => {
    const dto = toMobileReservationDTO(row);
    expect(dto.startAt).toBe('2026-06-19T10:00:00.000Z');
  });

  it('1b. endAt is serialized to ISO string', () => {
    const dto = toMobileReservationDTO(row);
    expect(dto.endAt).toBe('2026-06-19T11:00:00.000Z');
  });

  it('1c. identity fields are preserved', () => {
    const dto = toMobileReservationDTO(row);
    expect(dto.id).toBe('res-uuid-001');
    expect(dto.status).toBe('booked');
    expect(dto.notes).toBe('Solo cross-country');
    expect(dto.resourceIds).toEqual(['rsc-001', 'rsc-002']);
    expect(dto.seriesId).toBeNull();
  });

  it('1d. orgId is ABSENT from the DTO', () => {
    const dto = toMobileReservationDTO(row);
    // The DTO must not carry orgId — assert the key is absent entirely.
    expect('orgId' in dto).toBe(false);
  });

  it('1e. "cancelled" status is preserved', () => {
    const cancelledRow = { ...row, status: 'cancelled' as const };
    const dto = toMobileReservationDTO(cancelledRow);
    expect(dto.status).toBe('cancelled');
  });

  it('1f. seriesId is included when non-null', () => {
    const recurringRow = { ...row, seriesId: 'series-uuid-999' };
    const dto = toMobileReservationDTO(recurringRow);
    expect(dto.seriesId).toBe('series-uuid-999');
  });

  it('1g. notes can be null', () => {
    const noNotesRow = { ...row, notes: null };
    const dto = toMobileReservationDTO(noNotesRow);
    expect(dto.notes).toBeNull();
  });

  it('1h. empty resourceIds array is preserved', () => {
    const noResourcesRow = { ...row, resourceIds: [] };
    const dto = toMobileReservationDTO(noResourcesRow);
    expect(dto.resourceIds).toEqual([]);
  });

  it('1i. Date objects are converted via .toISOString() — not locale-string', () => {
    // Verify the ISO string matches the UTC representation, not a local date.
    const dto = toMobileReservationDTO(row);
    // A locale string would not end in 'Z'; an ISO string from toISOString() does.
    expect(dto.startAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(dto.endAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

// ─── 2. toMobileResourceDTO ────────────────────────────────────────────────────

describe('2. toMobileResourceDTO', () => {
  it('2a. maps id/kind/displayName/tailNumber for an aircraft', () => {
    const row = {
      id: 'rsc-001',
      kind: 'aircraft',
      displayName: 'Cessna 172 (N12345)',
      tailNumber: 'N12345',
    };
    const dto = toMobileResourceDTO(row);
    expect(dto.id).toBe('rsc-001');
    expect(dto.kind).toBe('aircraft');
    expect(dto.displayName).toBe('Cessna 172 (N12345)');
    expect(dto.tailNumber).toBe('N12345');
  });

  it('2b. tailNumber is null for non-aircraft resources', () => {
    const row = {
      id: 'rsc-002',
      kind: 'instructor',
      displayName: 'CFI Smith',
      tailNumber: null,
    };
    const dto = toMobileResourceDTO(row);
    expect(dto.tailNumber).toBeNull();
    expect(dto.kind).toBe('instructor');
  });

  it('2c. orgId is ABSENT from the DTO', () => {
    const row = {
      id: 'rsc-003',
      kind: 'sim',
      displayName: 'Redbird Sim A',
      tailNumber: null,
    };
    const dto = toMobileResourceDTO(row);
    // ResourceRow has no orgId field; confirm the DTO also lacks it.
    expect('orgId' in dto).toBe(false);
  });
});

// ─── 3. mobileScheduleWindowSchema ────────────────────────────────────────────

describe('3. mobileScheduleWindowSchema', () => {
  it('3a. accepts a valid 1-day window', () => {
    const result = mobileScheduleWindowSchema.safeParse({
      from: '2026-06-19T00:00:00.000Z',
      to:   '2026-06-20T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('3b. accepts a valid 31-day window (boundary)', () => {
    const from = new Date('2026-06-01T00:00:00.000Z');
    const to   = new Date(from.getTime() + 31 * 24 * 60 * 60 * 1000);
    const result = mobileScheduleWindowSchema.safeParse({
      from: from.toISOString(),
      to:   to.toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('3c. rejects a >31-day window', () => {
    const from = new Date('2026-06-01T00:00:00.000Z');
    const to   = new Date(from.getTime() + 32 * 24 * 60 * 60 * 1000); // 32 days
    const result = mobileScheduleWindowSchema.safeParse({
      from: from.toISOString(),
      to:   to.toISOString(),
    });
    expect(result.success).toBe(false);
  });

  it('3d. rejects a malformed "from" string', () => {
    const result = mobileScheduleWindowSchema.safeParse({
      from: 'not-a-date',
      to:   '2026-06-20T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('3e. rejects a malformed "to" string', () => {
    const result = mobileScheduleWindowSchema.safeParse({
      from: '2026-06-19T00:00:00.000Z',
      to:   'INVALID',
    });
    expect(result.success).toBe(false);
  });

  it('3f. rejects to === from (zero-length window)', () => {
    const ts = '2026-06-19T00:00:00.000Z';
    const result = mobileScheduleWindowSchema.safeParse({ from: ts, to: ts });
    expect(result.success).toBe(false);
  });

  it('3g. rejects to < from (reversed window)', () => {
    const result = mobileScheduleWindowSchema.safeParse({
      from: '2026-06-20T00:00:00.000Z',
      to:   '2026-06-19T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('3h. rejects missing "from"', () => {
    const result = mobileScheduleWindowSchema.safeParse({
      to: '2026-06-20T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('3i. rejects missing "to"', () => {
    const result = mobileScheduleWindowSchema.safeParse({
      from: '2026-06-19T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });

  it('3j. parsed from/to values are the original ISO strings', () => {
    const from = '2026-06-19T08:00:00.000Z';
    const to   = '2026-06-20T08:00:00.000Z';
    const result = mobileScheduleWindowSchema.safeParse({ from, to });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.from).toBe(from);
      expect(result.data.to).toBe(to);
    }
  });
});
