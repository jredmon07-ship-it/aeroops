/**
 * invoice-detail-client.tsx — Invoice detail: line items + status actions
 * (Slice B1) + "Export to QuickBooks" (Slice QB1).
 *
 * States:
 *   idle              — status badge + line items table + action buttons.
 *   finalizing/voiding — busy button state.
 *   exporting          — busy button state; success/error surfaced inline.
 *
 * The Export button is shown ONLY when canManage AND status='finalized' —
 * mirrors the B1 finalize/void gating. The API is the real gate
 * (billing:manage + status='finalized' check inside exportInvoiceToQbo);
 * this is cosmetic.
 *
 * BOUNDARY: imports ONLY from '@aeroops/api' (types) + local server actions.
 * NO money moves — finalize/void are status-only; export is a bookkeeping
 * push of an existing record. NO Stripe, NO card/bank data.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { CheckCircle2, XCircle, AlertCircle, UploadCloud, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { finalizeInvoiceAction, voidInvoiceAction, exportInvoiceToQboAction } from '../actions';
import type { SerializedInvoiceRow, SerializedInvoiceLineItem } from '../actions';
import { formatCents } from './format-cents';
import { PageHeader } from '@/components/ui/page-header';

interface InvoiceDetailClientProps {
  invoice: SerializedInvoiceRow;
  lineItems: SerializedInvoiceLineItem[];
  slug: string;
  canManage: boolean;
}

type ExportState =
  | { phase: 'idle' }
  | { phase: 'exporting' }
  | { phase: 'success'; qboInvoiceId: string; alreadyExported: boolean }
  | { phase: 'error'; message: string };

function exportRefusalMessage(
  result: Extract<
    Awaited<ReturnType<typeof exportInvoiceToQboAction>>,
    { ok: false } | { error: string }
  >,
): string {
  if ('error' in result) {
    return result.error === 'forbidden' || result.error === 'unauthenticated'
      ? 'You do not have permission to export this invoice.'
      : "Couldn't export to QuickBooks. Please try again.";
  }
  switch (result.reason) {
    case 'not_configured':
      return 'QuickBooks is not configured on this deployment. Contact your administrator.';
    case 'not_connected':
      return 'QuickBooks is not connected for this organization. Connect it from Org settings.';
    case 'not_found':
      return 'This invoice could not be found.';
    case 'not_finalized':
      return 'Only finalized invoices can be exported to QuickBooks.';
    case 'unmapped_kinds':
      return `Some charge kinds are not mapped to a QuickBooks account yet: ${result.kinds.join(', ')}. Set them in Org settings.`;
    case 'provider_error':
      return `QuickBooks reported an error: ${result.message}`;
    default:
      return "Couldn't export to QuickBooks. Please try again.";
  }
}

export function InvoiceDetailClient({ invoice: initialInvoice, lineItems, slug, canManage }: InvoiceDetailClientProps) {
  const [invoice, setInvoice] = React.useState(initialInvoice);
  const [busy, setBusy] = React.useState<'finalize' | 'void' | null>(null);
  const [statusError, setStatusError] = React.useState<string | null>(null);
  const [voidDialogOpen, setVoidDialogOpen] = React.useState(false);
  const [exportState, setExportState] = React.useState<ExportState>({ phase: 'idle' });

  async function handleFinalize() {
    setBusy('finalize');
    setStatusError(null);
    try {
      const result = await finalizeInvoiceAction(invoice.id, slug);
      if ('error' in result) {
        setStatusError(
          result.error === 'forbidden' || result.error === 'unauthenticated'
            ? 'You do not have permission to finalize this invoice.'
            : "Couldn't finalize the invoice. Please try again.",
        );
        return;
      }
      if (!result.ok) {
        setStatusError(result.reason === 'not_draft' ? 'This invoice is no longer a draft.' : 'Invoice not found.');
        return;
      }
      setInvoice(result.invoice);
    } finally {
      setBusy(null);
    }
  }

  async function handleVoid() {
    setBusy('void');
    setStatusError(null);
    try {
      const result = await voidInvoiceAction(invoice.id, slug);
      if ('error' in result) {
        setStatusError(
          result.error === 'forbidden' || result.error === 'unauthenticated'
            ? 'You do not have permission to void this invoice.'
            : "Couldn't void the invoice. Please try again.",
        );
        return;
      }
      if (!result.ok) {
        setStatusError(result.reason === 'already_void' ? 'This invoice is already void.' : 'Invoice not found.');
        return;
      }
      setInvoice(result.invoice);
      setVoidDialogOpen(false);
    } finally {
      setBusy(null);
    }
  }

  async function handleExport() {
    setExportState({ phase: 'exporting' });
    try {
      const result = await exportInvoiceToQboAction(invoice.id, slug);
      if ('error' in result || !result.ok) {
        setExportState({ phase: 'error', message: exportRefusalMessage(result) });
        return;
      }
      setExportState({ phase: 'success', qboInvoiceId: result.qboInvoiceId, alreadyExported: result.alreadyExported });
    } catch {
      setExportState({ phase: 'error', message: "Couldn't export to QuickBooks. Please try again." });
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Invoice"
        subtitle={
          <>
            <span className="block font-mono">{invoice.id}</span>
            <Link
              href={`/o/${slug}/billing/accounts/${invoice.memberUserId}`}
              className="mt-1 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-700"
            >
              <Wallet className="h-3.5 w-3.5" aria-hidden="true" />
              View member account
            </Link>
          </>
        }
        actions={<StatusBadge status={invoice.status} />}
      />

      {statusError && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>{statusError}</AlertDescription>
        </Alert>
      )}

      {/* Totals */}
      <div className="rounded-md border border-slate-200 px-4 py-3 max-w-sm space-y-1">
        <div className="flex justify-between text-sm">
          <span className="text-slate-500">Subtotal</span>
          <span className="nums">{formatCents(invoice.subtotalCents)}</span>
        </div>
        <div className="flex justify-between text-sm font-semibold">
          <span className="text-slate-700">Total</span>
          <span className="nums">{formatCents(invoice.totalCents)}</span>
        </div>
      </div>

      {/* Line items */}
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Line items</h2>
        <div className="rounded-md border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm" aria-label="Invoice line items">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                  Description
                </th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 uppercase tracking-wide">
                  Qty (hrs)
                </th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 uppercase tracking-wide">
                  Unit
                </th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 uppercase tracking-wide">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {lineItems.map((line) => (
                <tr key={line.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 text-slate-700">{line.description}</td>
                  <td className="px-3 py-2 text-right nums">{line.quantityHours.toFixed(1)}</td>
                  <td className="px-3 py-2 text-right nums">{formatCents(line.unitAmountCents)}</td>
                  <td className="px-3 py-2 text-right nums">{formatCents(line.lineTotalCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Status actions (Slice B1, unchanged) */}
      {canManage && invoice.status !== 'void' && (
        <div className="flex flex-wrap gap-2">
          {invoice.status === 'draft' && (
            <Button type="button" size="sm" onClick={() => void handleFinalize()} disabled={busy !== null} aria-busy={busy === 'finalize'}>
              <CheckCircle2 className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
              {busy === 'finalize' ? 'Finalizing…' : 'Finalize'}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="text-danger hover:text-danger hover:bg-danger/10"
            onClick={() => setVoidDialogOpen(true)}
            disabled={busy !== null}
          >
            <XCircle className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
            Void
          </Button>
        </div>
      )}

      {/* Export to QuickBooks (Slice QB1) — finalized invoices only */}
      {canManage && invoice.status === 'finalized' && (
        <div className="rounded-md border border-slate-200 px-4 py-3 space-y-2 max-w-md">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">QuickBooks</h2>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void handleExport()}
            disabled={exportState.phase === 'exporting'}
            aria-busy={exportState.phase === 'exporting'}
          >
            <UploadCloud className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
            {exportState.phase === 'exporting' ? 'Exporting…' : 'Export to QuickBooks'}
          </Button>
          {exportState.phase === 'success' && (
            <p className="text-sm text-green-700" role="status">
              {exportState.alreadyExported
                ? `Already exported (QuickBooks invoice ${exportState.qboInvoiceId}).`
                : `Exported to QuickBooks (invoice ${exportState.qboInvoiceId}).`}
            </p>
          )}
          {exportState.phase === 'error' && (
            <Alert variant="destructive" role="alert">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{exportState.message}</AlertDescription>
            </Alert>
          )}
        </div>
      )}

      {/* Void confirmation dialog */}
      <Dialog open={voidDialogOpen} onOpenChange={(o) => { if (!busy) setVoidDialogOpen(o); }}>
        <DialogContent aria-describedby="void-dialog-desc">
          <DialogHeader>
            <DialogTitle>Void this invoice?</DialogTitle>
            <DialogDescription id="void-dialog-desc">
              This is permanent — voided invoices cannot be reactivated. This does not affect any QuickBooks
              export already made.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => setVoidDialogOpen(false)} disabled={busy === 'void'}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={() => void handleVoid()} disabled={busy === 'void'} aria-busy={busy === 'void'}>
              {busy === 'void' ? 'Voiding…' : 'Void invoice'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusBadge({ status }: { status: 'draft' | 'finalized' | 'void' }) {
  if (status === 'finalized') {
    return (
      <span className="inline-flex items-center rounded-sm border border-green-200 bg-green-50 px-2 py-0.5 text-xs font-semibold leading-5 text-green-800">
        Finalized
      </span>
    );
  }
  if (status === 'void') {
    return (
      <span className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-semibold leading-5 text-slate-500">
        Void
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-sm border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-semibold leading-5 text-amber-800">
      Draft
    </span>
  );
}
