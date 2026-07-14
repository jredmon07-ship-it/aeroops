/**
 * recurring-billing-client.tsx — Recurring billing hub table + bulk-apply /
 * generate actions (Slice DUES-CADENCE / RECUR-HUB).
 *
 * States:
 *   idle       — table (or empty state) + header actions for billing:manage.
 *   busy       — dialog/button busy state, inline validation.
 *   success    — toast, dialog closes, list refreshes via router.refresh().
 *   error      — inline Alert in the dialog, or a toast for a run/refusal.
 *
 * BOUNDARY: imports ONLY from local server actions + @aeroops/core display
 * helpers. NO Stripe, NO card/bank data — "Bulk apply" only creates a
 * schedule (a future generate run turns it into a DRAFT invoice); "Generate"
 * reuses the existing runDuesForPeriodAction unchanged.
 */
'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AlertCircle, CalendarClock, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { applyStandardDuesAction, runDuesForPeriodAction } from '../../actions';
import type { OrgDuesScheduleRow } from '@aeroops/api';
import { formatCents } from '../../_components/format-cents';
import { toast } from '@/lib/toast-store';
import { DUES_CADENCES, DUES_CADENCE_META, duesChargesPerYear } from '@aeroops/core';
import type { DuesCadence } from '@aeroops/core';

interface RecurringBillingClientProps {
  slug: string;
  schedules: OrgDuesScheduleRow[];
  chargeNoun: 'Tuition' | 'Dues';
  canManage: boolean;
  currentPeriodKey: string;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Months between charges for a cadence, derived from duesChargesPerYear. */
function anchorIntervalMonths(cadence: DuesCadence): number {
  return 12 / duesChargesPerYear(cadence);
}

/** Cadence label plus the anchor month name in parens for a non-monthly cadence. */
function cadenceCellLabel(cadence: DuesCadence, anchorMonth: number | null): string {
  const label = DUES_CADENCE_META[cadence].label;
  if (cadence === 'monthly' || anchorMonth == null) return label;
  const monthName = MONTH_NAMES[anchorMonth - 1] ?? String(anchorMonth);
  return `${label} (${monthName})`;
}

export function RecurringBillingClient({
  slug,
  schedules,
  chargeNoun,
  canManage,
  currentPeriodKey,
}: RecurringBillingClientProps) {
  const router = useRouter();

  // ── Generate this period's invoices ──
  const [generateBusy, setGenerateBusy] = React.useState(false);

  async function handleGenerate() {
    setGenerateBusy(true);
    try {
      const result = await runDuesForPeriodAction(currentPeriodKey, slug);
      if ('ok' in result && result.ok) {
        toast.success(`${result.createdCount} invoice(s) created, ${result.skippedCount} already run.`);
      } else if ('error' in result && result.error === 'validation') {
        toast.error(result.message);
      } else {
        toast.error(`Couldn't generate ${chargeNoun.toLowerCase()} for this period.`);
      }
    } finally {
      setGenerateBusy(false);
    }
  }

  // ── Bulk apply a standard schedule ──
  const [bulkDialogOpen, setBulkDialogOpen] = React.useState(false);
  const [bulkAmountInput, setBulkAmountInput] = React.useState('');
  const [bulkDayInput, setBulkDayInput] = React.useState('1');
  const [bulkCadence, setBulkCadence] = React.useState<DuesCadence>('monthly');
  const [bulkAnchorMonthInput, setBulkAnchorMonthInput] = React.useState('1');
  const [bulkMemoInput, setBulkMemoInput] = React.useState('');
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [bulkError, setBulkError] = React.useState<string | null>(null);

  function resetBulkForm() {
    setBulkAmountInput('');
    setBulkDayInput('1');
    setBulkCadence('monthly');
    setBulkAnchorMonthInput('1');
    setBulkMemoInput('');
  }

  async function handleBulkApply(e: React.FormEvent) {
    e.preventDefault();
    setBulkError(null);

    const dollars = Number(bulkAmountInput);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setBulkError('Enter an amount greater than $0.00.');
      return;
    }
    const dayOfMonth = Number(bulkDayInput);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) {
      setBulkError('Day of month must be between 1 and 28.');
      return;
    }
    const anchorMonth = Number(bulkAnchorMonthInput);
    if (bulkCadence !== 'monthly' && (!Number.isInteger(anchorMonth) || anchorMonth < 1 || anchorMonth > 12)) {
      setBulkError('Choose the month this cycle bills.');
      return;
    }

    setBulkBusy(true);
    try {
      const result = await applyStandardDuesAction(slug, {
        amountCents: Math.round(dollars * 100),
        dayOfMonth,
        cadence: bulkCadence,
        ...(bulkCadence === 'monthly' ? {} : { anchorMonth }),
        ...(bulkMemoInput.trim() ? { memo: bulkMemoInput.trim() } : {}),
      });

      if ('error' in result) {
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setBulkError(`You do not have permission to apply a standard ${chargeNoun.toLowerCase()} schedule.`);
        } else if (result.error === 'validation') {
          setBulkError(result.message);
        } else {
          setBulkError("Couldn't apply the schedule. Please try again.");
        }
        return;
      }
      if (!result.ok) {
        // reason === 'cadence_not_available' — a non-monthly cadence needs a
        // database update that has not been applied yet. Surface as a toast,
        // not a crash, and keep the dialog open so the operator can switch
        // back to monthly.
        const message = `Non-monthly ${chargeNoun.toLowerCase()} needs a database update that has not been applied yet.`;
        setBulkError(message);
        toast.error(message);
        return;
      }

      toast.success(`Applied to ${result.createdCount} member(s), ${result.skippedExistingCount} already had one.`);
      setBulkDialogOpen(false);
      resetBulkForm();
      router.refresh();
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button type="button" size="sm" variant="outline" disabled={generateBusy} onClick={() => void handleGenerate()}>
            {generateBusy ? 'Generating…' : `Generate ${currentPeriodKey}`}
          </Button>
          <Button type="button" size="sm" onClick={() => setBulkDialogOpen(true)}>
            <Sparkles className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
            Bulk apply a standard schedule
          </Button>
        </div>
      )}

      {schedules.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title={`No recurring ${chargeNoun.toLowerCase()} schedules yet.`}
          body={
            canManage
              ? `Bulk apply a standard schedule to set up the whole roster at once, or add one from a member's account page.`
              : `No member has an active ${chargeNoun.toLowerCase()} schedule yet.`
          }
        />
      ) : (
        <div className="rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
          <table className="w-full text-sm" aria-label={`Recurring ${chargeNoun.toLowerCase()} schedules`}>
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-800">
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                  Member
                </th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                  Amount
                </th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">
                  Cadence
                </th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide hidden sm:table-cell">
                  Memo
                </th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <tr key={s.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                  <td className="px-3 py-3">
                    <Link href={`/o/${slug}/billing/accounts/${s.userId}`} className="text-slate-900 dark:text-slate-100 font-medium hover:underline">
                      {s.memberName}
                    </Link>
                  </td>
                  <td className="px-3 py-3 text-right nums">{formatCents(s.amountCents)}</td>
                  <td className="px-3 py-3 text-slate-700 dark:text-slate-300">
                    {cadenceCellLabel(s.cadence, s.anchorMonth)}
                  </td>
                  <td className="px-3 py-3 text-slate-500 dark:text-slate-400 hidden sm:table-cell">
                    {s.memo ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Bulk apply a standard schedule dialog */}
      <Dialog open={bulkDialogOpen} onOpenChange={(o) => { if (!bulkBusy) { setBulkDialogOpen(o); setBulkError(null); } }}>
        <DialogContent aria-describedby="bulk-apply-desc">
          <form onSubmit={(e) => void handleBulkApply(e)}>
            <DialogHeader>
              <DialogTitle>Bulk apply a standard {chargeNoun.toLowerCase()} schedule</DialogTitle>
              <DialogDescription id="bulk-apply-desc">
                Creates the SAME {chargeNoun.toLowerCase()} schedule for every active member who does not already
                have one. Members who already have an active schedule are skipped, so this is safe to run more than
                once. This does NOT charge anything by itself.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              {bulkError && (
                <Alert variant="destructive" role="alert">
                  <AlertCircle className="h-4 w-4" aria-hidden="true" />
                  <AlertDescription>{bulkError}</AlertDescription>
                </Alert>
              )}
              <div className="space-y-1">
                <Label htmlFor="bulk-amount">Amount</Label>
                <Input
                  id="bulk-amount"
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  placeholder="0.00"
                  value={bulkAmountInput}
                  onChange={(e) => setBulkAmountInput(e.target.value)}
                  disabled={bulkBusy}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="bulk-cadence">Cadence</Label>
                <select
                  id="bulk-cadence"
                  className="flex h-9 w-full rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                  value={bulkCadence}
                  onChange={(e) => setBulkCadence(e.target.value as DuesCadence)}
                  disabled={bulkBusy}
                >
                  {DUES_CADENCES.map((c) => (
                    <option key={c} value={c}>
                      {DUES_CADENCE_META[c].label}
                    </option>
                  ))}
                </select>
              </div>
              {bulkCadence !== 'monthly' && (
                <div className="space-y-1">
                  <Label htmlFor="bulk-anchor-month">Anchor month</Label>
                  <select
                    id="bulk-anchor-month"
                    className="flex h-9 w-full rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
                    value={bulkAnchorMonthInput}
                    onChange={(e) => setBulkAnchorMonthInput(e.target.value)}
                    disabled={bulkBusy}
                    required
                  >
                    {MONTH_NAMES.map((name, i) => (
                      <option key={name} value={i + 1}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-slate-400 dark:text-slate-500">
                    The month this cycle bills (and every {anchorIntervalMonths(bulkCadence)} months after).
                  </p>
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="bulk-day">Day of month</Label>
                <Input
                  id="bulk-day"
                  type="number"
                  min="1"
                  max="28"
                  value={bulkDayInput}
                  onChange={(e) => setBulkDayInput(e.target.value)}
                  disabled={bulkBusy}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="bulk-memo">Memo (optional)</Label>
                <Input
                  id="bulk-memo"
                  type="text"
                  placeholder={`e.g. ${chargeNoun === 'Tuition' ? 'Monthly tuition' : 'Monthly club dues'}`}
                  value={bulkMemoInput}
                  onChange={(e) => setBulkMemoInput(e.target.value)}
                  disabled={bulkBusy}
                  maxLength={500}
                />
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setBulkDialogOpen(false)} disabled={bulkBusy}>
                Cancel
              </Button>
              <Button type="submit" disabled={bulkBusy} aria-busy={bulkBusy}>
                {bulkBusy ? 'Applying…' : 'Apply schedule'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
