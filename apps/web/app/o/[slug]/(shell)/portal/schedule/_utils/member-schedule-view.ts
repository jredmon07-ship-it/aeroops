/**
 * portal/schedule/_utils/member-schedule-view.ts — the member Schedule's day
 * view model: listMemberAvailability's result → one row per aircraft and per
 * instructor, each listing that day's taken times as people read them.
 *
 *   someone else's booking → "Booked"        (the API says when, never who)
 *   a blackout             → "Unavailable"
 *   the member's own       → "Your booking"  + its notes + "with …" the
 *                            booking's other resources (tail # / instructor)
 *
 * Free time is what is left: a row lists only the taken times.
 *
 * Times read in the VIEWER's zone (the page resolves it once with
 * getViewerTimeZone) on the schedule's 24-hour clock (formatTimeRange). An
 * interval that runs past either edge of the day keeps its real times, with
 * the date on the side that is not the viewed day: "Nov 9 23:00 – 01:00".
 *
 * Rows: aircraft first, by tail # (natural order: N2 before N10), then
 * instructors by name. Intervals: by start, then end.
 *
 * PURE: no DOM, no Next.js, no I/O. Unit tests:
 * apps/web/lib/__tests__/member-schedule-view.test.ts.
 */
import type {
  MemberAvailabilityInterval,
  MemberAvailabilityResource,
  MemberAvailabilityResult,
} from '@aeroops/api';
import { formatInZone } from '@/lib/zoned-format';
import { formatTime, formatTimeRange } from '../../../schedule/_utils/format-time';

// ─── Types ────────────────────────────────────────────────────────────────────

/** The day's half-open [from, to) window (lib/schedule-day.ts dayWindow). */
export interface DayWindow {
  from: Date;
  to: Date;
}

export type MemberScheduleIntervalKind = 'mine' | 'booked' | 'unavailable';

export interface MemberScheduleIntervalView {
  /** Stable React key. */
  key: string;
  kind: MemberScheduleIntervalKind;
  /** "Your booking" | "Booked" | "Unavailable". */
  label: string;
  /** "09:00 – 11:00", or with a date on a side outside the day. */
  time: string;
  /** Your booking only: its notes (trimmed); null otherwise. */
  notes: string | null;
  /** Your booking only: the booking's OTHER resources, e.g. the instructor. */
  withLabels: string[];
}

export interface MemberScheduleRowView {
  resourceId: string;
  kind: 'aircraft' | 'instructor';
  /** The tail # of an aircraft, the name of an instructor. */
  title: string;
  /** An aircraft's make + model ("Cessna 172S"), else null. */
  detail: string | null;
  /** Operator grounding state (aircraft only) — data, not a determination. */
  grounded: boolean;
  intervals: MemberScheduleIntervalView[];
}

export interface MemberScheduleView {
  aircraft: MemberScheduleRowView[];
  instructors: MemberScheduleRowView[];
  /** true when no row has anything that day (rows may still exist). */
  nothingBooked: boolean;
}

// ─── Labels ───────────────────────────────────────────────────────────────────

const KIND_ORDER: Record<MemberScheduleIntervalKind, number> = { mine: 0, booked: 1, unavailable: 2 };

const LABELS: Record<MemberScheduleIntervalKind, string> = {
  mine: 'Your booking',
  booked: 'Booked',
  unavailable: 'Unavailable',
};

/** What an interval is, for the member: theirs, someone's booking, or blocked out. */
export function intervalKind(interval: MemberAvailabilityInterval): MemberScheduleIntervalKind {
  if (interval.mine === true) return 'mine';
  return interval.kind === 'unavailable' ? 'unavailable' : 'booked';
}

/** "Your booking" | "Booked" | "Unavailable". */
export function intervalLabel(interval: MemberAvailabilityInterval): string {
  return LABELS[intervalKind(interval)];
}

/** An aircraft's make + model, e.g. "Cessna 172S"; null when neither is on file. */
export function aircraftDetail(make: string | null, model: string | null): string | null {
  const text = [make, model]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(' ');
  return text === '' ? null : text;
}

// ─── Times ────────────────────────────────────────────────────────────────────

const MONTH_DAY: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };

function sideText(instant: Date, outsideDay: boolean, timeZone: string): string {
  const clock = formatTime(instant, timeZone);
  return outsideDay ? `${formatInZone(instant, timeZone, MONTH_DAY)} ${clock}` : clock;
}

/**
 * intervalTimeText — "09:00 – 11:00" in `timeZone`. A start before the day or
 * an end after it carries its date ("Nov 9 23:00 – 01:00"), so a booking
 * running over midnight never reads as a backwards range. An end exactly at
 * the next midnight is still this day's ("22:00 – 00:00").
 */
export function intervalTimeText(
  startAt: Date,
  endAt: Date,
  day: DayWindow,
  timeZone: string,
): string {
  const startsBefore = startAt.getTime() < day.from.getTime();
  const endsAfter = endAt.getTime() > day.to.getTime();
  if (!startsBefore && !endsAfter) return formatTimeRange(startAt, endAt, timeZone);
  return `${sideText(startAt, startsBefore, timeZone)} – ${sideText(endAt, endsAfter, timeZone)}`;
}

// ─── Sorting ──────────────────────────────────────────────────────────────────

function compareText(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

function compareRows(a: MemberScheduleRowView, b: MemberScheduleRowView): number {
  const byTitle = compareText(a.title, b.title);
  if (byTitle !== 0) return byTitle;
  return a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0;
}

function compareIntervals(a: MemberAvailabilityInterval, b: MemberAvailabilityInterval): number {
  const byStart = a.startAt.getTime() - b.startAt.getTime();
  if (byStart !== 0) return byStart;
  const byEnd = a.endAt.getTime() - b.endAt.getTime();
  if (byEnd !== 0) return byEnd;
  return KIND_ORDER[intervalKind(a)] - KIND_ORDER[intervalKind(b)];
}

// ─── Build ────────────────────────────────────────────────────────────────────

function toIntervalView(
  interval: MemberAvailabilityInterval,
  rowTitle: string,
  day: DayWindow,
  timeZone: string,
  index: number,
): MemberScheduleIntervalView {
  const kind = intervalKind(interval);
  const mine = interval.mine === true ? interval : null;
  const trimmedNotes = mine?.notes?.trim() ?? '';
  const notes = trimmedNotes === '' ? null : trimmedNotes;
  return {
    key: `${interval.resourceId}:${kind}:${interval.startAt.getTime()}:${interval.endAt.getTime()}:${index}`,
    kind,
    label: LABELS[kind],
    time: intervalTimeText(interval.startAt, interval.endAt, day, timeZone),
    notes,
    withLabels: mine ? mine.resourceLabels.filter((label) => label !== rowTitle) : [],
  };
}

function toRowView(
  resource: MemberAvailabilityResource,
  intervals: MemberAvailabilityInterval[],
  day: DayWindow,
  timeZone: string,
): MemberScheduleRowView {
  const sorted = [...intervals].sort(compareIntervals);
  return {
    resourceId: resource.id,
    kind: resource.kind,
    title: resource.label,
    detail: resource.kind === 'aircraft' ? aircraftDetail(resource.make, resource.model) : null,
    grounded: resource.kind === 'aircraft' && resource.grounded,
    intervals: sorted.map((interval, i) => toIntervalView(interval, resource.label, day, timeZone, i)),
  };
}

/**
 * buildMemberScheduleView — the day's rows. Intervals that do not overlap the
 * day (half-open) or name a resource not listed are dropped, so the page can
 * never show a stray block.
 */
export function buildMemberScheduleView(
  result: MemberAvailabilityResult,
  day: DayWindow,
  timeZone: string,
): MemberScheduleView {
  const byResource = new Map<string, MemberAvailabilityInterval[]>();
  for (const interval of result.intervals) {
    const overlaps =
      interval.startAt.getTime() < day.to.getTime() && interval.endAt.getTime() > day.from.getTime();
    if (!overlaps) continue;
    const list = byResource.get(interval.resourceId) ?? [];
    list.push(interval);
    byResource.set(interval.resourceId, list);
  }

  const rows = result.resources.map((resource) =>
    toRowView(resource, byResource.get(resource.id) ?? [], day, timeZone),
  );
  const aircraft = rows.filter((row) => row.kind === 'aircraft').sort(compareRows);
  const instructors = rows.filter((row) => row.kind === 'instructor').sort(compareRows);

  return {
    aircraft,
    instructors,
    nothingBooked: rows.every((row) => row.intervals.length === 0),
  };
}
