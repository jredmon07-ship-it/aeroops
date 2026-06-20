/**
 * alerts-bell-helpers.test.ts — Pure unit tests for Slice N1.2 alerts bell helpers.
 *
 * These are PURE helpers with zero DOM, React, Next.js, localStorage, or DB imports.
 * Co-located with the other (shell) pure helper tests.
 *
 * COVERAGE:
 *
 *   1. seenSetKey — localStorage key construction
 *      - format: aeroops:alerts-seen:{orgId}:{userId}
 *      - different org/user combos produce distinct keys
 *
 *   2. readSeenIds — parse raw localStorage string to Set<string>
 *      - null input → empty set
 *      - empty string → empty set
 *      - valid JSON array of strings → Set
 *      - invalid JSON → empty set (graceful)
 *      - JSON array with non-string members → strings only
 *
 *   3. serializeSeenIds — serialize Set to JSON string
 *      - empty set → "[]"
 *      - round-trip: serialize → readSeenIds recovers the original set
 *
 *   4. pruneSeenIds — remove ids no longer in the current alert list
 *      - empty seen + any current → empty result
 *      - seen only contains IDs not in current → all pruned
 *      - intersection preserved, stale dropped
 *      - does not mutate input (returns NEW Set)
 *
 *   5. computeUnreadCount — count alerts not in the seen set
 *      - empty alerts → 0
 *      - all seen → 0
 *      - none seen → count = alertIds.length
 *      - partial seen → count = unseen count
 *
 *   6. badgeLabel — "9+" clamp
 *      - 0 → "0"
 *      - 1 → "1"
 *      - 9 → "9"
 *      - 10 → "9+"
 *      - 100 → "9+"
 *
 *   7. buildAlertHref — slug-prepend
 *      - null path → null
 *      - schedule path → /o/{slug}{path}
 *      - fleet path → /o/{slug}{path}
 *      - different slugs → different hrefs
 */

import { describe, it, expect } from 'vitest';
import {
  seenSetKey,
  readSeenIds,
  serializeSeenIds,
  pruneSeenIds,
  computeUnreadCount,
  badgeLabel,
  buildAlertHref,
} from '../alerts-bell-helpers';

// ═════════════════════════════════════════════════════════════════════════════
// 1. seenSetKey — localStorage key construction
// ═════════════════════════════════════════════════════════════════════════════

describe('1. seenSetKey — localStorage key construction', () => {
  it('format: aeroops:alerts-seen:{orgId}:{userId}', () => {
    expect(seenSetKey('org-abc', 'user-123')).toBe('aeroops:alerts-seen:org-abc:user-123');
  });

  it('different orgs produce distinct keys for the same user', () => {
    const a = seenSetKey('org-a', 'user-1');
    const b = seenSetKey('org-b', 'user-1');
    expect(a).not.toBe(b);
  });

  it('different users produce distinct keys for the same org', () => {
    const a = seenSetKey('org-x', 'user-1');
    const b = seenSetKey('org-x', 'user-2');
    expect(a).not.toBe(b);
  });

  it('different org+user combos all produce distinct keys', () => {
    const keys = [
      seenSetKey('org-a', 'user-1'),
      seenSetKey('org-a', 'user-2'),
      seenSetKey('org-b', 'user-1'),
      seenSetKey('org-b', 'user-2'),
    ];
    const unique = new Set(keys);
    expect(unique.size).toBe(4);
  });

  it('UUIDs work as org/user ids', () => {
    const key = seenSetKey(
      '018e4a2c-aaaa-7000-aaaa-000000000001',
      '018e4a2c-bbbb-7000-bbbb-000000000001',
    );
    expect(key).toBe(
      'aeroops:alerts-seen:018e4a2c-aaaa-7000-aaaa-000000000001:018e4a2c-bbbb-7000-bbbb-000000000001',
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. readSeenIds — parse raw localStorage string to Set<string>
// ═════════════════════════════════════════════════════════════════════════════

describe('2. readSeenIds — parse localStorage raw value', () => {
  it('null → empty set', () => {
    expect(readSeenIds(null).size).toBe(0);
  });

  it('empty string → empty set (graceful, not a throw)', () => {
    expect(readSeenIds('').size).toBe(0);
  });

  it('valid JSON array of strings → correct Set', () => {
    const raw = JSON.stringify(['id-1', 'id-2', 'id-3']);
    const result = readSeenIds(raw);
    expect(result.has('id-1')).toBe(true);
    expect(result.has('id-2')).toBe(true);
    expect(result.has('id-3')).toBe(true);
    expect(result.size).toBe(3);
  });

  it('invalid JSON → empty set (graceful, not a throw)', () => {
    expect(readSeenIds('not-json').size).toBe(0);
    expect(readSeenIds('{broken').size).toBe(0);
  });

  it('JSON non-array (object) → empty set', () => {
    expect(readSeenIds('{"id":"foo"}').size).toBe(0);
  });

  it('JSON array with non-string members → filters to strings only', () => {
    const raw = JSON.stringify(['valid-id', 42, null, true, 'another-id']);
    const result = readSeenIds(raw);
    expect(result.has('valid-id')).toBe(true);
    expect(result.has('another-id')).toBe(true);
    expect(result.size).toBe(2);
  });

  it('empty JSON array → empty set', () => {
    expect(readSeenIds('[]').size).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. serializeSeenIds — serialize Set to JSON string
// ═════════════════════════════════════════════════════════════════════════════

describe('3. serializeSeenIds — Set → JSON string', () => {
  it('empty set → "[]"', () => {
    expect(serializeSeenIds(new Set())).toBe('[]');
  });

  it('round-trip: serialize → readSeenIds recovers the original set', () => {
    const original = new Set(['reservation:abc:upcoming', 'grounding:x:y']);
    const serialized = serializeSeenIds(original);
    const recovered = readSeenIds(serialized);
    expect(recovered.size).toBe(original.size);
    for (const id of original) {
      expect(recovered.has(id)).toBe(true);
    }
  });

  it('produces valid JSON (parseable)', () => {
    const s = serializeSeenIds(new Set(['a', 'b']));
    expect(() => JSON.parse(s)).not.toThrow();
    const parsed = JSON.parse(s);
    expect(Array.isArray(parsed)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. pruneSeenIds — remove ids no longer in the current alert list
// ═════════════════════════════════════════════════════════════════════════════

describe('4. pruneSeenIds — stale id pruning', () => {
  it('empty seen + any current → empty result', () => {
    const pruned = pruneSeenIds(new Set(), new Set(['a', 'b']));
    expect(pruned.size).toBe(0);
  });

  it('seen only contains IDs not in current → all pruned', () => {
    const seen = new Set(['old-1', 'old-2']);
    const current = new Set(['new-1', 'new-2']);
    const pruned = pruneSeenIds(seen, current);
    expect(pruned.size).toBe(0);
  });

  it('seen IDs in current are kept; stale are dropped', () => {
    const seen = new Set(['keep-1', 'stale-1', 'keep-2']);
    const current = new Set(['keep-1', 'keep-2', 'new-1']);
    const pruned = pruneSeenIds(seen, current);
    expect(pruned.has('keep-1')).toBe(true);
    expect(pruned.has('keep-2')).toBe(true);
    expect(pruned.has('stale-1')).toBe(false);
    expect(pruned.size).toBe(2);
  });

  it('does not mutate the input seen set (returns a NEW Set)', () => {
    const seen = new Set(['a', 'b', 'c']);
    const current = new Set(['a']); // b and c are stale
    const pruned = pruneSeenIds(seen, current);
    // Input unchanged
    expect(seen.size).toBe(3);
    // Output is a new Set
    expect(pruned).not.toBe(seen);
    expect(pruned.size).toBe(1);
  });

  it('empty seen + empty current → empty result', () => {
    expect(pruneSeenIds(new Set(), new Set()).size).toBe(0);
  });

  it('all seen still present in current → all kept', () => {
    const seen = new Set(['x', 'y']);
    const current = new Set(['x', 'y', 'z']);
    const pruned = pruneSeenIds(seen, current);
    expect(pruned.size).toBe(2);
    expect(pruned.has('x')).toBe(true);
    expect(pruned.has('y')).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. computeUnreadCount — count alerts not in the seen set
// ═════════════════════════════════════════════════════════════════════════════

describe('5. computeUnreadCount — unread badge math', () => {
  it('empty alerts → 0', () => {
    expect(computeUnreadCount([], new Set(['id-1']))).toBe(0);
  });

  it('all seen → 0', () => {
    const ids = ['a', 'b', 'c'];
    const seen = new Set(['a', 'b', 'c']);
    expect(computeUnreadCount(ids, seen)).toBe(0);
  });

  it('none seen → count = alertIds.length', () => {
    const ids = ['a', 'b', 'c'];
    expect(computeUnreadCount(ids, new Set())).toBe(3);
  });

  it('partial seen → counts only unseen', () => {
    const ids = ['a', 'b', 'c', 'd'];
    const seen = new Set(['b', 'd']); // a and c are unseen
    expect(computeUnreadCount(ids, seen)).toBe(2);
  });

  it('seen set with IDs not in alerts → only matches in alerts count', () => {
    const ids = ['a', 'b'];
    const seen = new Set(['a', 'x', 'y']); // x,y not in alerts
    // b is unseen
    expect(computeUnreadCount(ids, seen)).toBe(1);
  });

  it('single alert unseen → 1', () => {
    expect(computeUnreadCount(['solo'], new Set())).toBe(1);
  });

  it('single alert seen → 0', () => {
    expect(computeUnreadCount(['solo'], new Set(['solo']))).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. badgeLabel — "9+" clamp
// ═════════════════════════════════════════════════════════════════════════════

describe('6. badgeLabel — 9+ clamp', () => {
  it('0 → "0"', () => {
    expect(badgeLabel(0)).toBe('0');
  });

  it('1 → "1"', () => {
    expect(badgeLabel(1)).toBe('1');
  });

  it('9 → "9" (boundary: not clamped)', () => {
    expect(badgeLabel(9)).toBe('9');
  });

  it('10 → "9+" (one over the clamp threshold)', () => {
    expect(badgeLabel(10)).toBe('9+');
  });

  it('20 → "9+"', () => {
    expect(badgeLabel(20)).toBe('9+');
  });

  it('MAX_ALERTS=20 → "9+"', () => {
    // The API caps at 20; even at the cap we show "9+".
    expect(badgeLabel(20)).toBe('9+');
  });

  it('100 → "9+"', () => {
    expect(badgeLabel(100)).toBe('9+');
  });

  it('2, 3, 4, 5, 6, 7, 8 all display their count directly', () => {
    for (let i = 2; i <= 8; i++) {
      expect(badgeLabel(i)).toBe(String(i));
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7. buildAlertHref — slug-prepend
// ═════════════════════════════════════════════════════════════════════════════

describe('7. buildAlertHref — slug-prepend for alert deep-links', () => {
  it('null path → null (no deep-link)', () => {
    expect(buildAlertHref('acme', null)).toBeNull();
  });

  it('schedule path → /o/{slug}{path}', () => {
    expect(buildAlertHref('acme', '/schedule?date=2026-11-10')).toBe(
      '/o/acme/schedule?date=2026-11-10',
    );
  });

  it('fleet path → /o/{slug}{path}', () => {
    expect(buildAlertHref('sky-club', '/fleet/abc-123')).toBe('/o/sky-club/fleet/abc-123');
  });

  it('schedule board path', () => {
    expect(buildAlertHref('acme', '/schedule/board')).toBe('/o/acme/schedule/board');
  });

  it('different slugs produce different hrefs for the same path', () => {
    const a = buildAlertHref('org-a', '/schedule');
    const b = buildAlertHref('org-b', '/schedule');
    expect(a).toBe('/o/org-a/schedule');
    expect(b).toBe('/o/org-b/schedule');
    expect(a).not.toBe(b);
  });

  it('slug with hyphens is preserved', () => {
    expect(buildAlertHref('alpha-flight-school', '/schedule')).toBe(
      '/o/alpha-flight-school/schedule',
    );
  });

  it('always prefixes /o/{slug} — never bare path', () => {
    const href = buildAlertHref('acme', '/schedule');
    expect(href).not.toBeNull();
    expect(href!.startsWith('/o/acme')).toBe(true);
    expect(href).not.toBe('/schedule');
  });

  it('non-null path with query string is preserved verbatim', () => {
    const href = buildAlertHref('acme', '/schedule?date=2026-12-25&view=day');
    expect(href).toBe('/o/acme/schedule?date=2026-12-25&view=day');
  });
});
