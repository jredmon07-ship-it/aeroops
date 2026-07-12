/**
 * dispatch-requirements-card.tsx — "Dispatch requirements" card for the
 * fleet detail page (Slice 3c / ADR-0009).
 *
 * Shows free-text required tags on an aircraft. Pilots must carry a matching
 * member tag to be checked out when requirements are set.
 *
 * States:
 *   loading    — Skeleton placeholder (shown as suspense fallback).
 *   empty      — "No dispatch requirements." notice + optional Add button.
 *   populated  — Tag chips with remove control (canManageRequirements only).
 *   error      — Non-fatal inline alert; board still renders.
 *
 * [VERIFY-3c-A] Tags are FREE-TEXT operator labels ONLY. No FAA currency,
 * medical, flight-review, Part 61/141, or endorsement determination is
 * computed here. Eligibility enforcement = operator enforcing their own rule.
 *
 * BOUNDARY: imports ONLY from @aeroops/api. Never @aeroops/db.
 */
'use client';

import * as React from 'react';
import { ShieldCheck, Plus, X, Loader2, XCircle, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import {
  getResourceRequiredTagsAction,
  addResourceRequiredTagAction,
  removeResourceRequiredTagAction,
} from '../../dispatch-gate-actions';
import type { SerializedRequiredTagView } from '../../dispatch-gate-actions';

// ─── Props ────────────────────────────────────────────────────────────────────

interface DispatchRequirementsCardProps {
  resourceId: string;
  /**
   * Whether the session has dispatch:manage_requirements.
   * Controls visibility of Add / Remove controls.
   * The server action re-gates independently.
   */
  canManageRequirements: boolean;
}

// ─── Add requirement dialog ────────────────────────────────────────────────────

interface AddRequirementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceId: string;
  onSuccess: (tags: SerializedRequiredTagView[]) => void;
}

function AddRequirementDialog({
  open,
  onOpenChange,
  resourceId,
  onSuccess,
}: AddRequirementDialogProps) {
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setValue('');
    setError(null);
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) {
      setError('Tag cannot be empty.');
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await addResourceRequiredTagAction({ resourceId, requiredTag: trimmed });
      if ('error' in result) {
        if (result.error === 'validation') {
          setError(result.message);
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setError('You do not have permission to add requirements.');
          return;
        }
        setError('Something went wrong. Please try again.');
        return;
      }
      if (!result.ok) {
        if (result.reason === 'duplicate') {
          setError(`Tag "${trimmed}" is already required for this aircraft.`);
          return;
        }
        if (result.reason === 'not_found') {
          setError('Aircraft not found or inactive.');
          return;
        }
        setError('Something went wrong. Please try again.');
        return;
      }
      onSuccess(result.tags);
      onOpenChange(false);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add dispatch requirement</DialogTitle>
        </DialogHeader>

        {/* [VERIFY-3c-A] operator-data copy; no currency/endorsement implication */}
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Required tags are free-text labels you define. A pilot must carry a
          matching tag to be checked out in this aircraft.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="dr-tag-input">
              Tag <span aria-hidden="true" className="text-red-500 dark:text-red-400">*</span>
            </Label>
            <Input
              id="dr-tag-input"
              type="text"
              placeholder="e.g. Complex, High-Performance, Tailwheel"
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setError(null);
              }}
              disabled={isSubmitting}
              maxLength={200}
              aria-required="true"
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={error ? 'dr-tag-err' : undefined}
              className={error ? 'border-red-500' : ''}
            />
            {error && (
              <p id="dr-tag-err" role="alert" className="text-xs text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" autoFocus disabled={isSubmitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isSubmitting} isLoading={isSubmitting}>
              Add requirement
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main card ────────────────────────────────────────────────────────────────

export function DispatchRequirementsCard({
  resourceId,
  canManageRequirements,
}: DispatchRequirementsCardProps) {
  const [tags, setTags] = React.useState<SerializedRequiredTagView[] | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState(false);
  const [addDialogOpen, setAddDialogOpen] = React.useState(false);
  const [removingIds, setRemovingIds] = React.useState<Set<string>>(new Set());
  const [removeErrors, setRemoveErrors] = React.useState<Record<string, string>>({});

  // ── Load tags on mount ────────────────────────────────────────────────────
  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);

    getResourceRequiredTagsAction({ resourceId })
      .then((result) => {
        if (cancelled) return;
        setLoading(false);
        if ('error' in result || !result.ok) {
          setLoadError(true);
          return;
        }
        setTags(result.tags);
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
          setLoadError(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [resourceId]);

  // ── Remove handler ────────────────────────────────────────────────────────
  async function handleRemove(requirementId: string, tag: string) {
    setRemovingIds((prev) => new Set(prev).add(requirementId));
    setRemoveErrors((prev) => {
      const next = { ...prev };
      delete next[requirementId];
      return next;
    });
    try {
      const result = await removeResourceRequiredTagAction({ resourceId, requirementId });
      if ('error' in result) {
        setRemoveErrors((prev) => ({
          ...prev,
          [requirementId]: 'Could not remove requirement. Try again.',
        }));
        return;
      }
      if (!result.ok) {
        setRemoveErrors((prev) => ({
          ...prev,
          [requirementId]: result.reason === 'not_found'
            ? 'Requirement not found.'
            : 'Could not remove requirement.',
        }));
        return;
      }
      setTags(result.tags);
    } catch {
      setRemoveErrors((prev) => ({
        ...prev,
        [requirementId]: 'Could not remove requirement. Try again.',
      }));
    } finally {
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(requirementId);
        return next;
      });
    }
    // suppress unused variable warning
    void tag;
  }

  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-3">
      {/* ── Card header ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-slate-400 dark:text-slate-500" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
            Dispatch requirements
          </h2>
          {!loading && !loadError && tags !== null && tags.length > 0 && (
            <span className="inline-flex items-center rounded-sm border border-brand/30 bg-brand/8 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-brand-ink">
              {tags.length}
            </span>
          )}
        </div>
        {canManageRequirements && !loading && !loadError && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAddDialogOpen(true)}
            aria-label="Add dispatch requirement"
          >
            <Plus className="h-4 w-4 mr-1" aria-hidden="true" />
            Add requirement
          </Button>
        )}
      </div>

      {/* ── [VERIFY-3c-A] operator-data framing ─────────────────────────── */}
      <p className="text-xs text-slate-400 dark:text-slate-500">
        Required tags (free-text labels you define). A pilot must carry a matching
        tag to be checked out in this aircraft. These are operator-defined labels
        only — no regulatory or eligibility determination is computed.
      </p>

      {/* ── Loading ──────────────────────────────────────────────────────── */}
      {loading && (
        <div className="space-y-2 animate-pulse" aria-busy="true" aria-label="Loading dispatch requirements">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-6 w-32" />
        </div>
      )}

      {/* ── Non-fatal load error ─────────────────────────────────────────── */}
      {!loading && loadError && (
        <Alert role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription className="text-sm">
            Could not load requirements. Refresh to try again.
          </AlertDescription>
        </Alert>
      )}

      {/* ── Empty state ───────────────────────────────────────────────────── */}
      {!loading && !loadError && tags !== null && tags.length === 0 && (
        <p className="text-sm text-slate-400 dark:text-slate-500 italic">
          No dispatch requirements. Any qualified pilot can be checked out in this aircraft.
        </p>
      )}

      {/* ── Tag chips ────────────────────────────────────────────────────── */}
      {!loading && !loadError && tags !== null && tags.length > 0 && (
        <div
          className="flex flex-wrap gap-1.5"
          role="list"
          aria-label="Required dispatch tags"
        >
          {tags.map((t) => (
            <span
              key={t.id}
              role="listitem"
              className="inline-flex items-center gap-1 rounded-sm border border-brand/30 bg-brand/8 px-2 py-0.5 text-xs font-medium text-brand-ink"
            >
              {t.requiredTag}
              {canManageRequirements && (
                <button
                  type="button"
                  onClick={() => handleRemove(t.id, t.requiredTag)}
                  disabled={removingIds.has(t.id)}
                  aria-label={`Remove requirement: ${t.requiredTag}`}
                  className="ml-0.5 rounded-sm text-brand/60 hover:text-red-500 dark:hover:text-red-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500 disabled:opacity-50"
                >
                  {removingIds.has(t.id) ? (
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  ) : (
                    <X className="h-3 w-3" aria-hidden="true" />
                  )}
                </button>
              )}
              {removeErrors[t.id] && (
                <span className="text-xs text-red-600 dark:text-red-400 ml-1" role="alert">
                  {removeErrors[t.id]}
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Remove errors for all tags (in case chip error is clipped) */}
      {Object.keys(removeErrors).length > 0 && (
        <Alert variant="destructive" role="alert">
          <XCircle className="h-4 w-4" aria-hidden="true" />
          <AlertDescription className="text-sm">
            {Object.values(removeErrors)[0]}
          </AlertDescription>
        </Alert>
      )}

      {/* ── Add requirement dialog ───────────────────────────────────────── */}
      <AddRequirementDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        resourceId={resourceId}
        onSuccess={(updatedTags) => {
          setTags(updatedTags);
        }}
      />
    </div>
  );
}
