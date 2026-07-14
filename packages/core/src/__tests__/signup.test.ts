import { describe, it, expect } from 'vitest';
import {
  deriveSlugBase,
  deriveSlugCandidate,
  isValidSlug,
  RESERVED_SLUGS,
} from '../signup.js';

describe('deriveSlugBase', () => {
  it('lowercases, hyphenates, and trims', () => {
    expect(deriveSlugBase('Bravo Flying Club!')).toBe('bravo-flying-club');
    expect(deriveSlugBase('  A & B  ')).toBe('a-b');
    expect(deriveSlugBase('Skyline   Aero...')).toBe('skyline-aero');
  });

  it('returns null for names with no usable slug', () => {
    expect(deriveSlugBase('!!!')).toBeNull();
    expect(deriveSlugBase('  ')).toBeNull();
    expect(deriveSlugBase('ab')).toBeNull(); // too short (< 3)
  });

  it('returns null for reserved words', () => {
    expect(deriveSlugBase('API')).toBeNull();
    expect(deriveSlugBase('Login')).toBeNull();
    expect(deriveSlugBase('demo')).toBeNull();
  });

  it('respects the max length', () => {
    const base = deriveSlugBase('x'.repeat(200));
    expect(base).not.toBeNull();
    expect(base!.length).toBeLessThanOrEqual(40);
  });
});

describe('deriveSlugCandidate', () => {
  it('attempt 0 is the base, later attempts suffix -2, -3, …', () => {
    expect(deriveSlugCandidate('dup-aero', 0)).toBe('dup-aero');
    expect(deriveSlugCandidate('dup-aero', 1)).toBe('dup-aero-2');
    expect(deriveSlugCandidate('dup-aero', 2)).toBe('dup-aero-3');
  });

  it('never emits a reserved slug', () => {
    expect(deriveSlugCandidate('api', 0)).toBeNull();
    // suffixed candidates that collide with a reserved word are skipped too.
    for (const reserved of RESERVED_SLUGS) {
      expect(deriveSlugCandidate(reserved, 0)).toBeNull();
    }
  });

  it('keeps suffixed candidates within the max length', () => {
    const c = deriveSlugCandidate('y'.repeat(40), 9);
    expect(c).not.toBeNull();
    expect(c!.length).toBeLessThanOrEqual(40);
    expect(c!.endsWith('-10')).toBe(true);
  });
});

describe('isValidSlug', () => {
  it('accepts well-formed slugs and rejects malformed/reserved ones', () => {
    expect(isValidSlug('bravo-flying-club')).toBe(true);
    expect(isValidSlug('ab')).toBe(false); // too short
    expect(isValidSlug('-lead')).toBe(false);
    expect(isValidSlug('trail-')).toBe(false);
    expect(isValidSlug('Upper')).toBe(false);
    expect(isValidSlug('has space')).toBe(false);
    expect(isValidSlug('api')).toBe(false); // reserved
  });
});
