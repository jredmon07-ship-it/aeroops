/**
 * pos-client.tsx — Counter sale / POS line builder (Slice P2).
 *
 * Flow: pick a member ("Bill to member", required) → add catalog lines
 * (dropdown + qty stepper) and/or ad-hoc lines (name + price + qty) → running
 * subtotal (client-side display sum, mirrors computeInvoiceTotals — exact
 * integer cents, no float) → "Create sale" (drafts an invoice) or "Create &
 * finalize" (drafts, then immediately finalizes via the EXISTING
 * finalizeInvoice path).
 *
 * States:
 *   empty      — no lines yet → "Add a line to start a sale."; create disabled.
 *   building   — lines added; running subtotal shown read-only.
 *   submitting — aria-busy, controls disabled.
 *   success    — sale created; links to the invoice detail page; form resets.
 *   error      — inline Alert; input preserved (lines + member selection kept).
 *
 * BOUNDARY: imports ONLY from local server actions + @aeroops/api types.
 * MONEY: catalog line total = quantity × catalog unit price (display mirror
 * of computeCounterSaleLineTotal — the SERVER is the source of truth; this
 * is a read-only preview). Ad-hoc price entered in dollars, converted to
 * integer cents at the boundary. NO Stripe, NO card/bank data.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertCircle, Plus, Trash2, CheckCircle2, ShoppingCart } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { createCounterSaleAction, finalizeCounterSaleAction } from '../actions';
import type { BillableMember, SerializedProductCatalogItem, SerializedCounterSaleInvoice } from '../actions';
import type { CounterSaleLineInput } from '@aeroops/api';
import { formatCents } from '../../_components/format-cents';

interface PosClientProps {
  slug: string;
  members: BillableMember[];
  catalogItems: SerializedProductCatalogItem[];
}

interface DraftLine {
  key: string;
  kind: 'catalog' | 'adhoc';
  catalogItemId?: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
}

let lineKeySeq = 0;
function nextLineKey(): string {
  lineKeySeq += 1;
  return `line-${lineKeySeq}`;
}

function lineTotalCents(line: DraftLine): number {
  // Exact integer product — mirrors computeCounterSaleLineTotal (display only).
  return line.quantity * line.unitPriceCents;
}

export function PosClient({ slug, members, catalogItems }: PosClientProps) {
  const [memberId, setMemberId] = React.useState('');
  const [lines, setLines] = React.useState<DraftLine[]>([]);
  const [selectedCatalogId, setSelectedCatalogId] = React.useState('');
  const [catalogQty, setCatalogQty] = React.useState('1');
  const [adhocName, setAdhocName] = React.useState('');
  const [adhocPrice, setAdhocPrice] = React.useState('');
  const [adhocQty, setAdhocQty] = React.useState('1');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<SerializedCounterSaleInvoice | null>(null);

  const subtotalCents = lines.reduce((sum, l) => sum + lineTotalCents(l), 0);

  function addCatalogLine() {
    const item = catalogItems.find((i) => i.id === selectedCatalogId);
    if (!item) return;
    const qty = Number.parseInt(catalogQty, 10);
    if (!Number.isFinite(qty) || qty <= 0) return;
    setLines((prev) => [
      ...prev,
      { key: nextLineKey(), kind: 'catalog', catalogItemId: item.id, name: item.name, unitPriceCents: item.unitPriceCents, quantity: qty },
    ]);
    setSelectedCatalogId('');
    setCatalogQty('1');
    setError(null);
  }

  function addAdhocLine() {
    const name = adhocName.trim();
    const priceValue = Number(adhocPrice);
    const qty = Number.parseInt(adhocQty, 10);
    if (name.length === 0 || !Number.isFinite(priceValue) || priceValue <= 0 || !Number.isFinite(qty) || qty <= 0) {
      setError('Ad-hoc line needs a name, a positive price, and a positive quantity.');
      return;
    }
    const unitPriceCents = Math.round(priceValue * 100);
    setLines((prev) => [
      ...prev,
      { key: nextLineKey(), kind: 'adhoc', name, unitPriceCents, quantity: qty },
    ]);
    setAdhocName('');
    setAdhocPrice('');
    setAdhocQty('1');
    setError(null);
  }

  function removeLine(key: string) {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }

  function reasonCopy(reason: string): string {
    switch (reason) {
      case 'member_not_found':
        return 'That member could not be found. They may have been removed.';
      case 'catalog_item_not_found':
        return 'One of the catalog items in this sale could not be found. Remove and re-add it.';
      case 'catalog_item_inactive':
        return 'One of the catalog items in this sale is no longer active. Remove it or reactivate it in the Catalog.';
      default:
        return 'Could not create the sale. Please try again.';
    }
  }

  async function handleCreateSale(alsoFinalize: boolean) {
    setError(null);
    if (memberId.length === 0) {
      setError('Select a member to bill.');
      return;
    }
    if (lines.length === 0) {
      setError('Add at least one line to create a sale.');
      return;
    }

    const payload: CounterSaleLineInput[] = lines.map((l) =>
      l.kind === 'catalog'
        ? { catalogItemId: l.catalogItemId as string, quantity: l.quantity }
        : { name: l.name, unitPriceCents: l.unitPriceCents, quantity: l.quantity },
    );

    setSubmitting(true);
    try {
      const result = await createCounterSaleAction(memberId, payload, slug);
      if ('error' in result) {
        setError(result.error === 'validation' ? result.message : 'Could not create the sale. Please try again.');
        return;
      }
      if (!result.ok) {
        setError(reasonCopy(result.reason));
        return;
      }

      if (alsoFinalize) {
        const finR = await finalizeCounterSaleAction(result.invoice.id, slug);
        if ('error' in finR || !finR.ok) {
          // The draft invoice was still created — surface success with a note.
          setSuccess(result.invoice);
          setError('The sale was created as a draft, but finalizing it failed. Finalize it from the invoice page.');
          setLines([]);
          setMemberId('');
          return;
        }
      }

      setSuccess(result.invoice);
      setLines([]);
      setMemberId('');
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="space-y-4">
        <Alert role="status">
          <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" aria-hidden="true" />
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>
              Sale created — total {formatCents(success.totalCents)} ({success.status === 'finalized' ? 'finalized' : 'draft'}).
            </span>
            <Button asChild variant="outline" size="sm">
              <Link href={`/o/${slug}/billing/${success.id}`}>View invoice</Link>
            </Button>
          </AlertDescription>
        </Alert>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button size="sm" onClick={() => { setSuccess(null); setError(null); }}>
          Start a new sale
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="pos-member">Bill to member (required)</Label>
        <select
          id="pos-member"
          value={memberId}
          onChange={(e) => setMemberId(e.target.value)}
          disabled={submitting}
          aria-required="true"
          className="flex h-10 w-full max-w-md rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 hover:border-slate-400 dark:hover:border-slate-500 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
        >
          <option value="">— Select member —</option>
          {members.map((m) => (
            <option key={m.userId} value={m.userId}>
              {m.displayName} ({m.email})
            </option>
          ))}
          {members.length === 0 && <option disabled>No members found</option>}
        </select>
      </div>

      <div className="rounded-md border border-slate-200 dark:border-slate-800 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Add catalog item</h2>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5 flex-1 min-w-[220px]">
            <Label htmlFor="pos-catalog-item">Item</Label>
            <select
              id="pos-catalog-item"
              value={selectedCatalogId}
              onChange={(e) => setSelectedCatalogId(e.target.value)}
              disabled={submitting}
              className="flex h-10 w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 hover:border-slate-400 dark:hover:border-slate-500 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
            >
              <option value="">— Select item —</option>
              {catalogItems.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} — {formatCents(item.unitPriceCents)}
                </option>
              ))}
              {catalogItems.length === 0 && <option disabled>No active catalog items</option>}
            </select>
          </div>
          <div className="space-y-1.5 w-24">
            <Label htmlFor="pos-catalog-qty">Qty</Label>
            <Input
              id="pos-catalog-qty"
              type="number"
              min={1}
              step={1}
              value={catalogQty}
              onChange={(e) => setCatalogQty(e.target.value)}
              disabled={submitting}
            />
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addCatalogLine} disabled={submitting || !selectedCatalogId}>
            <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
            Add
          </Button>
        </div>
      </div>

      <div className="rounded-md border border-slate-200 dark:border-slate-800 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Add ad-hoc line</h2>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5 flex-1 min-w-[180px]">
            <Label htmlFor="pos-adhoc-name">Name</Label>
            <Input id="pos-adhoc-name" value={adhocName} onChange={(e) => setAdhocName(e.target.value)} disabled={submitting} />
          </div>
          <div className="space-y-1.5 w-28">
            <Label htmlFor="pos-adhoc-price">Price (USD)</Label>
            <Input id="pos-adhoc-price" inputMode="decimal" placeholder="9.99" value={adhocPrice} onChange={(e) => setAdhocPrice(e.target.value)} disabled={submitting} />
          </div>
          <div className="space-y-1.5 w-24">
            <Label htmlFor="pos-adhoc-qty">Qty</Label>
            <Input id="pos-adhoc-qty" type="number" min={1} step={1} value={adhocQty} onChange={(e) => setAdhocQty(e.target.value)} disabled={submitting} />
          </div>
          <Button type="button" variant="outline" size="sm" onClick={addAdhocLine} disabled={submitting}>
            <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
            Add
          </Button>
        </div>
      </div>

      {lines.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center space-y-2 text-slate-500 dark:text-slate-400" role="status">
          <ShoppingCart className="h-8 w-8 text-slate-300" aria-hidden="true" />
          <p>Add a line to start a sale.</p>
        </div>
      ) : (
        <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-x-auto">
          <table className="w-full text-sm" aria-label="Sale lines">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Item</th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Qty</th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Unit price</th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Total</th>
                <th scope="col" className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.key} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                  <td className="px-3 py-2">{line.name}</td>
                  <td className="px-3 py-2 text-right nums">{line.quantity}</td>
                  <td className="px-3 py-2 text-right nums">{formatCents(line.unitPriceCents)}</td>
                  <td className="px-3 py-2 text-right nums">{formatCents(lineTotalCents(line))}</td>
                  <td className="px-3 py-2 text-right">
                    <Button variant="ghost" size="sm" aria-label={`Remove ${line.name}`} onClick={() => removeLine(line.key)} disabled={submitting}>
                      <Trash2 className="h-4 w-4 text-red-600 dark:text-red-400" aria-hidden="true" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-slate-50 dark:bg-slate-800 border-t border-slate-200 dark:border-slate-800">
                <td colSpan={3} className="px-3 py-2 text-right text-sm font-medium text-slate-700 dark:text-slate-300">Subtotal</td>
                <td className="px-3 py-2 text-right nums font-semibold">{formatCents(subtotalCents)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => handleCreateSale(false)}
          disabled={submitting || lines.length === 0 || memberId.length === 0}
          aria-busy={submitting}
        >
          {submitting ? 'Creating…' : 'Create sale'}
        </Button>
        <Button
          variant="outline"
          onClick={() => handleCreateSale(true)}
          disabled={submitting || lines.length === 0 || memberId.length === 0}
          aria-busy={submitting}
        >
          {submitting ? 'Creating…' : 'Create & finalize'}
        </Button>
      </div>
    </div>
  );
}
