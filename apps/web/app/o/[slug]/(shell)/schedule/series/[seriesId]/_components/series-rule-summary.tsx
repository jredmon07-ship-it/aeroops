/**
 * series-rule-summary.tsx — Displays the recurrence rule for a series.
 *
 * Renders: weekdays, interval, end rule (count | until), start time, duration,
 * timezone, and status badge.
 *
 * Pure presentational; no side effects.
 */
import { Badge } from '@/components/ui/badge';
import type { SeriesRow } from '@aeroops/api';

interface SeriesRuleSummaryProps {
  series: SeriesRow;
}

// ISO weekday names: 1=Monday … 7=Sunday
const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function weekdayName(n: number): string {
  return WEEKDAY_NAMES[(n - 1) % 7] ?? String(n);
}

/**
 * Format the end rule as a human-readable string.
 */
function formatEndRule(series: SeriesRow): string {
  const endKind = series.endKind ?? series.end_kind;
  if (endKind === 'count') {
    const count = series.count ?? null;
    return count ? `${count} occurrence${count === 1 ? '' : 's'}` : 'Unknown count';
  }
  if (endKind === 'until') {
    const until = series.untilDate ?? series.until_date;
    return until ? `Until ${until}` : 'Unknown date';
  }
  return 'Unknown';
}

/**
 * Format the interval as "Every week" or "Every N weeks".
 */
function formatInterval(intervalWeeks: number | undefined): string {
  const n = intervalWeeks ?? 1;
  return n === 1 ? 'Every week' : `Every ${n} weeks`;
}

export function SeriesRuleSummary({ series }: SeriesRuleSummaryProps) {
  const weekdays = series.weekdays ?? [];
  const localStartTime =
    series.localStartTime ?? series.local_start_time ?? '';
  const durationMinutes =
    series.durationMinutes ?? series.duration_minutes ?? 0;
  const intervalWeeks = series.intervalWeeks ?? series.interval_weeks ?? 1;
  const ianaTz = series.ianaTz ?? series.iana_tz ?? '';
  const status = series.status;

  const durationLabel =
    durationMinutes >= 60
      ? durationMinutes % 60 === 0
        ? `${durationMinutes / 60}h`
        : `${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}min`
      : `${durationMinutes} min`;

  return (
    <div
      className="rounded-md border border-border bg-white p-4 space-y-3"
      aria-label="Series rule summary"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">Recurrence Rule</h2>
        <Badge
          variant={status === 'active' ? 'default' : 'secondary'}
          aria-label={`Series status: ${status}`}
        >
          {status === 'active' ? 'Active' : 'Cancelled'}
        </Badge>
      </div>

      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div>
          <dt className="text-slate-500 font-medium">Days</dt>
          <dd className="text-slate-900">
            {weekdays.length > 0
              ? weekdays.map(weekdayName).join(', ')
              : 'None'}
          </dd>
        </div>

        <div>
          <dt className="text-slate-500 font-medium">Interval</dt>
          <dd className="text-slate-900">{formatInterval(intervalWeeks)}</dd>
        </div>

        <div>
          <dt className="text-slate-500 font-medium">Start time</dt>
          <dd className="text-slate-900 font-mono">{localStartTime || '—'}</dd>
        </div>

        <div>
          <dt className="text-slate-500 font-medium">Duration</dt>
          <dd className="text-slate-900">{durationLabel}</dd>
        </div>

        <div>
          <dt className="text-slate-500 font-medium">End rule</dt>
          <dd className="text-slate-900">{formatEndRule(series)}</dd>
        </div>

        <div>
          <dt className="text-slate-500 font-medium">Timezone</dt>
          <dd className="text-slate-900 truncate">{ianaTz || '—'}</dd>
        </div>
      </dl>

      {series.notes && (
        <div className="pt-1 border-t border-border text-sm">
          <span className="text-slate-500 font-medium">Notes: </span>
          <span className="text-slate-700">{series.notes}</span>
        </div>
      )}
    </div>
  );
}
