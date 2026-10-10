/**
 * SectionHeader — the ops-dashboard eyebrow pattern, extracted.
 *
 * Usage:
 *   <SectionHeader eyebrow="As of now" />
 *   <SectionHeader eyebrow="Maintenance" title="Work orders" hint="Newest first" />
 *
 * The eyebrow is the tiny tracked-uppercase slate label the dashboard uses
 * above every panel ("As of now", "Last 30 days", "On the board").
 *
 * Server-safe: no hooks, no client-only imports.
 */
import * as React from 'react';
import { cn } from './utils';

export interface SectionHeaderProps {
  eyebrow: React.ReactNode;
  title?: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
}

export function SectionHeader({
  eyebrow,
  title,
  hint,
  className,
}: SectionHeaderProps) {
  return (
    <div className={cn('mb-1.5', className)}>
      <p className="text-[0.625rem] uppercase tracking-[0.1em] text-slate-400 dark:text-slate-500">
        {eyebrow}
      </p>
      {title && (
        <h2 className="mt-0.5 text-lg font-semibold tracking-tightish text-slate-900 dark:text-slate-100">
          {title}
        </h2>
      )}
      {hint && <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{hint}</p>}
    </div>
  );
}
