/**
 * catalog-client.tsx — Product catalog table + Add/Edit dialog (Slice P2).
 *
 * States:
 *   populated — table of items (name / price / sku / category / active badge).
 *   empty     — "No catalog items yet." + primary "Add item" CTA.
 *   dialog    — form (add or edit) with inline validation; input preserved on error.
 *   error     — inline Alert in the dialog.
 *
 * canManage=false (accountant, billing:access only): row actions + "Add item"
 * are hidden; a note explains why.
 *
 * BOUNDARY: imports ONLY from local server actions + @aeroops/api types.
 * MONEY: unit_price_cents entered in DOLLARS in the form, converted to
 * INTEGER CENTS at the boundary (Math.round(dollars * 100)) before the
 * server action call — never sent as a float to the API layer's zod schema,
 * which requires an integer.
 */
'use client';

import * as React from 'react';
import { AlertCircle, Plus, Pencil, Trash2, Package } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  createProductCatalogItemAction,
  updateProductCatalogItemAction,
  deleteProductCatalogItemAction,
} from '../../pos/actions';
import type { SerializedProductCatalogItem } from '../../pos/actions';
import { formatCents } from '../../_components/format-cents';

interface CatalogClientProps {
  slug: string;
  initialItems: SerializedProductCatalogItem[];
  canManage: boolean;
}

interface FormState {
  name: string;
  priceDollars: string;
  sku: string;
  category: string;
}

const EMPTY_FORM: FormState = { name: '', priceDollars: '', sku: '', category: '' };

/** Parses a dollar-string input into integer cents, or null if invalid. */
function parseDollarsToCents(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  const cents = Math.round(value * 100);
  return cents > 0 ? cents : null;
}

export function CatalogClient({ slug, initialItems, canManage }: CatalogClientProps) {
  const [items, setItems] = React.useState(initialItems);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  function openAddDialog() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError(null);
    setDialogOpen(true);
  }

  function openEditDialog(item: SerializedProductCatalogItem) {
    setEditingId(item.id);
    setForm({
      name: item.name,
      priceDollars: (item.unitPriceCents / 100).toFixed(2),
      sku: item.sku ?? '',
      category: item.category ?? '',
    });
    setError(null);
    setDialogOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const name = form.name.trim();
    if (name.length === 0) {
      setError('Name is required.');
      return;
    }
    const unitPriceCents = parseDollarsToCents(form.priceDollars);
    if (unitPriceCents === null) {
      setError('Price must be a positive dollar amount (e.g. 24.95).');
      return;
    }

    setSubmitting(true);
    try {
      if (editingId) {
        const result = await updateProductCatalogItemAction(
          {
            id: editingId,
            name,
            unitPriceCents,
            sku: form.sku.trim() || null,
            category: form.category.trim() || null,
          },
          slug,
        );
        if ('error' in result) {
          setError(result.error === 'validation' ? result.message : 'Could not save the item. Please try again.');
          return;
        }
        if (!result.ok) {
          setError('This item no longer exists.');
          return;
        }
        setItems((prev) => prev.map((i) => (i.id === result.item.id ? result.item : i)));
      } else {
        const result = await createProductCatalogItemAction(
          {
            name,
            unitPriceCents,
            sku: form.sku.trim() || undefined,
            category: form.category.trim() || undefined,
          },
          slug,
        );
        if ('error' in result) {
          setError(result.error === 'validation' ? result.message : 'Could not add the item. Please try again.');
          return;
        }
        setItems((prev) => [...prev, result.item].sort((a, b) => a.name.localeCompare(b.name)));
      }
      setDialogOpen(false);
      setForm(EMPTY_FORM);
      setEditingId(null);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleActive(item: SerializedProductCatalogItem) {
    const result = await updateProductCatalogItemAction({ id: item.id, active: !item.active }, slug);
    if ('error' in result || !result.ok) return;
    setItems((prev) => prev.map((i) => (i.id === result.item.id ? result.item : i)));
  }

  async function handleDelete(item: SerializedProductCatalogItem) {
    if (!window.confirm(`Delete "${item.name}"? This cannot be undone. Past sales of this item are unaffected.`)) {
      return;
    }
    const result = await deleteProductCatalogItemAction(item.id, slug);
    if ('error' in result || !result.ok) return;
    setItems((prev) => prev.filter((i) => i.id !== item.id));
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {canManage ? (
          <Button size="sm" onClick={openAddDialog}>
            <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
            Add item
          </Button>
        ) : (
          <p className="text-sm text-slate-400">You do not have permission to manage the catalog.</p>
        )}
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center space-y-3" role="status">
          <Package className="h-10 w-10 text-slate-300" aria-hidden="true" />
          <p className="text-slate-700 font-medium">No catalog items yet.</p>
          {canManage && (
            <Button size="sm" onClick={openAddDialog}>
              <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
              Add item
            </Button>
          )}
        </div>
      ) : (
        <div className="rounded-md border border-slate-200 overflow-hidden">
          <table className="w-full text-sm" aria-label="Product catalog">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">Name</th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 uppercase tracking-wide">Price</th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden sm:table-cell">SKU</th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden sm:table-cell">Category</th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">Status</th>
                {canManage && <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 uppercase tracking-wide">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50 transition-colors">
                  <td className="px-3 py-3 font-medium text-slate-900">{item.name}</td>
                  <td className="px-3 py-3 text-right nums">{formatCents(item.unitPriceCents)}</td>
                  <td className="px-3 py-3 text-xs text-slate-500 hidden sm:table-cell">{item.sku ?? '—'}</td>
                  <td className="px-3 py-3 text-xs text-slate-500 hidden sm:table-cell">{item.category ?? '—'}</td>
                  <td className="px-3 py-3">
                    {item.active ? (
                      <span className="inline-flex items-center rounded-sm border border-green-200 bg-green-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-green-800">Active</span>
                    ) : (
                      <span className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-slate-500">Inactive</span>
                    )}
                  </td>
                  {canManage && (
                    <td className="px-3 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Edit ${item.name}`}
                          onClick={() => openEditDialog(item)}
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={item.active ? `Deactivate ${item.name}` : `Reactivate ${item.name}`}
                          onClick={() => handleToggleActive(item)}
                        >
                          {item.active ? 'Deactivate' : 'Reactivate'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete ${item.name}`}
                          onClick={() => handleDelete(item)}
                        >
                          <Trash2 className="h-4 w-4 text-red-600" aria-hidden="true" />
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={(open) => !submitting && setDialogOpen(open)}>
        <DialogContent>
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>{editingId ? 'Edit catalog item' : 'Add catalog item'}</DialogTitle>
              <DialogDescription>
                Amounts are recorded in cents. Tax is not calculated.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              {error && (
                <Alert variant="destructive" role="alert">
                  <AlertCircle className="h-4 w-4" aria-hidden="true" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="catalog-name">Name</Label>
                <Input
                  id="catalog-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  disabled={submitting}
                  aria-required="true"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="catalog-price">Price (USD)</Label>
                <Input
                  id="catalog-price"
                  inputMode="decimal"
                  placeholder="24.95"
                  value={form.priceDollars}
                  onChange={(e) => setForm((f) => ({ ...f, priceDollars: e.target.value }))}
                  disabled={submitting}
                  aria-required="true"
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="catalog-sku">SKU (optional)</Label>
                  <Input
                    id="catalog-sku"
                    value={form.sku}
                    onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))}
                    disabled={submitting}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="catalog-category">Category (optional)</Label>
                  <Input
                    id="catalog-category"
                    value={form.category}
                    onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                    disabled={submitting}
                  />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting} aria-busy={submitting}>
                {submitting ? 'Saving…' : editingId ? 'Save changes' : 'Add item'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
