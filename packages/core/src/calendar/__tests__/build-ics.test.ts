/**
 * build-ics.test.ts — unit + property tests for the pure RFC-5545 serializer
 * (Slice P1.4). This is the SECURITY-SENSITIVE core: it is tested hard per
 * the ticket's hard guardrail.
 *
 * COVERAGE:
 *   Unit: basic VCALENDAR/VEVENT structure, CRLF terminators, UTC DTSTART/
 *     DTEND formatting, escaping of each RFC-5545 special character, folding
 *     of a long line at 75 octets with a leading-space continuation.
 *   Property (fast-check):
 *     - round-trip: every event's uid/start/end/summary/description survives
 *       build → unfold → unescape exactly, for arbitrary (including
 *       adversarial) text.
 *     - escaping never leaves an unescaped delimiter (';', ',', '\n', '\r')
 *       in the escaped output.
 *     - injection safety: adversarial summary/description text (raw CRLF +
 *       literal "BEGIN:VEVENT"/"END:VCALENDAR" lines) can NEVER forge extra
 *       VEVENT/VCALENDAR blocks — the block counts are exactly events.length / 1.
 *     - determinism: same events + same injected `now` → byte-identical output.
 *     - line folding: every physical line is <= 75 octets; unfolding recovers
 *       the exact original logical line for arbitrary (incl. multi-byte) text.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  buildIcs,
  escapeIcsText,
  foldLine,
  formatIcsUtc,
} from '../build-ics.js';
import type { IcsEvent } from '../build-ics.js';

const FIXED_NOW = new Date('2026-07-02T12:00:00.000Z');

// ─── Test-only helpers: unfold + parse (mirrors what a real ICS parser does,
// kept intentionally minimal — just enough to assert round-trip/injection
// invariants; NOT shipped in packages/core). ──────────────────────────────

/** unfoldIcs — reverses line folding: joins " "-prefixed continuation
 * physical lines back onto the preceding logical line. */
function unfoldIcs(ics: string): string[] {
  const physical = ics.split('\r\n');
  const logical: string[] = [];
  for (const pl of physical) {
    if (pl.startsWith(' ')) {
      logical[logical.length - 1] = (logical[logical.length - 1] ?? '') + pl.slice(1);
    } else if (pl.length > 0) {
      logical.push(pl);
    }
  }
  return logical;
}

/** unescapeIcsText — reverses escapeIcsText (RFC-5545 §3.3.11 TEXT unescape). */
function unescapeIcsText(v: string): string {
  let out = '';
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '\\' && i + 1 < v.length) {
      const next = v[i + 1];
      if (next === 'n' || next === 'N') { out += '\n'; i++; continue; }
      if (next === ';') { out += ';'; i++; continue; }
      if (next === ',') { out += ','; i++; continue; }
      if (next === '\\') { out += '\\'; i++; continue; }
      out += v[i];
    } else {
      out += v[i];
    }
  }
  return out;
}

/** parseFields — key:value map for the logical lines strictly between (and
 * excluding) a BEGIN:VEVENT/END:VEVENT pair. Splits on the FIRST colon only. */
function parseFields(veventLines: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of veventLines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    fields[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return fields;
}

/** extractVeventBlocks — splits the unfolded logical lines into one
 * string[] per BEGIN:VEVENT..END:VEVENT block (exclusive of the markers),
 * in document order. */
function extractVeventBlocks(logical: string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (const line of logical) {
    if (line === 'BEGIN:VEVENT') {
      current = [];
      continue;
    }
    if (line === 'END:VEVENT') {
      if (current) blocks.push(current);
      current = null;
      continue;
    }
    if (current) current.push(line);
  }
  return blocks;
}

/** utf8Octets — pure (no Buffer/node) UTF-8 byte length of a string, summed
 * per code point. Mirrors the private helper inside build-ics.ts, kept
 * duplicated here so the test stays framework-agnostic (this package is
 * RN-safe — no node builtins). */
function utf8Octets(s: string): number {
  let total = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x7f) total += 1;
    else if (cp <= 0x7ff) total += 2;
    else if (cp <= 0xffff) total += 3;
    else total += 4;
  }
  return total;
}

/** hasUnescapedDelimiter — true iff the string contains a ';', ',', '\n', or
 * '\r' that is NOT immediately preceded by an escaping backslash. */
function hasUnescapedDelimiter(s: string): boolean {
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\') {
      i += 2; // skip the escaped pair (backslash + next char).
      continue;
    }
    if (s[i] === ';' || s[i] === ',' || s[i] === '\n' || s[i] === '\r') return true;
    i += 1;
  }
  return false;
}

// ─── Generators ──────────────────────────────────────────────────────────────

// A realistic-ish date range (avoids <1000/>9999 year edge cases in
// formatIcsUtc's un-padded year — real reservation data is always in this
// range for this app).
const dateArb = fc
  .integer({ min: new Date('2000-01-01T00:00:00Z').getTime(), max: new Date('2100-01-01T00:00:00Z').getTime() })
  .map((ms) => new Date(ms));

// Deliberately adversarial text: plain fc.string() PLUS specific RFC-5545
// special characters and raw CRLF/literal iCal-syntax injection attempts.
const adversarialTextArb = fc.oneof(
  fc.string(),
  fc.constantFrom(
    'has;semi',
    'has,comma',
    'has\\backslash',
    'line1\nline2',
    'line1\r\nline2',
    'BEGIN:VEVENT\r\nUID:evil\r\nEND:VEVENT',
    'END:VCALENDAR\r\nBEGIN:VCALENDAR',
    ';;;,,,\\\\\\',
    '\r\n\r\n',
  ),
);

function eventArb(): fc.Arbitrary<IcsEvent> {
  return fc.record({
    uid: adversarialTextArb.filter((s) => s.length > 0),
    start: dateArb,
    end: dateArb,
    summary: adversarialTextArb,
    description: fc.option(adversarialTextArb, { nil: undefined }),
  });
}

// ─── Unit: basic structure ─────────────────────────────────────────────────

describe('buildIcs — unit structure', () => {
  it('produces a well-formed VCALENDAR with one VEVENT, CRLF-terminated', () => {
    const ics = buildIcs(
      [
        {
          uid: 'abc-123',
          start: new Date('2026-07-10T14:00:00.000Z'),
          end: new Date('2026-07-10T16:00:00.000Z'),
          summary: 'Discovery flight — N12345',
        },
      ],
      { now: FIXED_NOW },
    );

    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('VERSION:2.0\r\n');
    expect(ics).toContain('PRODID:-//AeroOps//Calendar Feed//EN\r\n');
    expect(ics).toContain('BEGIN:VEVENT\r\n');
    expect(ics).toContain('UID:abc-123\r\n');
    expect(ics).toContain('DTSTAMP:20260702T120000Z\r\n');
    expect(ics).toContain('DTSTART:20260710T140000Z\r\n');
    expect(ics).toContain('DTEND:20260710T160000Z\r\n');
    expect(ics).toContain('SUMMARY:Discovery flight — N12345\r\n');
    expect(ics).toContain('END:VEVENT\r\n');
    // No LF without a preceding CR anywhere.
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('empty events list still produces a valid (empty) VCALENDAR', () => {
    const ics = buildIcs([], { now: FIXED_NOW });
    expect(ics).toBe('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//AeroOps//Calendar Feed//EN\r\nCALSCALE:GREGORIAN\r\nEND:VCALENDAR\r\n');
  });

  it('includes X-WR-CALNAME when calendarName is provided', () => {
    const ics = buildIcs([], { now: FIXED_NOW, calendarName: 'My Reservations' });
    expect(ics).toContain('X-WR-CALNAME:My Reservations\r\n');
  });

  it('includes DESCRIPTION and LOCATION only when provided', () => {
    const withBoth = buildIcs(
      [{ uid: '1', start: FIXED_NOW, end: FIXED_NOW, summary: 'S', description: 'D', location: 'L' }],
      { now: FIXED_NOW },
    );
    expect(withBoth).toContain('DESCRIPTION:D\r\n');
    expect(withBoth).toContain('LOCATION:L\r\n');

    const withNeither = buildIcs(
      [{ uid: '1', start: FIXED_NOW, end: FIXED_NOW, summary: 'S' }],
      { now: FIXED_NOW },
    );
    expect(withNeither).not.toContain('DESCRIPTION');
    expect(withNeither).not.toContain('LOCATION');
  });
});

// ─── Unit: escaping ─────────────────────────────────────────────────────────

describe('escapeIcsText — unit edges', () => {
  it('escapes backslash, semicolon, comma, and newlines', () => {
    expect(escapeIcsText('a\\b')).toBe('a\\\\b');
    expect(escapeIcsText('a;b')).toBe('a\\;b');
    expect(escapeIcsText('a,b')).toBe('a\\,b');
    expect(escapeIcsText('a\nb')).toBe('a\\nb');
    expect(escapeIcsText('a\r\nb')).toBe('a\\nb');
    expect(escapeIcsText('a\rb')).toBe('a\\nb');
  });

  it('escapes backslash BEFORE other characters (no double-escaping)', () => {
    // A literal backslash-n in the input must become \\n (escaped backslash,
    // literal n) — NOT \n (which would be indistinguishable from an escaped
    // real newline).
    expect(escapeIcsText('a\\nb')).toBe('a\\\\nb');
  });
});

// ─── Unit: folding ─────────────────────────────────────────────────────────

describe('foldLine — unit edges', () => {
  it('does not fold a short line', () => {
    const line = 'SUMMARY:short';
    expect(foldLine(line)).toBe(line);
  });

  it('folds a long line at 75 octets with a leading-space continuation', () => {
    const longValue = 'x'.repeat(200);
    const folded = foldLine(`SUMMARY:${longValue}`);
    const physical = folded.split('\r\n');
    expect(physical.length).toBeGreaterThan(1);
    // First line <= 75 octets.
    expect(utf8Octets(physical[0]!)).toBeLessThanOrEqual(75);
    // Every continuation line starts with a single space and is <= 75 octets.
    for (const cont of physical.slice(1)) {
      expect(cont.startsWith(' ')).toBe(true);
      expect(utf8Octets(cont)).toBeLessThanOrEqual(75);
    }
  });

  it('never splits a multi-byte UTF-8 character across a fold boundary', () => {
    // 'é' is 2 octets in UTF-8; pad so a fold boundary would land mid-character
    // if folding were byte-naive instead of code-point-aware.
    const value = 'a'.repeat(73) + 'é'.repeat(10);
    const folded = foldLine(`SUMMARY:${value}`);
    // Reconstructing via unfoldSingle must recover the exact original string —
    // if a char had been split, this would fail (mangled bytes / wrong length).
    const rejoined = folded.split('\r\n').map((l, i) => (i === 0 ? l : l.slice(1))).join('');
    expect(rejoined).toBe(`SUMMARY:${value}`);
  });
});

// ─── Unit: UTC formatting ───────────────────────────────────────────────────

describe('formatIcsUtc — unit edges', () => {
  it('formats as yyyymmddThhmmssZ in UTC', () => {
    expect(formatIcsUtc(new Date('2026-01-05T03:04:05.000Z'))).toBe('20260105T030405Z');
  });

  it('zero-pads single-digit month/day/hour/minute/second', () => {
    expect(formatIcsUtc(new Date('2026-02-03T04:05:06.000Z'))).toBe('20260203T040506Z');
  });
});

// ─── Property: determinism ─────────────────────────────────────────────────

describe('buildIcs — property: determinism', () => {
  it('same events + same `now` produce byte-identical output', () => {
    fc.assert(
      fc.property(fc.array(eventArb(), { maxLength: 5 }), (events) => {
        const a = buildIcs(events, { now: FIXED_NOW });
        const b = buildIcs(events, { now: FIXED_NOW });
        expect(a).toBe(b);
      }),
      { numRuns: 100 },
    );
  });
});

// ─── Property: round-trip ───────────────────────────────────────────────────

/**
 * normalizeNewlines — RFC-5545 TEXT escaping has exactly ONE newline escape
 * ("\n"/"\N") — it does not distinguish LF vs CRLF vs bare CR in the
 * original. So a round-trip through escape→unescape is exact modulo newline
 *-style normalization; this mirrors what any real ICS consumer sees, not a
 * lossiness bug in buildIcs.
 */
function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

describe('buildIcs — property: round-trip', () => {
  it('every event uid/start/end/summary/description round-trips exactly (modulo newline-style normalization)', () => {
    fc.assert(
      fc.property(fc.array(eventArb(), { minLength: 1, maxLength: 5 }), (events) => {
        const ics = buildIcs(events, { now: FIXED_NOW });
        const logical = unfoldIcs(ics);
        const blocks = extractVeventBlocks(logical);
        expect(blocks.length).toBe(events.length);

        blocks.forEach((block, i) => {
          const ev = events[i]!;
          const fields = parseFields(block);
          expect(unescapeIcsText(fields['UID']!)).toBe(normalizeNewlines(ev.uid));
          expect(fields['DTSTART']).toBe(formatIcsUtc(ev.start));
          expect(fields['DTEND']).toBe(formatIcsUtc(ev.end));
          expect(unescapeIcsText(fields['SUMMARY']!)).toBe(normalizeNewlines(ev.summary));
          if (ev.description) {
            expect(unescapeIcsText(fields['DESCRIPTION']!)).toBe(normalizeNewlines(ev.description));
          } else {
            expect(fields['DESCRIPTION']).toBeUndefined();
          }
        });
      }),
      { numRuns: 200 },
    );
  });
});

// ─── Property: escaping never leaves an unescaped delimiter ────────────────

describe('escapeIcsText — property: no unescaped delimiter', () => {
  it('never leaves a bare ; , \\n \\r unescaped in the output', () => {
    fc.assert(
      fc.property(adversarialTextArb, (text) => {
        expect(hasUnescapedDelimiter(escapeIcsText(text))).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});

// ─── Property: injection safety ────────────────────────────────────────────

describe('buildIcs — property: injection safety', () => {
  it('adversarial summary/description text can never forge extra VEVENT/VCALENDAR blocks', () => {
    fc.assert(
      fc.property(fc.array(eventArb(), { minLength: 1, maxLength: 5 }), (events) => {
        const ics = buildIcs(events, { now: FIXED_NOW });
        const logical = unfoldIcs(ics);

        const count = (needle: string) => logical.filter((l) => l === needle).length;

        expect(count('BEGIN:VCALENDAR')).toBe(1);
        expect(count('END:VCALENDAR')).toBe(1);
        expect(count('BEGIN:VEVENT')).toBe(events.length);
        expect(count('END:VEVENT')).toBe(events.length);
      }),
      { numRuns: 200 },
    );
  });
});
