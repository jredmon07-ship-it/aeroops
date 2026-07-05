/**
 * account-detail-client.tsx — member balance + ledger history + "Record
 * payment" dialog (Slice B2).
 *
 * States:
 *   idle       — balance card + ledger table + "Record payment" button.
 *   recording  — busy dialog state, inline validation.
 *   success    — dialog closes, balance + ledger refresh in place.
 *   error      — inline Alert in the dialog.
 *
 * BOUNDARY: imports ONLY from local server actions + @aeroops/api types.
 * NO Stripe, NO card/bank data — "Record payment" is a MANUAL operator
 * acknowledgement (methodNote is a free-text reference, e.g. "Check #1042"),
 * never a charge.
 */
'use client';

import * as React from 'react';
import { AlertCircle, PlusCircle } from 'lucide-react';
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
  recordManualPaymentAction,
  listLedgerEntriesAction,
  createDuesScheduleAction,
  setDuesScheduleActiveAction,
  runDuesForPeriodAction,
} from '../../actions';
import type { SerializedLedgerEntry } from '../../actions';
import { formatCents } from '../../_components/format-cents';
import type { MemberBillingProfile } from '@aeroops/api';

interface AccountDetailClientProps {
  memberId: string;
  slug: string;
  balanceCents: number;
  minimumBalanceCents: number;
  initialEntries: SerializedLedgerEntry[];
  canManage: boolean;
  initialBillingProfile: MemberBillingProfile | null;
}

function pmLabel(pm: { type: string; last4: string | null; brand: string | null }): string {
  const brand = pm.brand ?? (pm.type === 'us_bank_account' ? 'Bank account' : 'Card');
  return pm.last4 ? `${brand} ····${pm.last4}` : brand;
}

function currentPeriodKey(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function entryTypeLabel(entryType: SerializedLedgerEntry['entryType']): string {
  switch (entryType) {
    case 'invoice_finalized':
      return 'Invoice finalized';
    case 'payment':
      return 'Payment';
    case 'credit_memo':
      return 'Credit memo';
    case 'adjustment':
      return 'Adjustment';
    case 'block_purchase':
      return 'Block time purchase';
    default:
      return entryType;
  }
}

export function AccountDetailClient({
  memberId,
  slug,
  balanceCents: initialBalanceCents,
  minimumBalanceCents,
  initialEntries,
  canManage,
  initialBillingProfile,
}: AccountDetailClientProps) {
  const [balanceCents, setBalanceCents] = React.useState(initialBalanceCents);
  const [entries, setEntries] = React.useState(initialEntries);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [amountInput, setAmountInput] = React.useState('');
  const [methodNote, setMethodNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  // ── Slice P0-REV: auto-pay status / saved-PM presence / dues (DISPLAY ONLY) ──
  const [billingProfile, setBillingProfile] = React.useState(initialBillingProfile);
  const [duesDialogOpen, setDuesDialogOpen] = React.useState(false);
  const [duesAmountInput, setDuesAmountInput] = React.useState('');
  const [duesDayInput, setDuesDayInput] = React.useState('1');
  const [duesMemoInput, setDuesMemoInput] = React.useState('');
  const [duesBusy, setDuesBusy] = React.useState(false);
  const [duesError, setDuesError] = React.useState<string | null>(null);
  const [runDuesBusy, setRunDuesBusy] = React.useState(false);
  const [runDuesResult, setRunDuesResult] = React.useState<string | null>(null);

  async function refreshBillingProfile() {
    const { getMemberBillingProfileAction } = await import('../../actions');
    const result = await getMemberBillingProfileAction(memberId);
    if ('ok' in result && result.ok) setBillingProfile(result.profile);
  }

  async function handleCreateDuesSchedule(e: React.FormEvent) {
    e.preventDefault();
    setDuesError(null);
    const dollars = Number(duesAmountInput);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setDuesError('Enter an amount greater than $0.00.');
      return;
    }
    const dayOfMonth = Number(duesDayInput);
    if (!Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 28) {
      setDuesError('Day of month must be between 1 and 28.');
      return;
    }
    setDuesBusy(true);
    try {
      const result = await createDuesScheduleAction(
        memberId, Math.round(dollars * 100), dayOfMonth, duesMemoInput.trim() || undefined, slug,
      );
      if ('error' in result) {
        setDuesError(result.error === 'validation' ? result.message : "Couldn't create the dues schedule.");
        return;
      }
      if (!result.ok) {
        setDuesError('This member could not be found.');
        return;
      }
      await refreshBillingProfile();
      setDuesDialogOpen(false);
      setDuesAmountInput('');
      setDuesDayInput('1');
      setDuesMemoInput('');
    } finally {
      setDuesBusy(false);
    }
  }

  async function handleSetDuesActive(scheduleId: string, active: boolean) {
    setDuesBusy(true);
    try {
      await setDuesScheduleActiveAction(scheduleId, active, memberId, slug);
      await refreshBillingProfile();
    } finally {
      setDuesBusy(false);
    }
  }

  async function handleRunDues() {
    setRunDuesBusy(true);
    setRunDuesResult(null);
    try {
      const result = await runDuesForPeriodAction(currentPeriodKey(), slug);
      if ('ok' in result && result.ok) {
        setRunDuesResult(`${result.createdCount} invoice(s) created, ${result.skippedCount} already run.`);
        await refreshBillingProfile();
      } else {
        setRunDuesResult("Couldn't run dues for this period.");
      }
    } finally {
      setRunDuesBusy(false);
    }
  }

  const belowMinimum = minimumBalanceCents > 0 && balanceCents < minimumBalanceCents;

  async function refreshEntries() {
    const result = await listLedgerEntriesAction(memberId);
    if ('ok' in result && result.ok) setEntries(result.entries);
  }

  async function handleRecordPayment(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const dollars = Number(amountInput);
    if (!Number.isFinite(dollars) || dollars <= 0) {
      setFormError('Enter an amount greater than $0.00.');
      return;
    }
    const amountCents = Math.round(dollars * 100);

    setBusy(true);
    try {
      const result = await recordManualPaymentAction(memberId, amountCents, methodNote.trim() || undefined, slug);
      if ('error' in result) {
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setFormError('You do not have permission to record a payment.');
        } else if (result.error === 'validation') {
          setFormError(result.message);
        } else {
          setFormError("Couldn't record the payment. Please try again.");
        }
        return;
      }
      if (!result.ok) {
        setFormError('This member could not be found.');
        return;
      }
      setBalanceCents(result.balanceCentsAfter);
      await refreshEntries();
      setDialogOpen(false);
      setAmountInput('');
      setMethodNote('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Account</h1>
          <p className="mt-1 text-sm text-slate-500 font-mono">{memberId}</p>
        </div>
        {canManage && (
          <Button type="button" size="sm" onClick={() => setDialogOpen(true)}>
            <PlusCircle className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
            Record payment
          </Button>
        )}
      </div>

      {/* Balance card */}
      <div className="rounded-md border border-slate-200 px-4 py-3 max-w-sm space-y-1">
        <div className="flex justify-between text-sm">
          <span className="text-slate-500">Balance</span>
          <span className={`nums font-semibold ${balanceCents < 0 ? 'text-danger' : 'text-slate-900'}`}>
            {formatCents(balanceCents)}
          </span>
        </div>
        {minimumBalanceCents > 0 && (
          <div className="flex justify-between text-xs text-slate-400">
            <span>Operator minimum</span>
            <span className="nums">{formatCents(minimumBalanceCents)}</span>
          </div>
        )}
        {belowMinimum && (
          <p className="text-xs text-amber-700 pt-1">Below the operator&apos;s configured minimum balance.</p>
        )}
      </div>

      {/* Ledger history */}
      <div>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Ledger history</h2>
        {entries.length === 0 ? (
          <p className="text-sm text-slate-400 py-6 text-center" role="status">
            No ledger activity yet.
          </p>
        ) : (
          <div className="rounded-md border border-slate-200 overflow-hidden">
            <table className="w-full text-sm" aria-label="Ledger entries">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                    Type
                  </th>
                  <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden sm:table-cell">
                    Reference
                  </th>
                  <th scope="col" className="px-3 py-2 text-right text-xs font-medium text-slate-500 uppercase tracking-wide">
                    Amount
                  </th>
                  <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide hidden sm:table-cell">
                    Date
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2 text-slate-700">{entryTypeLabel(entry.entryType)}</td>
                    <td className="px-3 py-2 text-slate-500 hidden sm:table-cell">
                      {entry.paymentId ?? entry.memo ?? '—'}
                    </td>
                    <td className={`px-3 py-2 text-right nums ${entry.direction === 'debit' ? 'text-danger' : 'text-green-700'}`}>
                      {entry.direction === 'debit' ? '-' : '+'}
                      {formatCents(entry.amountCents)}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500 hidden sm:table-cell nums">
                      {new Date(entry.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Slice P0-REV: Billing profile — auto-pay + saved-PM + dues (DISPLAY ONLY) ── */}
      <div className="rounded-md border border-slate-200 overflow-hidden">
        <div className="border-b border-slate-100 px-4 py-2.5 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Billing profile</h2>
          {canManage && (
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" variant="outline" disabled={runDuesBusy} onClick={() => void handleRunDues()}>
                {runDuesBusy ? 'Running…' : `Run dues for ${currentPeriodKey()}`}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setDuesDialogOpen(true)}>
                Add dues schedule
              </Button>
            </div>
          )}
        </div>
        <div className="px-4 py-3 space-y-3">
          {runDuesResult && <p className="text-xs text-slate-500">{runDuesResult}</p>}
          {billingProfile === null ? (
            <p className="text-sm text-slate-400">Billing profile unavailable.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
                <span className="text-slate-500">
                  Auto-pay:{' '}
                  <span className={billingProfile.autopayEnabled ? 'text-brand-ink font-medium' : 'text-slate-700'}>
                    {billingProfile.autopayEnabled ? 'On' : 'Off'}
                  </span>
                </span>
                <span className="text-slate-500">
                  Saved payment method:{' '}
                  <span className="text-slate-700 font-medium">
                    {billingProfile.defaultPaymentMethod
                      ? pmLabel(billingProfile.defaultPaymentMethod)
                      : billingProfile.savedPaymentMethodCount > 0
                        ? `${billingProfile.savedPaymentMethodCount} on file`
                        : 'None'}
                  </span>
                </span>
              </div>

              <div>
                <h3 className="text-[0.6875rem] font-medium uppercase tracking-wide text-slate-400 mb-1">
                  Active dues schedules
                </h3>
                {billingProfile.activeDuesSchedules.length === 0 ? (
                  <p className="text-sm text-slate-400">None.</p>
                ) : (
                  <ul className="space-y-1" role="list">
                    {billingProfile.activeDuesSchedules.map((s) => (
                      <li key={s.id} className="flex items-center justify-between gap-2 text-sm">
                        <span className="text-slate-700">
                          <span className="nums font-medium">{formatCents(s.amountCents)}</span> / {s.cadence} on day{' '}
                          {s.dayOfMonth}
                          {s.memo && <span className="text-slate-400"> — {s.memo}</span>}
                        </span>
                        {canManage && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={duesBusy}
                            onClick={() => void handleSetDuesActive(s.id, false)}
                          >
                            Deactivate
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Add dues schedule dialog */}
      <Dialog open={duesDialogOpen} onOpenChange={(o) => { if (!duesBusy) { setDuesDialogOpen(o); setDuesError(null); } }}>
        <DialogContent aria-describedby="add-dues-desc">
          <form onSubmit={(e) => void handleCreateDuesSchedule(e)}>
            <DialogHeader>
              <DialogTitle>Add a recurring dues schedule</DialogTitle>
              <DialogDescription id="add-dues-desc">
                Creates one DRAFT invoice per month for this member when you (or later, an automated run) generate
                dues for a period. This does NOT charge anything by itself.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              {duesError && (
                <Alert variant="destructive" role="alert">
                  <AlertCircle className="h-4 w-4" aria-hidden="true" />
                  <AlertDescription>{duesError}</AlertDescription>
                </Alert>
              )}
              <div className="space-y-1">
                <Label htmlFor="dues-amount">Monthly amount</Label>
                <Input
                  id="dues-amount"
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  placeholder="0.00"
                  value={duesAmountInput}
                  onChange={(e) => setDuesAmountInput(e.target.value)}
                  disabled={duesBusy}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="dues-day">Day of month</Label>
                <Input
                  id="dues-day"
                  type="number"
                  min="1"
                  max="28"
                  value={duesDayInput}
                  onChange={(e) => setDuesDayInput(e.target.value)}
                  disabled={duesBusy}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="dues-memo">Memo (optional)</Label>
                <Input
                  id="dues-memo"
                  type="text"
                  placeholder="e.g. Monthly club dues"
                  value={duesMemoInput}
                  onChange={(e) => setDuesMemoInput(e.target.value)}
                  disabled={duesBusy}
                  maxLength={500}
                />
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setDuesDialogOpen(false)} disabled={duesBusy}>
                Cancel
              </Button>
              <Button type="submit" disabled={duesBusy} aria-busy={duesBusy}>
                {duesBusy ? 'Adding…' : 'Add schedule'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Record payment dialog */}
      <Dialog open={dialogOpen} onOpenChange={(o) => { if (!busy) { setDialogOpen(o); setFormError(null); } }}>
        <DialogContent aria-describedby="record-payment-desc">
          <form onSubmit={(e) => void handleRecordPayment(e)}>
            <DialogHeader>
              <DialogTitle>Record a payment</DialogTitle>
              <DialogDescription id="record-payment-desc">
                Log a check, cash, or other external payment for this member. This does NOT charge a card — it is a
                manual acknowledgement that raises their account balance.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              {formError && (
                <Alert variant="destructive" role="alert">
                  <AlertCircle className="h-4 w-4" aria-hidden="true" />
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              )}
              <div className="space-y-1">
                <Label htmlFor="payment-amount">Amount</Label>
                <Input
                  id="payment-amount"
                  type="number"
                  inputMode="decimal"
                  min="0.01"
                  step="0.01"
                  placeholder="0.00"
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  disabled={busy}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="payment-method-note">Method / reference (optional)</Label>
                <Input
                  id="payment-method-note"
                  type="text"
                  placeholder="e.g. Check #1042, Cash at front desk"
                  value={methodNote}
                  onChange={(e) => setMethodNote(e.target.value)}
                  disabled={busy}
                  maxLength={200}
                />
              </div>
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy} aria-busy={busy}>
                {busy ? 'Recording…' : 'Record payment'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
