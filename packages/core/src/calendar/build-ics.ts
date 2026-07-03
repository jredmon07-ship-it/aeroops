/**
 * calendar/build-ics.ts — pure RFC-5545 (iCalendar) serializer (Slice P1.4).
 *
 * buildIcs(events, opts?) → a VCALENDAR document string, CRLF line-terminated,
 * line-folded at 75 octets, with every TEXT field escaped per §3.3.11.
 *
 * PURE: no I/O, no Date.now() (a fixed `now` is injected via opts, mirroring
 * the injected-clock convention used elsewhere in this codebase — e.g. the
 * recurrence expander's injected tz resolver). Same inputs (including `now`)
 * ALWAYS produce the same output — this is the "deterministic" property the
 * tests hold it to.
 *
 * SECURITY-SENSITIVE: this is the ONE place untrusted operator/member text
 * (reservation notes, aircraft display names, etc.) is embedded into a
 * document format with its OWN line-terminator/field-separator grammar. Every
 * TEXT field goes through escapeIcsText — a raw newline/comma/semicolon/
 * backslash in the input can NEVER produce a raw (unescaped) CRLF, comma, or
 * semicolon in the output, so untrusted text can never inject a bogus
 * property line or split/extend a VEVENT block. See __tests__/build-ics.test.ts
 * for the adversarial property coverage.
 *
 * RFC-5545 references: §3.1 (content lines + folding), §3.3.5 (DATE-TIME),
 * §3.3.11 (TEXT escaping), §3.6.1 (VEVENT).
 */

// ─── Public types ──────────────────────────────────────────────────────────

export interface IcsEvent {
  /** Globally-unique-enough identifier for this event (RFC-5545 UID). */
  uid: string;
  /** Event start, interpreted as an absolute instant (rendered in UTC). */
  start: Date;
  /** Event end, interpreted as an absolute instant (rendered in UTC). */
  end: Date;
  /** SUMMARY — short title. */
  summary: string;
  /** DESCRIPTION — optional longer text. */
  description?: string;
  /** LOCATION — optional free-text location. */
  location?: string;
}

export interface BuildIcsOptions {
  /** X-WR-CALNAME — a display name for the whole calendar (optional). */
  calendarName?: string;
  /**
   * The instant to stamp as DTSTAMP on every VEVENT. Defaults to `new Date()`.
   * ALWAYS pass a fixed value from a test for deterministic output.
   */
  now?: Date;
}

// ─── RFC-5545 §3.3.11 TEXT escaping ──────────────────────────────────────────

/**
 * escapeIcsText — escapes a value for use in an iCalendar TEXT property value.
 *
 * Order matters: backslash MUST be escaped first (otherwise the backslashes
 * inserted by the later replacements would themselves get re-escaped).
 * Newlines (both bare \n, bare \r, and \r\n) become the two-character
 * sequence `\n` (backslash + letter n) — a LITERAL escape sequence, NOT a
 * real line break. Because the escaped text never contains a raw CR or LF,
 * it can never be mistaken by a parser (or by our own folder) for the
 * content-line terminator.
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\n');
}

// ─── RFC-5545 §3.3.5 DATE-TIME (UTC form) ────────────────────────────────────

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** formatIcsUtc — renders a Date as yyyymmddThhmmssZ (UTC, per §3.3.5). */
export function formatIcsUtc(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mi = pad2(d.getUTCMinutes());
  const ss = pad2(d.getUTCSeconds());
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

// ─── RFC-5545 §3.1 line folding (75 octets, UTF-8-safe) ──────────────────────

const MAX_OCTETS = 75;

/**
 * foldLine — folds a single logical content line into physical lines per
 * §3.1: no physical line may exceed 75 octets (excluding the CRLF itself);
 * continuation lines start with a single space. Folding is octet-aware (not
 * character-aware) so a multi-byte UTF-8 character is never split across two
 * physical lines — the whole character is pushed to the next line instead.
 */
export function foldLine(line: string): string {
  const CRLF = '\r\n';
  let out = '';
  let buf = '';
  let bufOctets = 0;

  for (const ch of line) {
    // Byte length of this single Unicode code point in UTF-8.
    const chOctets = utf8ByteLength(ch);
    if (bufOctets + chOctets > MAX_OCTETS) {
      out += buf + CRLF;
      buf = ' ' + ch; // continuation line: leading space + this char.
      bufOctets = 1 + chOctets;
    } else {
      buf += ch;
      bufOctets += chOctets;
    }
  }
  out += buf;
  return out;
}

/** utf8ByteLength — the UTF-8 byte length of a single JS string "character"
 * (which may itself be a surrogate pair — `for...of` iterates by code point). */
function utf8ByteLength(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp <= 0x7f) return 1;
  if (cp <= 0x7ff) return 2;
  if (cp <= 0xffff) return 3;
  return 4;
}

// ─── buildIcs ────────────────────────────────────────────────────────────────

/**
 * buildIcs — serializes a list of events into a complete VCALENDAR document.
 *
 * Output shape (logical lines, before folding):
 *   BEGIN:VCALENDAR
 *   VERSION:2.0
 *   PRODID:-//AeroOps//Calendar Feed//EN
 *   CALSCALE:GREGORIAN
 *   [X-WR-CALNAME:<calendarName>]
 *   (per event)
 *     BEGIN:VEVENT
 *     UID:<escaped>
 *     DTSTAMP:<now, UTC>
 *     DTSTART:<start, UTC>
 *     DTEND:<end, UTC>
 *     SUMMARY:<escaped>
 *     [DESCRIPTION:<escaped>]
 *     [LOCATION:<escaped>]
 *     END:VEVENT
 *   END:VCALENDAR
 *
 * Every logical line is folded (foldLine) and CRLF-terminated. The document
 * itself ends with a trailing CRLF after the final END:VCALENDAR line.
 */
export function buildIcs(events: IcsEvent[], opts: BuildIcsOptions = {}): string {
  const now = opts.now ?? new Date();
  const dtstamp = formatIcsUtc(now);

  const lines: string[] = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:-//AeroOps//Calendar Feed//EN');
  lines.push('CALSCALE:GREGORIAN');
  if (opts.calendarName) {
    lines.push(`X-WR-CALNAME:${escapeIcsText(opts.calendarName)}`);
  }

  for (const ev of events) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${escapeIcsText(ev.uid)}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART:${formatIcsUtc(ev.start)}`);
    lines.push(`DTEND:${formatIcsUtc(ev.end)}`);
    lines.push(`SUMMARY:${escapeIcsText(ev.summary)}`);
    if (ev.description) {
      lines.push(`DESCRIPTION:${escapeIcsText(ev.description)}`);
    }
    if (ev.location) {
      lines.push(`LOCATION:${escapeIcsText(ev.location)}`);
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');

  return lines.map(foldLine).join('\r\n') + '\r\n';
}
