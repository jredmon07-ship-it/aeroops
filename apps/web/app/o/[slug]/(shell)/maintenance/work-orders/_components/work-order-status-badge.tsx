/**
 * work-order-status-badge.tsx — Status badge chip for work orders.
 *
 * Mirrors the severity/status chip pattern from squawk-list.tsx.
 * PURE client display — no I/O.
 */
import * as React from 'react';
import { Clock, CheckCircle, XCircle, Wrench } from 'lucide-react';

interface WorkOrderStatusBadgeProps {
  status: string;
  className?: string;
}

export function WorkOrderStatusBadge({ status, className = '' }: WorkOrderStatusBadgeProps) {
  const configs: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
    open: {
      label: 'Open',
      cls: 'border-brand/30 bg-brand/8 text-brand-ink',
      icon: <Wrench className="h-3 w-3" aria-hidden="true" />,
    },
    in_progress: {
      label: 'In progress',
      cls: 'border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-200',
      icon: <Clock className="h-3 w-3" aria-hidden="true" />,
    },
    completed: {
      label: 'Completed',
      cls: 'border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-950/40 text-green-800 dark:text-green-200',
      icon: <CheckCircle className="h-3 w-3" aria-hidden="true" />,
    },
    cancelled: {
      label: 'Cancelled',
      cls: 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
      icon: <XCircle className="h-3 w-3" aria-hidden="true" />,
    },
  };

  const config = configs[status] ?? {
    label: status,
    cls: 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
    icon: null,
  };

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 ${config.cls} ${className}`}
    >
      {config.icon}
      {config.label}
    </span>
  );
}
