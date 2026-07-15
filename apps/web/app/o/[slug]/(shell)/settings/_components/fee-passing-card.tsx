/**
 * fee-passing-card.tsx — org setting: pass the ACH processing fee to the member
 * (fee-passing feature, migration 0045).
 *
 * Rendered on /o/[slug]/settings (page-level org:manage_settings gate). The
 * server action re-enforces the cap — this component never trusts the page gate
 * alone. The initial setting is fetched server-side and passed in.
 *
 * States:
 *   available + off / available + on — the toggle.
 *   unavailable (available:false)     — 0045 not applied yet; disabled + note.
 *   error                             — inline Alert.
 *
 * BOUNDARY: imports ONLY from local server actions + UI. No @aeroops/db.
 * NO card/bank data — this is a pure boolean toggle (the fee amount is computed
 * at checkout from the invoice/balance amount).
 */
'use client';

import * as React from 'react';
import { AlertCircle, Percent } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { toast } from '@/lib/toast-store';
import type { FeePassingView } from '@aeroops/api';
import { setFeePassingAction } from '../actions';

interface FeePassingCardProps {
  slug: string;
  initial: FeePassingView;
}

export function FeePassingCard({ slug, initial }: FeePassingCardProps) {
  const [enabled, setEnabled] = React.useState(initial.passAchFeeToMember);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const available = initial.available;

  async function handleToggle(next: boolean) {
    setError(null);
    setBusy(true);
    try {
      const result = await setFeePassingAction(slug, next);
      if ('error' in result) {
        setError('Could not update the fee setting. Please try again.');
        return;
      }
      if (!result.ok) {
        setError('This setting isn’t available yet.');
        return;
      }
      setEnabled(result.passAchFeeToMember);
      toast.success(
        result.passAchFeeToMember
          ? 'Members will now see the processing fee at checkout.'
          : 'Processing fee is no longer passed to members.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Percent className="h-4 w-4 text-slate-400 dark:text-slate-500" aria-hidden="true" />
          Card &amp; ACH processing fees
        </CardTitle>
      </CardHeader>
      <Separator />
      <CardContent className="pt-6 space-y-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Pass the payment processing fee through to the member at checkout. When on, members
          paying an invoice or their balance in the portal see a{' '}
          <span className="font-medium text-slate-700 dark:text-slate-300">
            &ldquo;Processing fee (1%, max $7)&rdquo;
          </span>{' '}
          line added to their total. When off (the default), your operation absorbs the fee and
          members pay exactly the invoice amount.
        </p>

        {error && (
          <Alert variant="destructive" role="alert">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!available ? (
          <Alert role="status">
            <AlertCircle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription>
              Fee passing becomes available in an upcoming update. Nothing changes until then —
              members are never charged a processing fee.
            </AlertDescription>
          </Alert>
        ) : (
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-slate-700 dark:text-slate-300">
              {enabled ? 'Fee passing is ON' : 'Fee passing is OFF'}
            </p>
            {enabled ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                aria-busy={busy}
                onClick={() => void handleToggle(false)}
              >
                Turn off
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                disabled={busy}
                aria-busy={busy}
                onClick={() => void handleToggle(true)}
              >
                Turn on fee passing
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
