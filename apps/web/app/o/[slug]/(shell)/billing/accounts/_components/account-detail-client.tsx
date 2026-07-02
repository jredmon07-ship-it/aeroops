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
import { recordManualPaymentAction, listLedgerEntriesAction } from '../../actions';
import type { SerializedLedgerEntry } from '../../actions';
import { formatCents } from '../../_components/format-cents';

interface AccountDetailClientProps {
  memberId: string;
  slug: string;
  balanceCents: number;
  minimumBalanceCents: number;
  initialEntries: SerializedLedgerEntry[];
  canManage: boolean;
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
}: AccountDetailClientProps) {
  const [balanceCents, setBalanceCents] = React.useState(initialBalanceCents);
  const [entries, setEntries] = React.useState(initialEntries);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [amountInput, setAmountInput] = React.useState('');
  const [methodNote, setMethodNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

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
