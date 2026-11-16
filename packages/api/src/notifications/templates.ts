/**
 * notifications/templates.ts — pure email templates, one per event type
 * (Slice P1.3). Framework-agnostic; no I/O; no Date.now() (all inputs
 * injected).
 *
 * COPY POSTURE (compliance-load-bearing):
 *   PLAIN, operator-operational language only. NO FAA/airworthiness/
 *   currency/Part-61/141/91/43 determination language anywhere. Text-
 *   first: every template returns a `text` body that stands alone; `html`
 *   is a minimal, unstyled wrapper (no external assets, no tracking pixels).
 */
import type {
  BookingResourceLabels,
  NotificationTemplateDataMap,
  RenderedEmail,
  ReservationCreatedData,
  ReservationForMemberData,
  SquawkReportedData,
  AircraftGroundedData,
  MaintenanceDueData,
  OrgAnnouncementData,
} from './email-event-types.js';
import type { NotificationEventType } from './email-event-types.js';

function formatDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

/** Minimal, unstyled HTML wrapper — no external assets, no tracking. */
function wrapHtml(paragraphs: string[]): string {
  const body = paragraphs.map((p) => `<p>${p}</p>`).join('\n');
  return `<!doctype html><html><body>${body}</body></html>`;
}

/**
 * escapeHtml — minimal HTML-entity escaping for OPERATOR-AUTHORED free text
 * (Slice FC-P1's announcement body/subject). The other templates above
 * interpolate short, structured operator fields (a title, a reason) that
 * predate this escaping need; org.announcement is the first template to
 * carry an arbitrarily long free-text field, so it is escaped explicitly
 * here rather than widening every existing template's behavior.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderReservationCreated(data: ReservationCreatedData): RenderedEmail {
  const tails = data.resourceIds.length > 0 ? data.resourceIds.join(', ') : 'the requested resource';
  const text =
    `Your reservation is confirmed.\n\n` +
    `Resource(s): ${tails}\n` +
    `Start: ${formatDateTime(data.startAt)}\n` +
    `End: ${formatDateTime(data.endAt)}\n`;
  return {
    subject: 'Reservation confirmed',
    text,
    html: wrapHtml([
      'Your reservation is confirmed.',
      `Resource(s): ${tails}`,
      `Start: ${formatDateTime(data.startAt)}`,
      `End: ${formatDateTime(data.endAt)}`,
    ]),
  };
}

// ─── reservation.for_member ───────────────────────────────────────────────────
//
// Times are written in the zone the template data names, on the schedule's
// 24-hour clock, ALWAYS followed by the zone's short name ("10:00–11:30 CST")
// — the same convention as global search and the activity feed. A zone Intl
// does not know falls back to an explicit "UTC". Never a bare clock time.

/** `timeZone` when Intl knows it, else 'UTC' (then printed as "UTC"). */
function knownZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

interface ZonedParts {
  /** "Mon, Nov 16, 2026" */
  date: string;
  /** "Mon, Nov 16" (subject lines) */
  shortDate: string;
  /** "10:00" */
  time: string;
  /** "CST", "CDT", "UTC", or a GMT offset where en-US has no short name. */
  zone: string;
}

/** `d` read in `timeZone` (a zone knownZone already vetted). */
function zoned(d: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(d);
  // ICU versions differ on no-break spaces; plain spaces read the same everywhere.
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    (parts.find((p) => p.type === type)?.value ?? '').replace(/[\u202f\u00a0]/g, ' ');
  const shortDate = `${part('weekday')}, ${part('month')} ${part('day')}`;
  return {
    date: `${shortDate}, ${part('year')}`,
    shortDate,
    time: `${part('hour')}:${part('minute')}`,
    zone: part('timeZoneName'),
  };
}

/**
 * "Mon, Nov 16, 2026, 10:00–11:30 CST". A window that crosses midnight names
 * both days; one that crosses a DST change names both zones.
 */
function formatWindow(startAt: Date, endAt: Date, timeZone: string): string {
  const s = zoned(startAt, timeZone);
  const e = zoned(endAt, timeZone);
  const startZone = s.zone === e.zone ? '' : ` ${s.zone}`;
  if (s.date === e.date) return `${s.date}, ${s.time}${startZone}–${e.time} ${e.zone}`;
  return `${s.date}, ${s.time}${startZone} – ${e.date}, ${e.time} ${e.zone}`;
}

/** "Mon, Nov 16, 10:00 CST" — a start short enough for a subject line. */
function formatShortStart(startAt: Date, timeZone: string): string {
  const s = zoned(startAt, timeZone);
  return `${s.shortDate}, ${s.time} ${s.zone}`;
}

const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** ISO weekdays 1..7 → "Tuesday and Thursday" ('' when none are valid). */
function weekdayList(weekdays: number[]): string {
  const names = [...new Set(weekdays)]
    .filter((w) => Number.isInteger(w) && w >= 1 && w <= 7)
    .sort((a, b) => a - b)
    .map((w) => WEEKDAY_NAMES[w - 1]!);
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function sameLabels(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((label, i) => label === b[i]);
}

/**
 * The "Aircraft: N12345" / "Instructor: Casey Reed (CFI)" / "Also booked:
 * Redbird sim" lines. With `previous` (a move), a line whose labels changed
 * says what it was: "Aircraft: N67890 (was N12345)".
 */
function resourceLines(current: BookingResourceLabels, previous?: Partial<BookingResourceLabels>): string[] {
  const lines: string[] = [];
  const line = (label: string, now: string[], was: string[] | undefined) => {
    const changed = was !== undefined && !sameLabels(now, was);
    if (now.length === 0 && !changed) return;
    const value = now.length > 0 ? now.join(', ') : 'none';
    lines.push(changed ? `${label}: ${value} (was ${was.length > 0 ? was.join(', ') : 'none'})` : `${label}: ${value}`);
  };
  line('Aircraft', current.aircraft, previous?.aircraft);
  line(current.instructors.length > 1 ? 'Instructors' : 'Instructor', current.instructors, previous?.instructors);
  line('Also booked', current.otherResources, previous?.otherResources);
  return lines;
}

/**
 * renderReservationForMember — club staff booked, moved or cancelled a
 * booking FOR the recipient. Says who made the change, what is booked (tail
 * numbers and names, never ids) and when (zoned, with the zone's short name).
 * A recurring series is one e-mail: how many bookings, the weekdays and time
 * it repeats on, and its first and last dates. Every operator-entered value
 * (names, labels, the cancellation reason) is HTML-escaped in `html`.
 */
function renderReservationForMember(data: ReservationForMemberData): RenderedEmail {
  const zone = knownZone(data.timeZone);
  const who = data.changedBy.trim() || 'Club staff';
  const orgName = data.orgName.trim();
  const at = orgName ? ` at ${orgName}` : '';
  const primary = data.aircraft[0] ?? data.instructors[0] ?? data.otherResources[0];
  const lead = primary ? `${primary}, ` : '';
  const when = formatWindow(data.startAt, data.endAt, zone);

  let intro: string;
  let subject: string;
  const details: string[] = [];

  if (data.change === 'moved') {
    intro = `${who} moved a booking made for you${at}.`;
    subject = `Booking moved: ${lead}now ${formatShortStart(data.startAt, zone)}`;
    details.push(
      `Was: ${formatWindow(data.previous.startAt, data.previous.endAt, zone)}`,
      `Now: ${when}`,
      ...resourceLines(data, data.previous),
    );
  } else if (data.series) {
    const { count, weekdays, intervalWeeks, lastStartAt } = data.series;
    const days = weekdayList(weekdays);
    const first = zoned(data.startAt, zone);
    const last = zoned(lastStartAt, zone);
    // Every booking in a series has the same length.
    const lastEndAt = new Date(lastStartAt.getTime() + (data.endAt.getTime() - data.startAt.getTime()));
    const clock = `${first.time}–${zoned(data.endAt, zone).time} ${
      first.zone === last.zone ? first.zone : `${first.zone}/${last.zone}`
    }`;
    const booked = data.change === 'booked';
    if (booked) {
      intro = `${who} set up a recurring booking for you${at}: ${plural(count, 'booking')}.`;
      subject = `Recurring booking for you: ${lead}${plural(count, 'booking')} from ${first.shortDate}`;
    } else {
      intro = `${who} cancelled a recurring booking made for you${at}: ${plural(count, 'upcoming booking')}.`;
      subject = `Recurring booking cancelled: ${lead}${plural(count, 'booking')} from ${first.shortDate}`;
    }
    if (days) {
      details.push(`Repeats: ${intervalWeeks > 1 ? `every ${intervalWeeks} weeks on ${days}` : `every ${days}`}, ${clock}`);
    }
    details.push(`${booked ? 'First' : 'From'}: ${when}`);
    if (count > 1) details.push(`${booked ? 'Last' : 'Through'}: ${formatWindow(lastStartAt, lastEndAt, zone)}`);
    details.push(...resourceLines(data));
  } else if (data.change === 'booked') {
    intro = `${who} booked this for you${at}.`;
    subject = `Booked for you: ${lead}${formatShortStart(data.startAt, zone)}`;
    details.push(`When: ${when}`, ...resourceLines(data));
  } else {
    intro = `${who} cancelled a booking made for you${at}.`;
    subject = `Booking cancelled: ${lead}${formatShortStart(data.startAt, zone)}`;
    details.push(`When: ${when}`, ...resourceLines(data));
  }

  const reason = data.change === 'cancelled' ? data.reason?.trim() : undefined;
  if (reason) details.push(`Reason: ${reason}`);

  const closing = `Questions about this booking? Contact ${orgName || 'your club'}.`;
  return {
    // A subject is one header line; operator-entered labels must not break it.
    subject: subject.replace(/[\r\n]+/g, ' '),
    text: `${intro}\n\n${details.join('\n')}\n\n${closing}\n`,
    html: wrapHtml([
      escapeHtml(intro),
      details.map((d) => escapeHtml(d)).join('<br>'),
      escapeHtml(closing),
    ]),
  };
}

function renderSquawkReported(data: SquawkReportedData): RenderedEmail {
  const text =
    `A squawk was recorded.\n\n` +
    `Title: ${data.title}\n` +
    `Severity: ${data.severity}\n\n` +
    `This is a record of the report you filed — it does not by itself ground the aircraft.`;
  return {
    subject: 'Squawk reported',
    text,
    html: wrapHtml([
      'A squawk was recorded.',
      `Title: ${data.title}`,
      `Severity: ${data.severity}`,
      'This is a record of the report you filed — it does not by itself ground the aircraft.',
    ]),
  };
}

function renderAircraftGrounded(data: AircraftGroundedData): RenderedEmail {
  const text =
    `An aircraft was grounded.\n\n` +
    `Reason: ${data.reason}\n\n` +
    `This reflects an operator record, not an FAA airworthiness determination.`;
  return {
    subject: 'Aircraft grounded',
    text,
    html: wrapHtml([
      'An aircraft was grounded.',
      `Reason: ${data.reason}`,
      'This reflects an operator record, not an FAA airworthiness determination.',
    ]),
  };
}

function renderMaintenanceDue(data: MaintenanceDueData): RenderedEmail {
  const lines = data.items.map((i) => `- ${i.title} (${i.status === 'overdue' ? 'overdue' : 'due soon'})`);
  const text =
    `Maintenance items need attention.\n\n` +
    `Overdue: ${data.overdueCount}\nDue soon: ${data.dueSoonCount}\n\n` +
    (lines.length > 0 ? `${lines.join('\n')}\n\n` : '') +
    `This reflects thresholds you set — it does not by itself determine airworthiness; a mechanic makes that call.`;
  return {
    subject: 'Maintenance items due',
    text,
    html: wrapHtml([
      'Maintenance items need attention.',
      `Overdue: ${data.overdueCount}`,
      `Due soon: ${data.dueSoonCount}`,
      ...lines,
      'This reflects thresholds you set — it does not by itself determine airworthiness; a mechanic makes that call.',
    ]),
  };
}

function renderOrgAnnouncement(data: OrgAnnouncementData): RenderedEmail {
  const footer = `— Sent by ${data.orgName} via AeroOps.`;
  const text = `${data.body}\n\n${footer}`;
  const escapedBodyHtml = escapeHtml(data.body).replace(/\n/g, '<br>');
  return {
    subject: data.subject,
    text,
    html: wrapHtml([escapedBodyHtml, escapeHtml(footer)]),
  };
}

/**
 * renderNotificationTemplate — dispatch to the per-event pure renderer.
 *
 * Generic over E so callers get the right TemplateData shape checked at the
 * call site (see send-notification.ts). The switch is exhaustive over
 * NotificationEventType — adding a new event type without a matching branch
 * here is a compile error (the `never` fallthrough).
 */
export function renderNotificationTemplate<E extends NotificationEventType>(
  eventType: E,
  data: NotificationTemplateDataMap[E],
): RenderedEmail {
  switch (eventType) {
    case 'reservation.created':
      return renderReservationCreated(data as ReservationCreatedData);
    case 'reservation.for_member':
      return renderReservationForMember(data as ReservationForMemberData);
    case 'squawk.reported':
      return renderSquawkReported(data as SquawkReportedData);
    case 'aircraft.grounded':
      return renderAircraftGrounded(data as AircraftGroundedData);
    case 'maintenance.due':
      return renderMaintenanceDue(data as MaintenanceDueData);
    case 'org.announcement':
      return renderOrgAnnouncement(data as OrgAnnouncementData);
    default: {
      const _exhaustive: never = eventType;
      throw new Error(`[notifications] unknown event type: ${String(_exhaustive)}`);
    }
  }
}
