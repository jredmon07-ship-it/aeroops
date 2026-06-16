/**
 * conflict-banner.tsx — Live conflict preview banner for the new reservation form.
 *
 * Spec §4 banner states:
 *   1. idle    → hidden
 *   2. checking → Alert + Loader2 "Checking availability…" (aria-live="polite")
 *   3. clear   → CheckCircle2 green "This time slot is available…" (aria-live="polite")
 *   4. conflict → Alert destructive + XCircle + bullets (aria-live="assertive")
 *   5. error   → "Availability check failed. You can still try submitting."
 */
import * as React from 'react';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { formatTimeRange } from '../../_utils/format-time';
import type { ConflictCheckState } from '../_hooks/use-conflict-check';
import type { ConflictHit } from '@aeroops/api';

interface ConflictBannerProps {
  state: ConflictCheckState;
  conflicts: ConflictHit[];
  /** Optional: override conflicts for the hard "submit-failed" variant */
  submitConflicts?: ConflictHit[];
}

export function ConflictBanner({ state, conflicts, submitConflicts }: ConflictBannerProps) {
  // Hard submit conflicts take precedence over live preview
  if (submitConflicts && submitConflicts.length > 0) {
    return (
      <Alert variant="destructive" role="alert" aria-live="assertive">
        <XCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription>
          <p className="font-medium mb-1">
            This reservation could not be booked because of a conflict:
          </p>
          <ul className="list-disc list-inside space-y-0.5 text-sm">
            {submitConflicts.map((hit) => (
              <li key={`${hit.resourceId}-${hit.start.toString()}`}>
                {hit.resourceDisplayName} is booked{' '}
                {formatTimeRange(hit.start, hit.end)}
              </li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    );
  }

  if (state === 'idle') return null;

  if (state === 'checking') {
    return (
      <Alert role="status" aria-live="polite" className="border-slate-200 bg-slate-50">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        <AlertDescription>Checking availability…</AlertDescription>
      </Alert>
    );
  }

  if (state === 'clear') {
    return (
      <div role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-green-700 py-2">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>This time slot is available for all selected resources.</span>
      </div>
    );
  }

  if (state === 'conflict') {
    return (
      <Alert variant="destructive" role="alert" aria-live="assertive">
        <XCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription>
          <p className="font-medium mb-1">This time slot has conflict(s):</p>
          <ul className="list-disc list-inside space-y-0.5 text-sm">
            {conflicts.map((hit) => (
              <li key={`${hit.resourceId}-${hit.start.toString()}`}>
                {hit.resourceDisplayName} is booked{' '}
                {formatTimeRange(hit.start, hit.end)}
              </li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    );
  }

  // state === 'error'
  return (
    <Alert className="border-amber-200 bg-amber-50 text-amber-800" role="status" aria-live="polite">
      <AlertDescription>
        Availability check failed. You can still try submitting.
      </AlertDescription>
    </Alert>
  );
}
