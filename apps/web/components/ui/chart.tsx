/**
 * chart.tsx — lightweight, dependency-free, theme-aware chart primitives.
 *
 * Why hand-rolled instead of a chart library: these render inside React Server
 * Components (the ops dashboard + reporting hub are RSC), carry zero runtime JS,
 * and inherit the app's HSL design tokens so they track light/dark automatically.
 * They are presentational only — no hooks, no 'use client'.
 *
 * Accessibility: each chart is a <figure role="group"> with an aria-label
 * summary PLUS a visually-hidden <table> of the underlying data, so screen
 * readers get the numbers, not just "chart". Native `title` gives sighted users
 * a hover readout with no JS.
 *
 * Colors are passed as CSS color strings (e.g. 'hsl(var(--color-brand))') so a
 * caller opts into the token that should drive each series; dark-mode tracking
 * comes for free because the token itself flips.
 */
import * as React from 'react';

// ─── BarTrend: grouped column chart (1–2 series over time) ───────────────────

export interface BarTrendSeries {
  label: string;
  /** Any CSS color; prefer a token, e.g. 'hsl(var(--color-brand))'. */
  color: string;
  values: number[];
}

export interface BarTrendProps {
  /** X-axis category labels, one per bar group (already short-formatted). */
  categories: string[];
  /** One or two series. Every series MUST have values.length === categories.length. */
  series: BarTrendSeries[];
  /** Plot height in px (excludes legend + axis labels). Default 176. */
  height?: number;
  /** Formats a value for the hover title + sr-only table. Default: String. */
  valueLabel?: (v: number) => string;
  /** Required: a one-line summary a screen reader hears in place of the bars. */
  ariaLabel: string;
  /** Copy shown when every value across every series is 0. */
  emptyLabel?: string;
  /** Cap the number of visible x-axis labels; others render blank to keep spacing. */
  maxLabels?: number;
  className?: string;
}

function niceMax(raw: number): number {
  if (raw <= 0) return 1;
  // Round the axis ceiling up to a friendly number so bars don't touch the top.
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

export function BarTrend({
  categories,
  series,
  height = 176,
  valueLabel = (v) => String(v),
  ariaLabel,
  emptyLabel = 'No activity in this period.',
  maxLabels = 8,
  className,
}: BarTrendProps) {
  const allValues = series.flatMap((s) => s.values);
  const rawMax = allValues.length ? Math.max(...allValues) : 0;
  const isEmpty = rawMax <= 0;
  const max = niceMax(rawMax);

  const labelStep = Math.max(1, Math.ceil(categories.length / maxLabels));

  return (
    <figure
      role="group"
      aria-label={ariaLabel}
      className={['m-0', className].filter(Boolean).join(' ')}
    >
      {/* Legend (only meaningful with ≥2 series) */}
      {series.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1" aria-hidden="true">
          {series.map((s) => (
            <span key={s.label} className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
              <span className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ backgroundColor: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}

      {isEmpty ? (
        <div
          className="flex items-center justify-center rounded-md border border-dashed border-slate-200 dark:border-slate-800 text-sm text-slate-400 dark:text-slate-500"
          style={{ height }}
        >
          {emptyLabel}
        </div>
      ) : (
        <div className="relative" style={{ height }} aria-hidden="true">
          {/* Gridlines + y ceiling label */}
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <div
              key={f}
              className="absolute inset-x-0 border-t border-slate-100 dark:border-slate-800/70"
              style={{ bottom: `${f * 100}%` }}
            />
          ))}
          <span className="absolute -top-2 left-0 -translate-y-full text-[0.625rem] tabular-nums text-slate-300 dark:text-slate-600 hidden">
            {valueLabel(max)}
          </span>

          {/* Bars */}
          <div className="absolute inset-0 flex items-end gap-px sm:gap-0.5">
            {categories.map((cat, i) => (
              <div key={i} className="flex h-full min-w-0 flex-1 items-end justify-center gap-[2px]">
                {series.map((s) => {
                  const v = s.values[i] ?? 0;
                  const pct = v > 0 ? Math.max(2, (v / max) * 100) : 0;
                  return (
                    <div
                      key={s.label}
                      className="w-full max-w-[18px] rounded-t-[3px] transition-[height]"
                      style={{ height: `${pct}%`, backgroundColor: v > 0 ? s.color : 'transparent' }}
                      title={`${cat} · ${s.label}: ${valueLabel(v)}`}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* X-axis labels (thinned to maxLabels) */}
      <div className="mt-2 flex gap-px sm:gap-0.5" aria-hidden="true">
        {categories.map((cat, i) => (
          <div
            key={i}
            className="min-w-0 flex-1 truncate text-center text-[0.625rem] leading-tight text-slate-400 dark:text-slate-500"
          >
            {i % labelStep === 0 ? cat : ''}
          </div>
        ))}
      </div>

      {/* Screen-reader data table */}
      <figcaption className="sr-only">
        <table>
          <thead>
            <tr>
              <th>Period</th>
              {series.map((s) => (
                <th key={s.label}>{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((cat, i) => (
              <tr key={i}>
                <td>{cat}</td>
                {series.map((s) => (
                  <td key={s.label}>{valueLabel(s.values[i] ?? 0)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}

// ─── Sparkline: tiny inline area/line for KPI cards ──────────────────────────

export interface SparklineProps {
  values: number[];
  /** CSS color for the line/fill. Default brand azure token. */
  color?: string;
  /** Rendered height in px. Width fills the container. Default 18. */
  height?: number;
  ariaLabel?: string;
  className?: string;
}

/**
 * A minimal area sparkline. Uses a non-uniform viewBox with
 * preserveAspectRatio="none" so it stretches to the card width — acceptable
 * (even conventional) for a sparkline, where only the silhouette matters.
 */
export function Sparkline({
  values,
  color = 'hsl(var(--color-brand))',
  height = 18,
  ariaLabel,
  className,
}: SparklineProps) {
  const n = values.length;
  if (n < 2) return <div style={{ height }} aria-hidden="true" className={className} />;

  const W = 100;
  const H = 24;
  const max = Math.max(1, ...values);
  const stepX = W / (n - 1);
  const pts = values.map((v, i) => {
    const x = i * stepX;
    const y = H - (v / max) * (H - 2) - 1; // 1px top/bottom padding
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;
  const gid = `spark-${values.join('-').replace(/[^0-9]/g, '').slice(0, 12)}`;

  return (
    <svg
      role={ariaLabel ? 'img' : 'presentation'}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height }}
      className={className}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
