/**
 * PageHeader — THE one way to render a page's h1 row.
 *
 * Matches the ops-dashboard heading treatment (the design-language gold
 * standard): text-2xl font-bold tracking-tightish title, muted one-line
 * subtitle, actions right-aligned, optional back link above.
 *
 * Server-safe: no hooks, no client-only imports.
 */
import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

export interface PageHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Right-aligned action buttons/links. */
  actions?: React.ReactNode;
  /** Renders a muted "← Back" link above the title. */
  backHref?: string;
  backLabel?: string;
}

export function PageHeader({
  title,
  subtitle,
  actions,
  backHref,
  backLabel = 'Back',
}: PageHeaderProps) {
  return (
    <header className="space-y-2">
      {backHref && (
        <Link
          href={backHref}
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
          {backLabel}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tightish text-slate-900 dark:text-slate-100">
            {title}
          </h1>
          {subtitle && <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{subtitle}</p>}
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
    </header>
  );
}
