/**
 * sell-block-client.tsx — "Sell a block" form (Slice B4).
 *
 * Flow: pick a member (required) → pick EITHER a package (from the active
 * catalog) OR enter an ad-hoc hours+amount → optional note → "Sell block"
 * posts an operator-recorded ledger credit (like recordManualPayment). NO
 * Stripe, NO card/bank data, NO money moved — this RECORDS that the member
 * paid.
 *
 * States:
 *   building   — member + package-or-adhoc selection.
 *   submitting — aria-busy, controls disabled.
 *   success    — sale recorded; links to the member's block summary; form resets.
 *   error      — inline Alert; input preserved.
 *
 * BOUNDARY: imports ONLY from local server actions + @aeroops/api types.
 * MONEY: ad-hoc price entered in dollars, converted to integer cents at the
 * boundary. NO Stripe, NO card/bank data.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { sellBlockToMemberAction } from '../actions';
import type { BillableMember, SerializedBlockPackage, SerializedBlockPurchase } from '../actions';
import { formatCents } from '../../_components/format-cents';

interface SellBlockClientProps {
  slug: string;
  members: BillableMember[];
  activePackages: SerializedBlockPackage[];
}

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

export function SellBlockClient({ slug, members, activePackages }: SellBlockClientProps) {
  const [memberId, setMemberId] = React.useState('');
  const [mode, setMode] = React.useState<'package' | 'adhoc'>(activePackages.length > 0 ? 'package' : 'adhoc');
  const [packageId, setPackageId] = React.useState('');
  const [hours, setHours] = React.useState('');
  const [amountDollars, setAmountDollars] = React.useState('');
  const [note, setNote] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [success, setSuccess] = React.useState<{ purchase: SerializedBlockPurchase; balanceCentsAfter: number } | null>(
    null,
  );

  function reasonCopy(reason: string): string {
    switch (reason) {
      case 'member_not_found':
        return 'That member could not be found. They may have been removed.';
      case 'package_not_found':
        return 'That package could not be found. It may have been removed.';
      case 'package_inactive':
        return 'That package is no longer active. Reactivate it or choose a different package.';
      default:
        return 'Could not record the sale. Please try again.';
    }
  }

  async function handleSell(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (memberId.length === 0) {
      setError('Select a member.');
      return;
    }

    let payload: Parameters<typeof sellBlockToMemberAction>[0];
    if (mode === 'package') {
      if (packageId.length === 0) {
        setError('Select a package.');
        return;
      }
      payload = { memberId, packageId, note: note.trim() || undefined };
    } else {
      const parsedHours = parseHours(hours);
      if (parsedHours === null) {
        setError('Hours must be a positive number with at most 1 decimal place (e.g. 3 or 3.5).');
        return;
      }
      const amountCents = parseDollarsToCents(amountDollars);
      if (amountCents === null) {
        setError('Amount must be a positive dollar amount (e.g. 425.00).');
        return;
      }
      payload = { memberId, hours: parsedHours, amountCents, note: note.trim() || undefined };
    }

    setSubmitting(true);
    try {
      const result = await sellBlockToMemberAction(payload, slug);
      if ('error' in result) {
        setError(result.error === 'validation' ? result.message : 'Could not record the sale. Please try again.');
        return;
      }
      if (!result.ok) {
        setError(reasonCopy(result.reason));
        return;
      }
      setSuccess({ purchase: result.purchase, balanceCentsAfter: result.balanceCentsAfter });
      setMemberId('');
      setPackageId('');
      setHours('');
      setAmountDollars('');
      setNote('');
    } finally {
      setSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="space-y-4">
        <Alert role="status">
          <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden="true" />
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>
              Block sold — {success.purchase.hours} hrs / {formatCents(success.purchase.amountCents)}. New balance:{' '}
              {formatCents(success.balanceCentsAfter)}.
            </span>
            <Button asChild variant="outline" size="sm">
              <Link href={`/o/${slug}/billing/block-time/${success.purchase.memberUserId}`}>View member summary</Link>
            </Button>
          </AlertDescription>
        </Alert>
        <Button size="sm" onClick={() => setSuccess(null)}>
          Sell another block
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSell} className="space-y-4 rounded-md border border-slate-200 p-4">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="sell-block-member">Member (required)</Label>
        <select
          id="sell-block-member"
          value={memberId}
          onChange={(e) => setMemberId(e.target.value)}
          disabled={submitting}
          aria-required="true"
          className="flex h-10 w-full max-w-md rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-400 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
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

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-700">Block</legend>
        <div className="flex gap-4">
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="radio"
              name="sell-block-mode"
              checked={mode === 'package'}
              onChange={() => setMode('package')}
              disabled={submitting || activePackages.length === 0}
            />
            From a package
          </label>
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="radio"
              name="sell-block-mode"
              checked={mode === 'adhoc'}
              onChange={() => setMode('adhoc')}
              disabled={submitting}
            />
            Ad-hoc
          </label>
        </div>

        {mode === 'package' ? (
          <div className="space-y-1.5">
            <Label htmlFor="sell-block-package">Package</Label>
            <select
              id="sell-block-package"
              value={packageId}
              onChange={(e) => setPackageId(e.target.value)}
              disabled={submitting}
              className="flex h-10 w-full max-w-md rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-400 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
            >
              <option value="">— Select package —</option>
              {activePackages.map((pkg) => (
                <option key={pkg.id} value={pkg.id}>
                  {pkg.name} — {pkg.hours} hrs / {formatCents(pkg.priceCents)}
                </option>
              ))}
              {activePackages.length === 0 && <option disabled>No active packages</option>}
            </select>
          </div>
        ) : (
          <div className="flex flex-wrap gap-3">
            <div className="space-y-1.5 w-28">
              <Label htmlFor="sell-block-hours">Hours</Label>
              <Input
                id="sell-block-hours"
                inputMode="decimal"
                placeholder="3.5"
                value={hours}
                onChange={(e) => setHours(e.target.value)}
                disabled={submitting}
              />
            </div>
            <div className="space-y-1.5 w-32">
              <Label htmlFor="sell-block-amount">Amount (USD)</Label>
              <Input
                id="sell-block-amount"
                inputMode="decimal"
                placeholder="425.00"
                value={amountDollars}
                onChange={(e) => setAmountDollars(e.target.value)}
                disabled={submitting}
              />
            </div>
          </div>
        )}
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="sell-block-note">Note (optional)</Label>
        <Input
          id="sell-block-note"
          placeholder="Paid by check #1042"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={submitting}
        />
      </div>

      <Button type="submit" disabled={submitting} aria-busy={submitting}>
        {submitting ? 'Recording…' : 'Sell block'}
      </Button>
    </form>
  );
}
