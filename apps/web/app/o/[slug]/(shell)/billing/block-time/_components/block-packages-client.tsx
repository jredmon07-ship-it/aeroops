/**
 * block-packages-client.tsx — Block package table + Add/Edit dialog (Slice B4).
 *
 * States:
 *   populated — table of packages (name / hours / price / effective rate /
 *               active badge).
 *   empty     — "No block packages yet." + primary "Add package" CTA.
 *   dialog    — form (add or edit) with inline validation; input preserved on error.
 *   error     — inline Alert in the dialog.
 *
 * canManage=false (accountant, billing:access only): row actions + "Add
 * package" are hidden; a note explains why. Mirrors billing/catalog's
 * catalog-client.tsx pattern exactly.
 *
 * BOUNDARY: imports ONLY from local server actions + @aeroops/api types.
 * MONEY: price entered in DOLLARS in the form, converted to INTEGER CENTS at
 * the boundary (Math.round(dollars * 100)) before the server action call —
 * never sent as a float to the API layer's zod schema, which requires an
 * integer. hours is entered directly (up to 1 decimal place).
 */
'use client';

import * as React from 'react';
import { AlertCircle, Plus, Pencil, Layers } from 'lucide-react';
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
  createBlockPackageAction,
  updateBlockPackageAction,
  deactivateBlockPackageAction,
} from '../actions';
import type { SerializedBlockPackage } from '../actions';
import { formatCents } from '../../_components/format-cents';
import { EmptyState } from '@/components/ui/empty-state';

interface BlockPackagesClientProps {
  slug: string;
  initialPackages: SerializedBlockPackage[];
  canManage: boolean;
}

interface FormState {
  name: string;
  hours: string;
  priceDollars: string;
}

const EMPTY_FORM: FormState = { name: '', hours: '', priceDollars: '' };

/** Parses a dollar-string input into integer cents, or null if invalid. */
function parseDollarsToCents(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  const cents = Math.round(value * 100);
  return cents > 0 ? cents : null;
}

/** Parses an hours-string input into a number with at most 1 decimal place, or null if invalid. */
function parseHours(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return null;
  if (Math.round(value * 10) !== value * 10) return null;
  return value;
}

export function BlockPackagesClient({ slug, initialPackages, canManage }: BlockPackagesClientProps) {
  const [packages, setPackages] = React.useState(initialPackages);
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

  function openEditDialog(pkg: SerializedBlockPackage) {
    setEditingId(pkg.id);
    setForm({
      name: pkg.name,
      hours: String(pkg.hours),
      priceDollars: (pkg.priceCents / 100).toFixed(2),
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
    const hours = parseHours(form.hours);
    if (hours === null) {
      setError('Hours must be a positive number with at most 1 decimal place (e.g. 10 or 7.5).');
      return;
    }
    const priceCents = parseDollarsToCents(form.priceDollars);
    if (priceCents === null) {
      setError('Price must be a positive dollar amount (e.g. 1500.00).');
      return;
    }

    setSubmitting(true);
    try {
      if (editingId) {
        const result = await updateBlockPackageAction({ id: editingId, name, hours, priceCents }, slug);
        if ('error' in result) {
          setError(result.error === 'validation' ? result.message : 'Could not save the package. Please try again.');
          return;
        }
        if (!result.ok) {
          setError('This package no longer exists.');
          return;
        }
        setPackages((prev) => prev.map((p) => (p.id === result.package.id ? result.package : p)));
      } else {
        const result = await createBlockPackageAction({ name, hours, priceCents }, slug);
        if ('error' in result) {
          setError(result.error === 'validation' ? result.message : 'Could not add the package. Please try again.');
          return;
        }
        setPackages((prev) => [...prev, result.package].sort((a, b) => a.name.localeCompare(b.name)));
      }
      setDialogOpen(false);
      setForm(EMPTY_FORM);
      setEditingId(null);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDeactivate(pkg: SerializedBlockPackage) {
    if (!window.confirm(`Deactivate "${pkg.name}"? Past sales of this package are unaffected.`)) {
      return;
    }
    const result = await deactivateBlockPackageAction(pkg.id, slug);
    if ('error' in result || !result.ok) return;
    setPackages((prev) => prev.map((p) => (p.id === result.package.id ? result.package : p)));
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        {canManage ? (
          <Button size="sm" onClick={openAddDialog}>
            <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
            Add package
          </Button>
        ) : (
          <p className="text-sm text-slate-400 dark:text-slate-500">You do not have permission to manage block packages.</p>
        )}
      </div>

      {packages.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No block packages yet."
          cta={
            canManage && (
              <Button size="sm" onClick={openAddDialog}>
                <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
                Add package
              </Button>
            )
          }
        />
      ) : (
        <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-x-auto">
          <table className="w-full text-sm" aria-label="Block packages">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Name</th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Hours</th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Price</th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide hidden sm:table-cell">Effective rate</th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Status</th>
                {canManage && <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {packages.map((pkg) => (
                <tr key={pkg.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                  <td className="px-3 py-3 font-medium text-slate-900 dark:text-slate-100">{pkg.name}</td>
                  <td className="px-3 py-3 text-right nums">{pkg.hours}</td>
                  <td className="px-3 py-3 text-right nums">{formatCents(pkg.priceCents)}</td>
                  <td className="px-3 py-3 text-right nums text-xs text-slate-500 dark:text-slate-400 hidden sm:table-cell">
                    {formatCents(pkg.effectiveRateCentsPerHour)}/hr
                  </td>
                  <td className="px-3 py-3">
                    {pkg.active ? (
                      <span className="inline-flex items-center rounded-sm border border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-950/40 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-green-800 dark:text-green-200">Active</span>
                    ) : (
                      <span className="inline-flex items-center rounded-sm border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-4 text-slate-500 dark:text-slate-400">Inactive</span>
                    )}
                  </td>
                  {canManage && (
                    <td className="px-3 py-3 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`Edit ${pkg.name}`}
                          onClick={() => openEditDialog(pkg)}
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </Button>
                        {pkg.active && (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`Deactivate ${pkg.name}`}
                            onClick={() => handleDeactivate(pkg)}
                          >
                            Deactivate
                          </Button>
                        )}
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
              <DialogTitle>{editingId ? 'Edit block package' : 'Add block package'}</DialogTitle>
              <DialogDescription>
                The effective rate (price ÷ hours) is shown for reference — it is never stored.
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
                <Label htmlFor="block-package-name">Name</Label>
                <Input
                  id="block-package-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  disabled={submitting}
                  aria-required="true"
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="block-package-hours">Hours</Label>
                  <Input
                    id="block-package-hours"
                    inputMode="decimal"
                    placeholder="10"
                    value={form.hours}
                    onChange={(e) => setForm((f) => ({ ...f, hours: e.target.value }))}
                    disabled={submitting}
                    aria-required="true"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="block-package-price">Price (USD)</Label>
                  <Input
                    id="block-package-price"
                    inputMode="decimal"
                    placeholder="1500.00"
                    value={form.priceDollars}
                    onChange={(e) => setForm((f) => ({ ...f, priceDollars: e.target.value }))}
                    disabled={submitting}
                    aria-required="true"
                    required
                  />
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitting} aria-busy={submitting}>
                {submitting ? 'Saving…' : editingId ? 'Save changes' : 'Add package'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
