/**
 * new-reservation-form.tsx — Full booking form with live conflict preview.
 *
 * Client component. Fed initial resources + slug from the RSC page.
 * Spec §4: date, start/end times, aircraft select, optional instructor select,
 * notes textarea, conflict banner, dirty-form guard, submit handling.
 */
'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { PlaneTakeoff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ConflictBanner } from './conflict-banner';
import { useConflictCheck } from '../_hooks/use-conflict-check';
import { createReservationAction } from '../../actions';
import { toDateInputValue } from '../../_utils/format-time';
import type { ResourceRow, ConflictHit, PolicyViolationView } from '@aeroops/api';

interface NewReservationFormProps {
  resources: ResourceRow[];
  slug: string;
  /** Initial date from ?date= query param — YYYY-MM-DD or empty */
  initialDate: string;
  canManageResources: boolean;
  /** href for the "Back to Schedule" button rendered inside this client boundary */
  backHref: string;
}

interface FieldErrors {
  date?: string;
  startTime?: string;
  endTime?: string;
  resources?: string;
  notes?: string;
}

export function NewReservationForm({
  resources,
  slug,
  initialDate,
  canManageResources,
  backHref,
}: NewReservationFormProps) {
  const router = useRouter();
  const dateRef = React.useRef<HTMLInputElement>(null);
  const errorRef = React.useRef<HTMLDivElement>(null);

  const [date, setDate] = React.useState(initialDate || toDateInputValue(new Date()));
  const [startTime, setStartTime] = React.useState('');
  const [endTime, setEndTime] = React.useState('');
  const [aircraftId, setAircraftId] = React.useState('');
  const [instructorId, setInstructorId] = React.useState('');
  const [notes, setNotes] = React.useState('');

  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [submitConflicts, setSubmitConflicts] = React.useState<ConflictHit[]>([]);
  const [submitViolations, setSubmitViolations] = React.useState<PolicyViolationView[]>([]);
  const [submitting, setSubmitting] = React.useState(false);

  // Dirty-form guard state
  const [pendingNav, setPendingNav] = React.useState<string | null>(null);

  // Filter resources by kind and active only
  const aircraft = resources
    .filter((r) => r.kind === 'aircraft' && r.active)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const instructors = resources
    .filter((r) => r.kind === 'instructor' && r.active)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  const noResources = aircraft.length === 0 && instructors.length === 0;

  // Build resourceIds for conflict check and submission
  const resourceIds = React.useMemo(() => {
    const ids: string[] = [];
    if (aircraftId) ids.push(aircraftId);
    if (instructorId) ids.push(instructorId);
    return ids;
  }, [aircraftId, instructorId]);

  // Live combined conflict + policy preview
  const { state: conflictState, conflicts, policyViolations } = useConflictCheck({
    date,
    startTime,
    endTime,
    resourceIds,
  });

  // Is form "dirty" (has user entered anything)?
  const isDirty = !!(
    (date && date !== toDateInputValue(new Date())) ||
    startTime ||
    endTime ||
    aircraftId ||
    instructorId ||
    notes
  );

  // beforeunload: guard on refresh / tab-close when form is dirty (spec §4)
  React.useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        // Modern browsers ignore the returned string but require returnValue to be set.
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // Autofocus date on mount
  React.useEffect(() => {
    dateRef.current?.focus();
  }, []);

  // Client-side validation
  function validate(): boolean {
    const errors: FieldErrors = {};

    if (!date) {
      errors.date = 'Date is required.';
    }

    if (!startTime) {
      errors.startTime = 'Start time is required.';
    }

    if (!endTime) {
      errors.endTime = 'End time is required.';
    } else if (startTime && endTime) {
      const s = new Date(`${date}T${startTime}:00`);
      const e = new Date(`${date}T${endTime}:00`);
      if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && e <= s) {
        errors.endTime = 'End time must be after start time.';
      }
    }

    if (resourceIds.length === 0) {
      errors.resources = 'Select at least one resource.';
    }

    setFieldErrors(errors);

    if (Object.keys(errors).length > 0) {
      // Focus first error field
      if (errors.date) dateRef.current?.focus();
      return false;
    }

    return true;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    setSubmitConflicts([]);
    setSubmitViolations([]);

    if (!validate()) return;

    setSubmitting(true);

    try {
      const startAt = new Date(`${date}T${startTime}:00`);
      const endAt = new Date(`${date}T${endTime}:00`);

      const result = await createReservationAction({
        startAt,
        endAt,
        resourceIds,
        notes: notes.trim() || undefined,
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          setServerError(`Invalid reservation: ${result.message}`);
          errorRef.current?.focus();
        } else {
          setServerError('Something went wrong. Please try again.');
          errorRef.current?.focus();
        }
        return;
      }

      if (!result.ok) {
        // Map all four ok:false arms — render via banner with hard-block framing
        if (result.reason === 'conflict_and_policy') {
          setSubmitConflicts(result.conflicts);
          setSubmitViolations(result.violations);
        } else if (result.reason === 'policy') {
          setSubmitConflicts([]);
          setSubmitViolations(result.violations);
        } else {
          // reason === 'conflict' — FROZEN Slice-1 arm
          setSubmitConflicts(result.conflicts);
          setSubmitViolations([]);
        }
        return;
      }

      // Success — redirect to list with date+start+end for spec §4 copy
      router.push(
        `/o/${slug}/schedule?date=${date}&success=1&start=${encodeURIComponent(startTime)}&end=${encodeURIComponent(endTime)}`,
      );
    } catch {
      setServerError('Something went wrong. Please try again.');
      errorRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * Generic navigation guard for any exit affordance the form owns.
   * If the form is dirty, intercept and open the discard dialog; otherwise
   * let the navigation proceed immediately.
   */
  function handleGuardedNav(e: React.MouseEvent, href: string) {
    if (isDirty) {
      e.preventDefault();
      setPendingNav(href);
    }
  }

  function handleCancelClick(e: React.MouseEvent) {
    handleGuardedNav(e, `/o/${slug}/schedule?date=${date}`);
  }

  function handleBackClick(e: React.MouseEvent) {
    handleGuardedNav(e, backHref);
  }

  // Empty state: no resources to book
  if (noResources) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center space-y-4">
        <PlaneTakeoff className="h-12 w-12 text-slate-300" aria-hidden="true" />
        <div className="space-y-2">
          <p className="text-slate-700 font-medium">No resources to book yet.</p>
          <p className="text-sm text-slate-500 max-w-sm">
            An administrator must add at least one aircraft or instructor before
            you can create a reservation.
          </p>
        </div>
        {canManageResources && (
          <Button asChild variant="outline">
            <Link href={`/o/${slug}/schedule/resources`}>Add a Resource</Link>
          </Button>
        )}
      </div>
    );
  }

  return (
    <>
      {/* "Back to Schedule" button — rendered here (client boundary) so it
          participates in the dirty-form guard (spec §4). The RSC page renders
          only the <h1> heading. */}
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleBackClick}
          asChild={!isDirty}
        >
          {isDirty ? (
            <span>Back to Schedule</span>
          ) : (
            <Link href={backHref}>Back to Schedule</Link>
          )}
        </Button>
      </div>

      {/* Dirty-form guard dialog */}
      <AlertDialog open={pendingNav !== null} onOpenChange={(open) => { if (!open) setPendingNav(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard reservation?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Leaving this page will discard them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus onClick={() => setPendingNav(null)}>
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingNav) router.push(pendingNav);
              }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <form onSubmit={handleSubmit} noValidate className="space-y-6 max-w-lg">
        {/* Server / validation error */}
        {serverError && (
          <Alert
            ref={errorRef}
            variant="destructive"
            role="alert"
            tabIndex={-1}
          >
            <AlertDescription>{serverError}</AlertDescription>
          </Alert>
        )}

        {/* Submit-blocked banner (conflict and/or policy) */}
        {(submitConflicts.length > 0 || submitViolations.length > 0) && (
          <ConflictBanner
            state="conflict"
            conflicts={[]}
            submitConflicts={submitConflicts}
            submitViolations={submitViolations}
          />
        )}

        {/* Date */}
        <div className="space-y-1">
          <Label htmlFor="date">
            Date <span aria-hidden="true">*</span>
          </Label>
          <Input
            ref={dateRef}
            id="date"
            type="date"
            value={date}
            onChange={(e) => {
              setDate(e.target.value);
              setFieldErrors((prev) => ({ ...prev, date: undefined }));
            }}
            required
            aria-required="true"
            aria-describedby={fieldErrors.date ? 'date-error' : undefined}
            className={fieldErrors.date ? 'border-red-500' : ''}
          />
          {fieldErrors.date && (
            <p id="date-error" role="alert" className="text-sm text-red-600">
              {fieldErrors.date}
            </p>
          )}
        </div>

        {/* Start / End times — side-by-side at sm */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="startTime">
              Start time <span aria-hidden="true">*</span>
            </Label>
            <Input
              id="startTime"
              type="time"
              step={300}
              value={startTime}
              onChange={(e) => {
                setStartTime(e.target.value);
                setFieldErrors((prev) => ({ ...prev, startTime: undefined }));
              }}
              required
              aria-required="true"
              aria-describedby={fieldErrors.startTime ? 'startTime-error' : undefined}
              className={fieldErrors.startTime ? 'border-red-500' : ''}
            />
            {fieldErrors.startTime && (
              <p id="startTime-error" role="alert" className="text-sm text-red-600">
                {fieldErrors.startTime}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor="endTime">
              End time <span aria-hidden="true">*</span>
            </Label>
            <Input
              id="endTime"
              type="time"
              step={300}
              value={endTime}
              onChange={(e) => {
                setEndTime(e.target.value);
                setFieldErrors((prev) => ({ ...prev, endTime: undefined }));
              }}
              required
              aria-required="true"
              aria-describedby={fieldErrors.endTime ? 'endTime-error' : undefined}
              className={fieldErrors.endTime ? 'border-red-500' : ''}
            />
            {fieldErrors.endTime && (
              <p id="endTime-error" role="alert" className="text-sm text-red-600">
                {fieldErrors.endTime}
              </p>
            )}
          </div>
        </div>

        {/* Aircraft select */}
        <div className="space-y-1">
          <Label htmlFor="aircraftId">
            Aircraft <span aria-hidden="true">*</span>
          </Label>
          <select
            id="aircraftId"
            value={aircraftId}
            onChange={(e) => {
              setAircraftId(e.target.value);
              setFieldErrors((prev) => ({ ...prev, resources: undefined }));
            }}
            aria-describedby={fieldErrors.resources ? 'resources-error' : undefined}
            className="flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="">— Select —</option>
            {aircraft.map((r) => (
              <option key={r.id} value={r.id}>
                {r.tailNumber ? `${r.tailNumber} — ${r.displayName}` : r.displayName}
              </option>
            ))}
          </select>
          {fieldErrors.resources && (
            <p id="resources-error" role="alert" className="text-sm text-red-600">
              {fieldErrors.resources}
            </p>
          )}
        </div>

        {/* Instructor select (optional) */}
        <div className="space-y-1">
          <Label htmlFor="instructorId">Instructor (optional)</Label>
          <select
            id="instructorId"
            value={instructorId}
            onChange={(e) => setInstructorId(e.target.value)}
            className="flex h-10 w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="">— None —</option>
            {instructors.map((r) => (
              <option key={r.id} value={r.id}>
                {r.displayName}
              </option>
            ))}
          </select>
        </div>

        {/* Notes */}
        <div className="space-y-1">
          <Label htmlFor="notes">Notes (optional)</Label>
          <Textarea
            id="notes"
            rows={3}
            maxLength={500}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any additional information…"
          />
        </div>

        {/* Live combined conflict + policy preview banner */}
        {submitConflicts.length === 0 && submitViolations.length === 0 && (
          <ConflictBanner
            state={conflictState}
            conflicts={conflicts}
            policyViolations={policyViolations}
          />
        )}

        {/* Actions */}
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            asChild={!isDirty}
            onClick={isDirty ? handleCancelClick : undefined}
          >
            {isDirty ? (
              <span>Cancel</span>
            ) : (
              <Link href={`/o/${slug}/schedule?date=${date}`}>Cancel</Link>
            )}
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Booking…' : 'Book Reservation'}
          </Button>
        </div>
      </form>
    </>
  );
}
