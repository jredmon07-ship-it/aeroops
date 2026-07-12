/**
 * month-view.tsx — Month calendar view for /schedule (?view=month).
 *
 * Flight-Circle-style month grid: 7-column weeks, up to 4 reservation chips
 * per day (start time · tail/resource · booked-by short name), "+N more" →
 * the existing day board. Chips are colored per PRIMARY resource via a stable
 * hash into a fixed Tailwind palette (same resource → same color forever).
 *
 * Data flow: RSC page fetches the padded-month reservation window via
 * listReservationsAction (org-scoped, cancelled excluded by default) and
 * passes serialized rows down. This component renders only — no fetching.
 *
 * a11y:
 *   - role=grid / row / columnheader / gridcell semantics.
 *   - Roving tabindex + arrow-key navigation between day cells; Enter/Space
 *     opens that day on the board.
 *   - Every chip is a Link with a full aria-label (time, resource, pilot, date).
 *   - Today carries aria-current="date" + a visual ring.
 *
 * Responsive: the 7-col grid renders from md: up; below md it collapses to a
 * stacked week list (weeks as sections, only days with reservations shown).
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  buildMonthGrid,
  addMonthsClamped,
  formatMonthParam,
  monthLabel,
  groupByStartDay,
  paletteIndex,
  shortName,
  type MonthDayCell,
} from '@/lib/month-grid';
import { formatTime, formatDate, parseDateParam } from '../_utils/format-time';
import { buildResourceMap, sortResourceIds } from '../_utils/resource-map';
import type { ReservationRow, ResourceRow } from '@aeroops/api';

// ─── Chip palette ─────────────────────────────────────────────────────────────
// Full literal class strings so Tailwind's scanner keeps them. Index chosen by
// stable hash of the primary resource id (lib/month-grid.ts paletteIndex).

const CHIP_PALETTE = [
  'bg-sky-100 text-sky-900 border-sky-200 hover:bg-sky-200',
  'bg-emerald-100 text-emerald-900 border-emerald-200 hover:bg-emerald-200',
  'bg-amber-100 text-amber-900 border-amber-200 hover:bg-amber-200',
  'bg-violet-100 text-violet-900 border-violet-200 hover:bg-violet-200',
  'bg-rose-100 text-rose-900 border-rose-200 hover:bg-rose-200',
  'bg-teal-100 text-teal-900 border-teal-200 hover:bg-teal-200',
  'bg-indigo-100 text-indigo-900 border-indigo-200 hover:bg-indigo-200',
  'bg-orange-100 text-orange-900 border-orange-200 hover:bg-orange-200',
] as const;

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const MAX_CHIPS_PER_DAY = 4;

// ─── Props ────────────────────────────────────────────────────────────────────

interface MonthViewProps {
  slug: string;
  year: number;
  /** 1–12. */
  month: number;
  /** "YYYY-MM-DD" of today, computed once server-side (avoids hydration drift). */
  todayIso: string;
  reservations: ReservationRow[];
  resources: ResourceRow[];
  /**
   * [userId, displayName] pairs for booked-by names. May be EMPTY when the
   * viewer lacks schedule:manage_resources (member list fails closed) — chips
   * then omit the booked-by segment. Serializable array (not a Map) so the
   * RSC boundary can pass it through.
   */
  memberNames: Array<[string, string]>;
  error?: boolean;
}

// ─── Chip helpers ─────────────────────────────────────────────────────────────

interface ChipInfo {
  /** Primary resource id (aircraft first) — drives the color. */
  primaryResourceId: string | null;
  /** Tail # for aircraft when present, else display name, else fallback. */
  resourceLabel: string;
  colorClass: string;
}

function chipInfoFor(
  reservation: ReservationRow,
  resourceMap: Map<string, ResourceRow>,
): ChipInfo {
  const sorted = sortResourceIds(reservation.resourceIds, resourceMap);
  const primaryId = sorted[0] ?? null;
  const primary = primaryId ? resourceMap.get(primaryId) : undefined;
  const resourceLabel = primary
    ? primary.kind === 'aircraft' && primary.tailNumber
      ? primary.tailNumber
      : primary.displayName
    : 'Unknown resource';
  const colorClass = primaryId
    ? CHIP_PALETTE[paletteIndex(primaryId, CHIP_PALETTE.length)]!
    : 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200';
  return { primaryResourceId: primaryId, resourceLabel, colorClass };
}

// ─── Reservation chip ─────────────────────────────────────────────────────────

interface ReservationChipProps {
  reservation: ReservationRow;
  resourceMap: Map<string, ResourceRow>;
  memberNameById: Map<string, string>;
  boardHref: string;
  dayLabel: string;
}

function ReservationChip({
  reservation,
  resourceMap,
  memberNameById,
  boardHref,
  dayLabel,
}: ReservationChipProps) {
  const { resourceLabel, colorClass } = chipInfoFor(reservation, resourceMap);
  const time = formatTime(reservation.startAt);
  const bookedBy = memberNameById.get(reservation.createdBy);
  const bookedByShort = bookedBy ? shortName(bookedBy) : null;

  const ariaLabel = `${time} ${resourceLabel}${
    bookedBy ? `, booked by ${bookedBy}` : ''
  }, ${dayLabel} — open day board`;

  return (
    <Link
      href={boardHref}
      aria-label={ariaLabel}
      className={`block truncate rounded-sm border px-1 py-0.5 text-[0.6875rem] leading-4 font-medium ${colorClass}`}
    >
      <span className="font-mono">{time}</span> {resourceLabel}
      {bookedByShort ? <span className="font-normal"> · {bookedByShort}</span> : null}
    </Link>
  );
}

// ─── Month view ───────────────────────────────────────────────────────────────

export function MonthView({
  slug,
  year,
  month,
  todayIso,
  reservations,
  resources,
  memberNames,
  error,
}: MonthViewProps) {
  const router = useRouter();
  const basePath = `/o/${slug}/schedule`;
  const boardPath = `/o/${slug}/schedule/board`;

  const grid = React.useMemo(() => buildMonthGrid(year, month), [year, month]);
  const resourceMap = React.useMemo(() => buildResourceMap(resources), [resources]);
  const memberNameById = React.useMemo(() => new Map(memberNames), [memberNames]);
  const byDay = React.useMemo(
    () => groupByStartDay(reservations, (r) => r.startAt),
    [reservations],
  );

  const label = monthLabel(year, month);
  const flatCells = React.useMemo(() => grid.weeks.flat(), [grid]);

  // `todayIso` is computed server-side (UTC on Vercel), but the chips and their
  // times render in the VIEWER's local tz (groupByStartDay + formatTime). A
  // server-UTC "today" therefore rings the wrong cell for users west of UTC in
  // the evening. Recompute today in the viewer's local tz AFTER mount so the
  // ring matches the local basis everything else uses. Server + first client
  // render still use the passed value → no hydration mismatch.
  const [localTodayIso, setLocalTodayIso] = React.useState<string | null>(null);
  React.useEffect(() => {
    const d = new Date();
    setLocalTodayIso(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate(),
      ).padStart(2, '0')}`,
    );
  }, []);
  const effectiveTodayIso = localTodayIso ?? todayIso;

  // ── Roving tabindex for grid keyboard navigation ──────────────────────────
  const initialFocusIso = flatCells.some((c) => c.iso === todayIso && c.inMonth)
    ? todayIso
    : grid.firstOfMonthIso;
  const [focusIso, setFocusIso] = React.useState(initialFocusIso);
  const cellRefs = React.useRef(new Map<string, HTMLDivElement>());

  // Month changed → reset the roving focus target.
  React.useEffect(() => {
    setFocusIso(initialFocusIso);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month]);

  const navigateMonth = React.useCallback(
    (y: number, m: number) => {
      router.push(`${basePath}?view=month&month=${formatMonthParam(y, m)}`);
    },
    [router, basePath],
  );

  const moveFocus = React.useCallback(
    (delta: number) => {
      const idx = flatCells.findIndex((c) => c.iso === focusIso);
      if (idx === -1) return;
      const next = idx + delta;
      if (next < 0 || next >= flatCells.length) return; // stay within the grid
      const nextIso = flatCells[next]!.iso;
      setFocusIso(nextIso);
      cellRefs.current.get(nextIso)?.focus();
    },
    [flatCells, focusIso],
  );

  const handleGridKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Only handle keys when a gridcell itself is focused (not an inner chip
      // link — those keep their native behavior).
      const target = e.target as HTMLElement;
      if (target.getAttribute('role') !== 'gridcell') return;
      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          moveFocus(-1);
          break;
        case 'ArrowRight':
          e.preventDefault();
          moveFocus(1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          moveFocus(-7);
          break;
        case 'ArrowDown':
          e.preventDefault();
          moveFocus(7);
          break;
        case 'Enter':
        case ' ':
          e.preventDefault();
          router.push(`${boardPath}?date=${focusIso}`);
          break;
        default:
          break;
      }
    },
    [moveFocus, router, boardPath, focusIso],
  );

  // Clamped so a boundary month (1970-01 / 9999-12) whose true neighbor is
  // unrepresentable doesn't throw a RangeError during render (parseMonthParam
  // accepts those months).
  const prev = addMonthsClamped(year, month, -1);
  const next = addMonthsClamped(year, month, 1);
  const todayMonthParam = todayIso.slice(0, 7); // "YYYY-MM"

  const dayLabelFor = React.useCallback((iso: string) => {
    const d = parseDateParam(iso);
    return d ? formatDate(d) : iso;
  }, []);

  const isEmpty = !error && reservations.length === 0;

  // ── Day-cell renderer (shared shape between grid + notes below) ───────────
  function renderDayChips(cell: MonthDayCell, limit: number) {
    const dayReservations = byDay.get(cell.iso) ?? [];
    const visible = dayReservations.slice(0, limit);
    const overflow = dayReservations.length - visible.length;
    const dayLabel = dayLabelFor(cell.iso);
    return (
      <>
        {visible.map((r) => (
          <ReservationChip
            key={r.id}
            reservation={r}
            resourceMap={resourceMap}
            memberNameById={memberNameById}
            boardHref={`${boardPath}?date=${cell.iso}`}
            dayLabel={dayLabel}
          />
        ))}
        {overflow > 0 && (
          <Link
            href={`${boardPath}?date=${cell.iso}`}
            aria-label={`${overflow} more reservation${overflow === 1 ? '' : 's'} on ${dayLabel} — open day board`}
            className="block truncate rounded-sm px-1 py-0.5 text-[0.6875rem] leading-4 font-medium text-brand hover:underline"
          >
            +{overflow} more
          </Link>
        )}
      </>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Month navigation toolbar ─────────────────────────────────────── */}
      <div
        role="toolbar"
        aria-label="Month navigation"
        className="flex flex-wrap items-center gap-2"
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigateMonth(prev.year, prev.month)}
          aria-label="Previous month"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => router.push(`${basePath}?view=month&month=${todayMonthParam}`)}
          aria-label="Go to current month"
        >
          Today
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigateMonth(next.year, next.month)}
          aria-label="Next month"
        >
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
        <output aria-live="polite" className="ml-2 text-sm font-medium text-slate-700">
          {label}
        </output>
      </div>

      {/* ── Error state ──────────────────────────────────────────────────── */}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            Could not load reservations for {label}. Try refreshing the page.
          </AlertDescription>
        </Alert>
      )}

      {/* ── Empty month — friendly state (grid still renders below on md+) ── */}
      {isEmpty && (
        <div className="flex flex-col items-center justify-center rounded-md border border-slate-200 bg-white py-8 text-center space-y-2">
          <Calendar className="h-8 w-8 text-slate-300" aria-hidden="true" />
          <p className="text-slate-600">No reservations in {label}.</p>
          <p className="text-sm text-slate-500">
            Pick a day on the calendar to open its board, or book from{' '}
            <Link
              href={`${basePath}/new?date=${grid.firstOfMonthIso}`}
              className="text-brand underline hover:no-underline"
            >
              + New Reservation
            </Link>
            .
          </p>
        </div>
      )}

      {/* ── Desktop / tablet: 7-column month grid (md and up) ───────────── */}
      {!error && (
        <div
          role="grid"
          aria-label={`Month calendar, ${label}`}
          className="hidden md:block rounded-md border border-slate-200 bg-white shadow-sm overflow-hidden"
          onKeyDown={handleGridKeyDown}
        >
          {/* Weekday header */}
          <div role="row" className="grid grid-cols-7 border-b border-slate-200 bg-slate-50">
            {WEEKDAY_LABELS.map((d) => (
              <div
                key={d}
                role="columnheader"
                className="px-2 py-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                {d}
              </div>
            ))}
          </div>

          {/* Week rows */}
          {grid.weeks.map((week, wi) => (
            <div
              key={week[0]!.iso}
              role="row"
              className={`grid grid-cols-7 ${wi > 0 ? 'border-t border-slate-200' : ''}`}
            >
              {week.map((cell, ci) => {
                const isToday = cell.iso === effectiveTodayIso;
                const count = byDay.get(cell.iso)?.length ?? 0;
                return (
                  <div
                    key={cell.iso}
                    role="gridcell"
                    ref={(el) => {
                      if (el) cellRefs.current.set(cell.iso, el);
                      else cellRefs.current.delete(cell.iso);
                    }}
                    tabIndex={cell.iso === focusIso ? 0 : -1}
                    onFocus={() => setFocusIso(cell.iso)}
                    aria-current={isToday ? 'date' : undefined}
                    aria-label={`${dayLabelFor(cell.iso)}, ${count} reservation${count === 1 ? '' : 's'}`}
                    className={`min-h-[6.5rem] space-y-0.5 p-1 align-top focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset ${
                      ci > 0 ? 'border-l border-slate-200' : ''
                    } ${cell.inMonth ? 'bg-white' : 'bg-slate-50'} ${
                      isToday ? 'ring-2 ring-inset ring-brand/60' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between px-0.5">
                      <span
                        className={`text-xs font-medium ${
                          cell.inMonth
                            ? isToday
                              ? 'inline-flex h-5 w-5 items-center justify-center rounded-full bg-brand text-white'
                              : 'text-slate-700'
                            : 'text-slate-400'
                        }`}
                      >
                        {cell.day}
                      </span>
                    </div>
                    {renderDayChips(cell, MAX_CHIPS_PER_DAY)}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {/* ── Mobile: stacked week list (below md) ─────────────────────────── */}
      {!error && !isEmpty && (
        <div className="md:hidden space-y-4" aria-label={`Month calendar as list, ${label}`}>
          {grid.weeks.map((week) => {
            const daysWithReservations = week.filter(
              (c) => c.inMonth && (byDay.get(c.iso)?.length ?? 0) > 0,
            );
            if (daysWithReservations.length === 0) return null;
            return (
              <section key={week[0]!.iso} aria-label={`Week of ${dayLabelFor(week[0]!.iso)}`}>
                <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Week of {dayLabelFor(week[0]!.iso)}
                </h3>
                <div className="space-y-2">
                  {daysWithReservations.map((cell) => {
                    const isToday = cell.iso === effectiveTodayIso;
                    return (
                      <div
                        key={cell.iso}
                        className={`rounded-md border bg-white p-2 shadow-sm space-y-1 ${
                          isToday ? 'border-brand/60 ring-1 ring-brand/40' : 'border-slate-200'
                        }`}
                      >
                        <Link
                          href={`${boardPath}?date=${cell.iso}`}
                          className="text-sm font-medium text-slate-900 hover:underline"
                          aria-label={`${dayLabelFor(cell.iso)} — open day board`}
                        >
                          {dayLabelFor(cell.iso)}
                          {isToday ? (
                            <span className="ml-1.5 text-xs font-semibold text-brand">Today</span>
                          ) : null}
                        </Link>
                        <div className="space-y-0.5">{renderDayChips(cell, MAX_CHIPS_PER_DAY)}</div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
