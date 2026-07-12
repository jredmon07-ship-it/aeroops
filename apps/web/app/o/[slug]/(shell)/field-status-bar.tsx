/**
 * field-status-bar.tsx — slim fixed bottom ops status bar (client component).
 *
 * Shows on every shell screen (mounted once in (shell)/layout.tsx):
 *   sunrise/sunset (local) · day/night indicator · local + Zulu ticking clocks
 *   · station + temp + wind + flight-category chip (VFR green / MVFR blue /
 *   IFR red / LIFR magenta — the palette FC users know).
 *
 * DEGRADES, NEVER ERRORS: when weather/sun data is unavailable the bar renders
 * just the clocks — there is no error state, no retry, no spinner.
 *
 * A11y: semantic <footer role="contentinfo">; the ticking clocks region is
 * aria-live="off" (purely decorative — a screen reader must not announce
 * every tick).
 *
 * COMPLIANCE (verbatim, also in the title tooltip): Advisory display only —
 * not a weather briefing; verify with official sources.
 */
'use client';

import * as React from 'react';
import { Sun, Moon, Sunrise, Sunset, Wind, Thermometer } from 'lucide-react';
import type { OrgFieldStatusResult, FlightCategory } from '@aeroops/api';

const DISCLAIMER =
  'Advisory display only — not a weather briefing; verify with official sources.';

// ─── Category chip (FC palette: VFR green / MVFR blue / IFR red / LIFR magenta) ─

const CATEGORY_CLS: Record<Exclude<FlightCategory, 'UNKNOWN'>, string> = {
  VFR: 'border-green-300 dark:border-green-800 bg-green-100 dark:bg-green-950/50 text-green-900 dark:text-green-200 dark:border-green-500/30 dark:bg-green-500/15 dark:text-green-300',
  MVFR: 'border-blue-300 dark:border-blue-800 bg-blue-100 dark:bg-blue-950/50 text-blue-900 dark:text-blue-200 dark:border-blue-500/30 dark:bg-blue-500/15 dark:text-blue-300',
  IFR: 'border-red-300 dark:border-red-800 bg-red-100 dark:bg-red-950/50 text-red-900 dark:text-red-200 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-300',
  LIFR: 'border-fuchsia-300 dark:border-fuchsia-800 bg-fuchsia-100 dark:bg-fuchsia-950/50 text-fuchsia-900 dark:text-fuchsia-200 dark:border-fuchsia-500/30 dark:bg-fuchsia-500/15 dark:text-fuchsia-300',
};

function CategoryChip({ category }: { category: FlightCategory }) {
  if (category === 'UNKNOWN') return null;
  return (
    <span
      className={`inline-flex items-center rounded-sm border px-1.5 py-px text-[0.6875rem] font-bold leading-4 tracking-wide ${CATEGORY_CLS[category]}`}
    >
      {category}
    </span>
  );
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function localHm(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatWind(dirDeg: number | null, kt: number | null, gustKt: number | null): string | null {
  if (kt === null) return null;
  if (kt === 0) return 'Calm';
  const dir = dirDeg !== null ? `${String(dirDeg).padStart(3, '0')}°` : 'VRB';
  const gust = gustKt !== null ? `G${gustKt}` : '';
  return `${dir} ${kt}${gust} kt`;
}

// ─── Component ────────────────────────────────────────────────────────────────

interface FieldStatusBarProps {
  status: OrgFieldStatusResult | null;
}

export function FieldStatusBar({ status }: FieldStatusBarProps) {
  // Clocks tick client-side only — render placeholders until mounted so the
  // server and first client render match (no hydration mismatch).
  const [now, setNow] = React.useState<Date | null>(null);
  React.useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const data = status && status.available ? status : null;

  // localHm() formats with the browser's timezone, so it MUST NOT run during
  // SSR / first client render (server TZ=UTC would mismatch the client and
  // trip a hydration error). Gate it on the same post-mount `now` flag the
  // clocks + day/night icon use — placeholders (nothing) until mounted.
  const sunrise = now ? localHm(data?.sunriseUtc ?? null) : null;
  const sunset = now ? localHm(data?.sunsetUtc ?? null) : null;

  // Day/night indicator — pure display: between sunrise and sunset = day.
  let isDay: boolean | null = null;
  if (now && data?.sunriseUtc && data.sunsetUtc) {
    const t = now.getTime();
    isDay = t >= new Date(data.sunriseUtc).getTime() && t < new Date(data.sunsetUtc).getTime();
  }

  const localClock = now
    ? `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
    : '--:--:--';
  const zuluClock = now
    ? `${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}Z`
    : '----Z';

  const wind = formatWind(data?.windDirDeg ?? null, data?.windKt ?? null, data?.gustKt ?? null);

  return (
    <footer
      role="contentinfo"
      aria-label="Field status"
      title={DISCLAIMER}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/85 dark:border-slate-800 dark:bg-slate-900/95 dark:supports-[backdrop-filter]:bg-slate-900/85"
    >
      <div
        aria-live="off"
        className="flex h-9 w-full items-center gap-x-4 overflow-x-auto whitespace-nowrap px-4 text-xs text-slate-600 dark:text-slate-300 sm:px-6 dark:text-slate-400"
      >
        {/* Day/night + sunrise/sunset (local) */}
        {data && (sunrise || sunset) && (
          <span className="inline-flex items-center gap-2.5">
            {isDay !== null &&
              (isDay ? (
                <Sun className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" aria-label="Daytime" />
              ) : (
                <Moon className="h-3.5 w-3.5 text-indigo-400 dark:text-indigo-300" aria-label="Nighttime" />
              ))}
            {sunrise && (
              <span className="inline-flex items-center gap-1">
                <Sunrise className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" aria-hidden="true" />
                <span className="nums">{sunrise}</span>
              </span>
            )}
            {sunset && (
              <span className="inline-flex items-center gap-1">
                <Sunset className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" aria-hidden="true" />
                <span className="nums">{sunset}</span>
              </span>
            )}
          </span>
        )}

        {/* Local + Zulu clocks — always shown, even with no weather data */}
        <span className="inline-flex items-center gap-2 font-mono text-slate-700 dark:text-slate-300">
          <span className="nums">{localClock}</span>
          <span className="text-slate-300 dark:text-slate-600" aria-hidden="true">
            ·
          </span>
          <span className="nums font-semibold">{zuluClock}</span>
        </span>

        {/* Spacer */}
        <span className="flex-1" aria-hidden="true" />

        {/* Station weather — omitted entirely when unavailable (never an error) */}
        {data && data.stationId && (
          <span className="inline-flex items-center gap-2.5">
            <span className="font-mono font-semibold text-slate-700 dark:text-slate-300">{data.stationId}</span>
            {data.tempC !== null && (
              <span className="inline-flex items-center gap-1">
                <Thermometer className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" aria-hidden="true" />
                <span className="nums">{data.tempC}°C</span>
              </span>
            )}
            {wind && (
              <span className="inline-flex items-center gap-1">
                <Wind className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" aria-hidden="true" />
                <span className="nums">{wind}</span>
              </span>
            )}
            {data.flightCategory && <CategoryChip category={data.flightCategory} />}
          </span>
        )}
      </div>
    </footer>
  );
}
