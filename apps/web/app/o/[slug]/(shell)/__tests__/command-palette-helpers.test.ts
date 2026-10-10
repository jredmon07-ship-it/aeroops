/**
 * command-palette-helpers.test.ts — Pure unit tests for Slice S1.2 palette helpers.
 *
 * These are PURE helpers with zero DOM, React, Next.js or DB imports.
 * They are co-located with the command palette source under (shell)/__tests__/.
 *
 * COVERAGE:
 *
 *   1. shouldSearch — client min-length gate
 *      - query.trim().length < 2 → false (no server call)
 *      - query.trim().length >= 2 → true
 *      - whitespace-only queries → false
 *      - single character queries → false
 *      - exactly 2 character queries → true
 *
 *   2. buildHref — path interpolation (/o/{slug}{path})
 *      - fleet path
 *      - people path
 *      - maintenance paths
 *      - training path
 *      - schedule/board path (squawk + reservation links)
 *      - slug with hyphens
 *      - empty secondary path segment
 *
 *   3. flattenGroups — group-to-flat-list transformation
 *      - empty groups → []
 *      - single group, single result → 1 flat item
 *      - multiple groups → items in group order
 *      - option ids are unique
 *      - accessible labels are built correctly (with / without secondary)
 *      - href uses buildHref (slug prepended)
 *
 *   4. clampIndex — roving-highlight index math
 *      - empty list → -1
 *      - index < 0 → clamps to 0
 *      - index >= length → clamps to length - 1
 *      - index within range → unchanged
 *      - single item: 0 stays 0, -1 → 0, 1 → 0
 *
 *   Helpers live in command-palette-helpers.ts and are imported directly —
 *   no inline copies, no drift risk.
 */

import { describe, it, expect } from 'vitest';
import type { SearchGroup } from '@aeroops/api';
import {
  shouldSearch,
  buildHref,
  flattenGroups,
  clampIndex,
} from '../command-palette-helpers';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const makeAircraftGroup = (count = 2): SearchGroup => ({
  type: 'aircraft',
  label: 'Aircraft',
  results: Array.from({ length: count }, (_, i) => ({
    id: `aircraft-${i}`,
    primary: `N123${i}`,
    secondary: i === 0 ? 'Cessna 172' : null,
    path: `/fleet/aircraft-${i}`,
  })),
});

const makeMemberGroup = (count = 1): SearchGroup => ({
  type: 'member',
  label: 'Members',
  results: Array.from({ length: count }, (_, i) => ({
    id: `member-${i}`,
    primary: 'Jane Doe',
    secondary: 'jane@example.com',
    path: `/people/member-${i}`,
  })),
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. shouldSearch — client min-length gate
// ═════════════════════════════════════════════════════════════════════════════

describe('1. shouldSearch — client min-length gate', () => {
  it('empty string → false (no call)', () => {
    expect(shouldSearch('')).toBe(false);
  });

  it('single character → false', () => {
    expect(shouldSearch('a')).toBe(false);
    expect(shouldSearch('N')).toBe(false);
    expect(shouldSearch('1')).toBe(false);
  });

  it('exactly 2 characters → true', () => {
    expect(shouldSearch('ab')).toBe(true);
    expect(shouldSearch('N1')).toBe(true);
  });

  it('more than 2 characters → true', () => {
    expect(shouldSearch('abc')).toBe(true);
    expect(shouldSearch('N1234A')).toBe(true);
    expect(shouldSearch('cessna 172')).toBe(true);
  });

  it('whitespace-only → false (trim rule)', () => {
    expect(shouldSearch(' ')).toBe(false);
    expect(shouldSearch('  ')).toBe(false);
    expect(shouldSearch('\t')).toBe(false);
    expect(shouldSearch('\n\n')).toBe(false);
  });

  it('leading/trailing whitespace does not inflate length', () => {
    // " a" has length 2 but trim → "a" (length 1) → false
    expect(shouldSearch(' a')).toBe(false);
    expect(shouldSearch('a ')).toBe(false);
    // " ab" → trim → "ab" (length 2) → true
    expect(shouldSearch(' ab')).toBe(true);
  });

  it('SQL injection string (long) → true (length >= 2)', () => {
    expect(shouldSearch("'; DROP TABLE reservation; --")).toBe(true);
  });

  it('literal percent/underscore → true (length >= 2)', () => {
    expect(shouldSearch('%%')).toBe(true);
    expect(shouldSearch('__')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. buildHref — path interpolation
// ═════════════════════════════════════════════════════════════════════════════

describe('2. buildHref — /o/{slug}{path} interpolation', () => {
  it('fleet path', () => {
    expect(buildHref('acme', '/fleet/abc-123')).toBe('/o/acme/fleet/abc-123');
  });

  it('people path', () => {
    expect(buildHref('sky-club', '/people/user-456')).toBe('/o/sky-club/people/user-456');
  });

  it('maintenance work-order path', () => {
    expect(buildHref('acme', '/maintenance/work-orders/wo-789')).toBe(
      '/o/acme/maintenance/work-orders/wo-789',
    );
  });

  it('maintenance squawks path (list — no id)', () => {
    expect(buildHref('acme', '/maintenance/squawks')).toBe('/o/acme/maintenance/squawks');
  });

  it('training path', () => {
    expect(buildHref('fly-school', '/training/course-999')).toBe(
      '/o/fly-school/training/course-999',
    );
  });

  it('schedule board path (reservations)', () => {
    expect(buildHref('acme', '/schedule/board')).toBe('/o/acme/schedule/board');
  });

  it('slug with hyphens is preserved', () => {
    expect(buildHref('alpha-flight-school', '/fleet/x')).toBe(
      '/o/alpha-flight-school/fleet/x',
    );
  });

  it('always prefixes /o/{slug} — never bare path', () => {
    const href = buildHref('acme', '/fleet/abc');
    expect(href.startsWith('/o/acme')).toBe(true);
    expect(href).not.toBe('/fleet/abc');
  });

  it('different slugs produce different hrefs for the same path', () => {
    const a = buildHref('org-a', '/fleet/x');
    const b = buildHref('org-b', '/fleet/x');
    expect(a).not.toBe(b);
    expect(a).toBe('/o/org-a/fleet/x');
    expect(b).toBe('/o/org-b/fleet/x');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. flattenGroups — group-to-flat-list transformation
// ═════════════════════════════════════════════════════════════════════════════

describe('3. flattenGroups — group flattening + keyboard nav structure', () => {
  it('empty groups → []', () => {
    expect(flattenGroups([], 'acme')).toEqual([]);
  });

  it('single group, single result → 1 flat item', () => {
    const groups: SearchGroup[] = [
      {
        type: 'aircraft',
        label: 'Aircraft',
        results: [{ id: 'a1', primary: 'N1234A', secondary: 'Cessna 172', path: '/fleet/a1' }],
      },
    ];
    const flat = flattenGroups(groups, 'acme');
    expect(flat).toHaveLength(1);
    expect(flat[0]!.result.id).toBe('a1');
    expect(flat[0]!.groupType).toBe('aircraft');
    expect(flat[0]!.groupLabel).toBe('Aircraft');
    expect(flat[0]!.href).toBe('/o/acme/fleet/a1');
  });

  it('multiple groups → items interleaved in group order', () => {
    const groups: SearchGroup[] = [makeAircraftGroup(2), makeMemberGroup(1)];
    const flat = flattenGroups(groups, 'acme');
    // 2 aircraft + 1 member = 3 total
    expect(flat).toHaveLength(3);
    expect(flat[0]!.groupType).toBe('aircraft');
    expect(flat[1]!.groupType).toBe('aircraft');
    expect(flat[2]!.groupType).toBe('member');
  });

  it('option ids are unique across all groups', () => {
    const groups: SearchGroup[] = [makeAircraftGroup(5), makeMemberGroup(3)];
    const flat = flattenGroups(groups, 'acme');
    const ids = flat.map((f) => f.optionId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('option id format: palette-option-{type}-{index}', () => {
    const groups: SearchGroup[] = [makeAircraftGroup(2)];
    const flat = flattenGroups(groups, 'acme');
    expect(flat[0]!.optionId).toBe('palette-option-aircraft-0');
    expect(flat[1]!.optionId).toBe('palette-option-aircraft-1');
  });

  it('accessible label includes group label + primary (no secondary)', () => {
    const groups: SearchGroup[] = [
      {
        type: 'member',
        label: 'Members',
        results: [{ id: 'm1', primary: 'Jane Doe', secondary: null, path: '/people/m1' }],
      },
    ];
    const flat = flattenGroups(groups, 'acme');
    expect(flat[0]!.accessibleLabel).toBe('Members: Jane Doe');
  });

  it('accessible label includes secondary when present', () => {
    const groups: SearchGroup[] = [
      {
        type: 'aircraft',
        label: 'Aircraft',
        results: [{ id: 'a1', primary: 'N1234A', secondary: 'Cessna 172', path: '/fleet/a1' }],
      },
    ];
    const flat = flattenGroups(groups, 'acme');
    expect(flat[0]!.accessibleLabel).toBe('Aircraft: N1234A — Cessna 172');
  });

  it('href uses buildHref (slug prepended to server path)', () => {
    const groups: SearchGroup[] = [
      {
        type: 'aircraft',
        label: 'Aircraft',
        results: [{ id: 'a1', primary: 'N1234A', secondary: null, path: '/fleet/a1' }],
      },
    ];
    const flat = flattenGroups(groups, 'test-slug');
    expect(flat[0]!.href).toBe('/o/test-slug/fleet/a1');
  });

  it('squawk path (no id) is preserved correctly', () => {
    const groups: SearchGroup[] = [
      {
        type: 'squawk',
        label: 'Squawks',
        results: [
          { id: 'sq1', primary: 'Oil leak on #3', secondary: 'critical · open', path: '/maintenance/squawks' },
        ],
      },
    ];
    const flat = flattenGroups(groups, 'acme');
    expect(flat[0]!.href).toBe('/o/acme/maintenance/squawks');
  });

  it('reservation path (board) is correct', () => {
    const groups: SearchGroup[] = [
      {
        type: 'reservation',
        label: 'Reservations',
        results: [
          { id: 'r1', primary: '2027-01-10 08:00 UTC', secondary: 'solo training', path: '/schedule/board' },
        ],
      },
    ];
    const flat = flattenGroups(groups, 'acme');
    expect(flat[0]!.href).toBe('/o/acme/schedule/board');
  });

  it('preserves group order from input (not alphabetical)', () => {
    // server always returns fixed order; flattenGroups must preserve it
    const groups: SearchGroup[] = [
      { type: 'squawk', label: 'Squawks', results: [{ id: 's1', primary: 'S', secondary: null, path: '/maintenance/squawks' }] },
      { type: 'aircraft', label: 'Aircraft', results: [{ id: 'a1', primary: 'A', secondary: null, path: '/fleet/a1' }] },
    ];
    const flat = flattenGroups(groups, 'acme');
    expect(flat[0]!.groupType).toBe('squawk');
    expect(flat[1]!.groupType).toBe('aircraft');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. clampIndex — roving highlight math
// ═════════════════════════════════════════════════════════════════════════════

describe('4. clampIndex — roving highlight math', () => {
  it('empty list (length=0) always returns -1', () => {
    expect(clampIndex(0, 0)).toBe(-1);
    expect(clampIndex(-1, 0)).toBe(-1);
    expect(clampIndex(5, 0)).toBe(-1);
    expect(clampIndex(Number.MAX_SAFE_INTEGER, 0)).toBe(-1);
  });

  it('single item (length=1)', () => {
    // moving down from -1 → 0
    expect(clampIndex(0, 1)).toBe(0);
    // below 0 clamps to 0 (no wrapping)
    expect(clampIndex(-1, 1)).toBe(0);
    // above 0 clamps to 0 (no wrapping past last)
    expect(clampIndex(1, 1)).toBe(0);
    expect(clampIndex(99, 1)).toBe(0);
  });

  it('index within range is returned unchanged', () => {
    expect(clampIndex(0, 5)).toBe(0);
    expect(clampIndex(2, 5)).toBe(2);
    expect(clampIndex(4, 5)).toBe(4);
  });

  it('index < 0 clamps to 0', () => {
    expect(clampIndex(-1, 5)).toBe(0);
    expect(clampIndex(-99, 5)).toBe(0);
  });

  it('index >= length clamps to length-1', () => {
    expect(clampIndex(5, 5)).toBe(4);
    expect(clampIndex(10, 5)).toBe(4);
    expect(clampIndex(100, 5)).toBe(4);
  });

  it('↓ sequence from -1 down the list: -1 → 0 → 1 → 2 → ... → N-1 (clamps)', () => {
    const N = 4;
    let idx = -1;
    // first ↓ from -1
    idx = clampIndex(idx + 1, N);
    expect(idx).toBe(0);
    idx = clampIndex(idx + 1, N);
    expect(idx).toBe(1);
    idx = clampIndex(idx + 1, N);
    expect(idx).toBe(2);
    idx = clampIndex(idx + 1, N);
    expect(idx).toBe(3);
    // pressing ↓ one more at the last item → stays at N-1
    idx = clampIndex(idx + 1, N);
    expect(idx).toBe(3);
  });

  it('↑ sequence: pressing ↑ at first item stays at 0 (clamped, no wrap)', () => {
    let idx = 0;
    idx = clampIndex(idx - 1, 4);
    expect(idx).toBe(0);
  });

  it('round-trip ↓↑ returns to original index', () => {
    let idx = 2;
    idx = clampIndex(idx + 1, 5); // 3
    idx = clampIndex(idx - 1, 5); // 2
    expect(idx).toBe(2);
  });
});
