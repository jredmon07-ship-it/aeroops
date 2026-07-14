/**
 * billing/_components/qbo-export-badge.tsx — the per-invoice QuickBooks export
 * state badge (Slice QBO-SYNC). Derived entirely from qbo_export_log via
 * getInvoiceQboStatuses; shared by the invoice detail card and the invoice
 * list column. Display-only — NO money.
 */
import * as React from 'react';

export type QboInvoiceExportStatus = 'not_exported' | 'exported' | 'failed';

export function QboExportBadge({ status }: { status: QboInvoiceExportStatus }) {
  if (status === 'exported') {
    return (
      <span className="inline-flex items-center rounded-sm border border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-950/40 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-green-800 dark:text-green-200">
        Exported
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="inline-flex items-center rounded-sm border border-destructive/30 bg-destructive/10 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-destructive">
        Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-sm border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-slate-500 dark:text-slate-400">
      Not exported
    </span>
  );
}
