/**
 * add-resource-dialog.tsx — Dialog for adding a new resource (aircraft or instructor).
 *
 * Spec §5: kind select (Aircraft default/Instructor), display name, tail number
 * (aircraft only — N-number [VERIFY] FAA format), instructor user select (instructor only).
 * Kind switch clears the conditional field.
 *
 * N-number validation regex: ^N[0-9]{1,5}[A-Z]{0,2}$
 * [VERIFY] This regex is a best-effort approximation of FAA N-number format.
 * FAA rules are more nuanced (no "I" or "O" suffix letters, etc.).
 * This must be reviewed by a compliance officer before production use.
 */
'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { createResourceAction } from '../../actions';
import type { ResourceRow, OrgMemberRow } from '@aeroops/api';

// [VERIFY] FAA N-number format — see module comment above.
const N_NUMBER_RE = /^N[0-9]{1,5}[A-Z]{0,2}$/i;

interface AddResourceDialogProps {
  orgMembers: OrgMemberRow[];
  onSuccess: (resource: ResourceRow) => void;
}

interface FieldErrors {
  kind?: string;
  displayName?: string;
  tailNumber?: string;
  instructorUserId?: string;
}

export function AddResourceDialog({ orgMembers, onSuccess }: AddResourceDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<'aircraft' | 'instructor'>('aircraft');
  const [displayName, setDisplayName] = React.useState('');
  const [tailNumber, setTailNumber] = React.useState('');
  const [instructorUserId, setInstructorUserId] = React.useState('');
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  // Reset form when dialog opens
  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) {
      setKind('aircraft');
      setDisplayName('');
      setTailNumber('');
      setInstructorUserId('');
      setFieldErrors({});
      setServerError(null);
    }
  };

  const handleKindChange = (nextKind: 'aircraft' | 'instructor') => {
    setKind(nextKind);
    // Clear the conditional field when switching kind
    setTailNumber('');
    setInstructorUserId('');
    setFieldErrors({});
  };

  function validate(): boolean {
    const errors: FieldErrors = {};

    if (!displayName.trim()) {
      errors.displayName = 'Display name is required.';
    } else if (displayName.trim().length > 100) {
      errors.displayName = 'Display name must be 100 characters or fewer.';
    }

    if (kind === 'aircraft') {
      if (!tailNumber.trim()) {
        errors.tailNumber = 'Tail number is required for aircraft.';
      } else if (!N_NUMBER_RE.test(tailNumber.trim().toUpperCase())) {
        // [VERIFY] FAA N-number format validation — see module comment.
        // Note: [VERIFY] is intentionally omitted from the user-facing string;
        // it is an internal compliance marker and must not appear in operator UI.
        errors.tailNumber =
          'Tail number must be a valid N-number (for example N12345 or N123AB).';
      }
    }

    if (kind === 'instructor') {
      if (!instructorUserId) {
        errors.instructorUserId = 'An instructor user is required.';
      }
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);

    if (!validate()) return;

    setSubmitting(true);
    try {
      const result = await createResourceAction({
        kind,
        displayName: displayName.trim(),
        tailNumber: kind === 'aircraft' ? tailNumber.trim().toUpperCase() : undefined,
        instructorUserId: kind === 'instructor' ? instructorUserId : undefined,
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          setServerError(result.message);
        } else {
          setServerError('Something went wrong. Please try again.');
        }
        return;
      }

      setOpen(false);
      onSuccess(result.resource);
    } catch {
      setServerError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>+ Add Resource</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Resource</DialogTitle>
          <DialogDescription>
            Add an aircraft or instructor to make them available for booking.
          </DialogDescription>
        </DialogHeader>

        <form id="add-resource-form" onSubmit={handleSubmit} noValidate className="space-y-4 pt-2">
          {serverError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          )}

          {/* Kind */}
          <div className="space-y-1">
            <Label htmlFor="resource-kind">Kind</Label>
            <select
              id="resource-kind"
              value={kind}
              onChange={(e) => handleKindChange(e.target.value as 'aircraft' | 'instructor')}
              className="flex h-10 w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 hover:border-slate-400 dark:hover:border-slate-500 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0 transition-colors"
            >
              <option value="aircraft">Aircraft</option>
              <option value="instructor">Instructor</option>
            </select>
          </div>

          {/* Display name */}
          <div className="space-y-1">
            <Label htmlFor="resource-displayName">
              Display name <span aria-hidden="true">*</span>
            </Label>
            <Input
              id="resource-displayName"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                setFieldErrors((prev) => ({ ...prev, displayName: undefined }));
              }}
              maxLength={100}
              placeholder={kind === 'aircraft' ? 'e.g. Cessna 172 Skyhawk' : 'e.g. Jane Smith'}
              required
              aria-required="true"
              aria-describedby={fieldErrors.displayName ? 'displayName-error' : undefined}
              className={fieldErrors.displayName ? 'border-red-500' : ''}
            />
            {fieldErrors.displayName && (
              <p id="displayName-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
                {fieldErrors.displayName}
              </p>
            )}
          </div>

          {/* Tail number — aircraft only */}
          {kind === 'aircraft' && (
            <div className="space-y-1">
              <Label htmlFor="resource-tailNumber">
                Tail number (N-number) <span aria-hidden="true">*</span>
              </Label>
              <Input
                id="resource-tailNumber"
                value={tailNumber}
                onChange={(e) => {
                  setTailNumber(e.target.value.toUpperCase());
                  setFieldErrors((prev) => ({ ...prev, tailNumber: undefined }));
                }}
                placeholder="e.g. N12345"
                required
                aria-required="true"
                aria-describedby={fieldErrors.tailNumber ? 'tailNumber-error' : undefined}
                className={`font-mono ${fieldErrors.tailNumber ? 'border-red-500' : ''}`}
              />
              {fieldErrors.tailNumber && (
                <p id="tailNumber-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
                  {fieldErrors.tailNumber}
                </p>
              )}
            </div>
          )}

          {/* Instructor user — instructor only */}
          {kind === 'instructor' && (
            <div className="space-y-1">
              <Label htmlFor="resource-instructorUserId">
                Instructor user <span aria-hidden="true">*</span>
              </Label>
              <select
                id="resource-instructorUserId"
                value={instructorUserId}
                onChange={(e) => {
                  setInstructorUserId(e.target.value);
                  setFieldErrors((prev) => ({ ...prev, instructorUserId: undefined }));
                }}
                required
                aria-required="true"
                aria-describedby={fieldErrors.instructorUserId ? 'instructorUserId-error' : undefined}
                className={`flex h-10 w-full rounded-md border bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 hover:border-slate-400 dark:hover:border-slate-500 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0 transition-colors ${fieldErrors.instructorUserId ? 'border-red-500' : 'border-slate-300 dark:border-slate-700'}`}
              >
                <option value="">— Select CFI —</option>
                {orgMembers.map((m) => (
                  <option key={m.userId} value={m.userId}>
                    {m.displayName} ({m.email})
                  </option>
                ))}
              </select>
              {fieldErrors.instructorUserId && (
                <p id="instructorUserId-error" role="alert" className="text-sm text-red-600 dark:text-red-400">
                  {fieldErrors.instructorUserId}
                </p>
              )}
            </div>
          )}
        </form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="add-resource-form"
            disabled={submitting}
          >
            {submitting ? 'Adding…' : 'Add Resource'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
