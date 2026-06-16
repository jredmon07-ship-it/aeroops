/**
 * conflict-banner.tsx — Live combined conflict + policy preview banner.
 *
 * Spec §3.2 (Slice 2a) banner states:
 *   1. idle              → hidden
 *   2. checking          → Alert + Loader2 "Checking availability…" (aria-live="polite")
 *   3. clear             → CheckCircle2 green (aria-live="polite")
 *   4. conflict          → Alert destructive + XCircle + conflict bullets (FROZEN, unchanged)
 *   5. policy            → Alert destructive + XCircle + policy bullets
 *   6. conflict_and_policy → both sections rendered
 *   7. error             → "Availability check failed. You can still try submitting."
 *
 * Hard submit path: submitConflicts / submitViolations override the live preview
 * with hard-block framing ("This reservation could not be booked:").
 *
 * A11y: role=alert / aria-live="assertive" on destructive; role=status /
 * aria-live="polite" on informational — mirrors Slice-1 §4 posture.
 */
import * as React from 'react';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { formatTimeRange, formatTime } from '../../_utils/format-time';
import type { ConflictCheckState } from '../_hooks/use-conflict-check';
import type { ConflictHit, PolicyViolationView } from '@aeroops/api';

interface ConflictBannerProps {
  state: ConflictCheckState;
  conflicts: ConflictHit[];
  policyViolations?: PolicyViolationView[];
  /** Optional: override for the hard "submit-failed" variant — conflicts section */
  submitConflicts?: ConflictHit[];
  /** Optional: override for the hard "submit-failed" variant — policy section */
  submitViolations?: PolicyViolationView[];
}

/** Format epoch ms to local HH:mm string. */
function epochToHHmm(epochMs: number): string {
  return formatTime(new Date(epochMs));
}

/** Render one policy violation bullet per spec §3.2 copy. */
function PolicyViolationBullet({ v }: { v: PolicyViolationView }) {
  switch (v.kind) {
    case 'max_duration_exceeded':
      return (
        <li>
          Maximum booking length is {v.limitMinutes} min; this is {v.actualMinutes} min.
        </li>
      );
    case 'too_far_in_advance':
      return (
        <li>
          Bookings can be made at most {v.limitDays} days ahead.
        </li>
      );
    case 'insufficient_lead_time':
      return (
        <li>
          Bookings require at least {v.requiredMinutes} min lead time.
        </li>
      );
    case 'blackout_overlap':
      return (
        <li>
          {v.resourceDisplayName} is unavailable {epochToHHmm(v.blackoutStart)}–{epochToHHmm(v.blackoutEnd)} (blackout).
        </li>
      );
    default:
      return null;
  }
}

/** Derive a stable, unique React key for a PolicyViolationView array element. */
function policyViolationKey(v: PolicyViolationView, i: number): string {
  if (v.kind === 'blackout_overlap') {
    return `${v.resourceId}-blackout-${v.blackoutStart}-${v.blackoutEnd}`;
  }
  // For the three non-blackout kinds each resource can only produce one violation
  // per kind, so resourceId+kind is unique. The index is a safety fallback.
  return `${v.resourceId}-${v.kind}-${i}`;
}

export function ConflictBanner({
  state,
  conflicts,
  policyViolations = [],
  submitConflicts,
  submitViolations,
}: ConflictBannerProps) {
  // Hard submit result takes precedence over live preview
  const hasSubmitConflicts = submitConflicts && submitConflicts.length > 0;
  const hasSubmitViolations = submitViolations && submitViolations.length > 0;

  if (hasSubmitConflicts || hasSubmitViolations) {
    return (
      <Alert variant="destructive" role="alert" aria-live="assertive">
        <XCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription>
          <p className="font-medium mb-1">
            This reservation could not be booked:
          </p>
          {hasSubmitConflicts && (
            <>
              <p className="font-medium text-sm mb-0.5">Conflicts:</p>
              <ul className="list-disc list-inside space-y-0.5 text-sm mb-1">
                {submitConflicts!.map((hit) => (
                  <li key={`${hit.resourceId}-${hit.start.toString()}`}>
                    {hit.resourceDisplayName} is booked{' '}
                    {formatTimeRange(hit.start, hit.end)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {hasSubmitViolations && (
            <>
              <p className="font-medium text-sm mb-0.5">Booking rules not met:</p>
              <ul className="list-disc list-inside space-y-0.5 text-sm">
                {submitViolations!.map((v, i) => (
                  <PolicyViolationBullet key={policyViolationKey(v, i)} v={v} />
                ))}
              </ul>
            </>
          )}
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
        <span>This time slot is available and meets all booking rules.</span>
      </div>
    );
  }

  // conflict only (FROZEN Slice-1 arm — unchanged)
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

  // policy only
  if (state === 'policy') {
    return (
      <Alert variant="destructive" role="alert" aria-live="assertive">
        <XCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription>
          <p className="font-medium mb-1">
            This time slot does not meet the booking rules:
          </p>
          <ul className="list-disc list-inside space-y-0.5 text-sm">
            {policyViolations.map((v, i) => (
              <PolicyViolationBullet key={policyViolationKey(v, i)} v={v} />
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    );
  }

  // conflict_and_policy — both sections
  if (state === 'conflict_and_policy') {
    return (
      <Alert variant="destructive" role="alert" aria-live="assertive">
        <XCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription>
          <p className="font-medium mb-1">This time slot has conflict(s) and does not meet the booking rules:</p>
          <p className="font-medium text-sm mb-0.5">Conflicts:</p>
          <ul className="list-disc list-inside space-y-0.5 text-sm mb-2">
            {conflicts.map((hit) => (
              <li key={`${hit.resourceId}-${hit.start.toString()}`}>
                {hit.resourceDisplayName} is booked{' '}
                {formatTimeRange(hit.start, hit.end)}
              </li>
            ))}
          </ul>
          <p className="font-medium text-sm mb-0.5">Booking rules not met:</p>
          <ul className="list-disc list-inside space-y-0.5 text-sm">
            {policyViolations.map((v, i) => (
              <PolicyViolationBullet key={policyViolationKey(v, i)} v={v} />
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
