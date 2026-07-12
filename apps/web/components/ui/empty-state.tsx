/**
 * EmptyState — THE one way to render a designed empty state.
 *
 * Centered layout: muted icon circle → title → optional body → optional CTA.
 * role="status" so screen readers announce the (lack of) content.
 *
 * Server-safe: no hooks, no client-only imports.
 */
import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from './utils';

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  body?: React.ReactNode;
  cta?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  cta,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center px-6 py-16 text-center',
        className,
      )}
      role="status"
    >
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-slate-100">
        <Icon className="h-6 w-6 text-slate-400" aria-hidden="true" />
      </div>
      <p className="mt-4 text-sm font-medium text-slate-700">{title}</p>
      {body && <p className="mt-1 max-w-sm text-sm text-slate-400">{body}</p>}
      {cta && <div className="mt-4">{cta}</div>}
    </div>
  );
}
