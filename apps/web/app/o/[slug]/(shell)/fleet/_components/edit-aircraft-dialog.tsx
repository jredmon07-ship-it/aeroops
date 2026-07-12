/**
 * edit-aircraft-dialog.tsx — Dialog for editing aircraft identity fields.
 *
 * fleet:manage only. Opened from the detail page.
 *
 * Editable fields: make, model, year, serialNumber, homeBaseLocationId
 *   (select from listLocations), hasHobbs, hasTach, displayName.
 *
 * NOT editable: tailNumber, kind, active, any meter/dispatch/squawk records.
 *
 * States:
 *   Loading/submitting   — inputs disabled, button "Saving…"
 *   Populated            — pre-filled from aircraft prop
 *   Inline validation    — year out of range, required field errors
 *   invalid_home_base    — inline error under home base field
 *   not_found            — close dialog + show toast message
 *
 * The server action re-checks fleet:manage (auth enforced server-side).
 *
 * BOUNDARY: imports only from '@aeroops/api'. Never '@aeroops/db'.
 */
'use client';

import * as React from 'react';
import { Pencil, XCircle, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { updateAircraftAction, listLocationsAction } from '../actions';
import type { SerializedAircraftDetail } from '../actions';
import type { LocationOption } from '@aeroops/api';

// ─── Props ────────────────────────────────────────────────────────────────────

interface EditAircraftDialogProps {
  aircraft: SerializedAircraftDetail;
  slug: string;
  /** Called with the updated aircraft after a successful save. */
  onSuccess?: (updated: SerializedAircraftDetail) => void;
}

// ─── Field errors ─────────────────────────────────────────────────────────────

interface FieldErrors {
  displayName?: string;
  make?: string;
  model?: string;
  year?: string;
  serialNumber?: string;
  homeBaseLocationId?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function EditAircraftDialog({ aircraft, slug: _slug, onSuccess }: EditAircraftDialogProps) {
  const [open, setOpen] = React.useState(false);

  // Form state — pre-filled from aircraft
  const [displayName, setDisplayName] = React.useState(aircraft.displayName ?? '');
  const [make, setMake] = React.useState(aircraft.make ?? '');
  const [model, setModel] = React.useState(aircraft.model ?? '');
  const [year, setYear] = React.useState<string>(aircraft.year ? String(aircraft.year) : '');
  const [serialNumber, setSerialNumber] = React.useState(aircraft.serialNumber ?? '');
  const [category, setCategory] = React.useState(aircraft.category ?? '');
  const [aircraftClass, setAircraftClass] = React.useState(aircraft.aircraftClass ?? '');
  const [homeBaseLocationId, setHomeBaseLocationId] = React.useState<string>(
    aircraft.homeBase?.id ?? '',
  );
  const [hasHobbs, setHasHobbs] = React.useState(aircraft.hasHobbs);
  const [hasTach, setHasTach] = React.useState(aircraft.hasTach);

  // Locations for home-base select
  const [locations, setLocations] = React.useState<LocationOption[] | null>(null);
  const [locationsLoading, setLocationsLoading] = React.useState(false);

  // Error state
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [notFoundToast, setNotFoundToast] = React.useState(false);

  // Submission state
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  // ── Load locations + reset form when dialog opens ─────────────────────────
  React.useEffect(() => {
    if (!open) return;

    // Reset form to current aircraft values
    setDisplayName(aircraft.displayName ?? '');
    setMake(aircraft.make ?? '');
    setModel(aircraft.model ?? '');
    setYear(aircraft.year ? String(aircraft.year) : '');
    setSerialNumber(aircraft.serialNumber ?? '');
    setCategory(aircraft.category ?? '');
    setAircraftClass(aircraft.aircraftClass ?? '');
    setHomeBaseLocationId(aircraft.homeBase?.id ?? '');
    setHasHobbs(aircraft.hasHobbs);
    setHasTach(aircraft.hasTach);
    setFieldErrors({});
    setDialogError(null);
    setNotFoundToast(false);

    // Load locations
    setLocationsLoading(true);
    let cancelled = false;

    listLocationsAction().then((result) => {
      if (cancelled) return;
      setLocationsLoading(false);
      if ('ok' in result && result.ok) {
        setLocations(result.locations);
      } else {
        // Non-fatal: locations load failure → hide select (can still save without home base)
        setLocations([]);
      }
    }).catch(() => {
      if (!cancelled) {
        setLocationsLoading(false);
        setLocations([]);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [open, aircraft]);

  // ── Validation ─────────────────────────────────────────────────────────────
  function validate(): boolean {
    const errors: FieldErrors = {};

    if (displayName.trim() && displayName.trim().length > 100) {
      errors.displayName = 'Display name must be 100 characters or fewer.';
    }

    if (year.trim()) {
      const yearNum = parseInt(year.trim(), 10);
      if (isNaN(yearNum) || yearNum < 1900 || yearNum > 2200) {
        errors.year = 'Year must be between 1900 and 2200.';
      }
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDialogError(null);

    if (!validate()) return;

    setIsSubmitting(true);
    try {
      const yearNum = year.trim() ? parseInt(year.trim(), 10) : null;

      const result = await updateAircraftAction({
        resourceId: aircraft.id,
        displayName: displayName.trim() || undefined,
        make: make.trim() || null,
        model: model.trim() || null,
        year: yearNum,
        serialNumber: serialNumber.trim() || null,
        category: category.trim() || null,
        aircraftClass: aircraftClass.trim() || null,
        homeBaseLocationId: homeBaseLocationId || null,
        hasHobbs,
        hasTach,
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          // Try to map to a field error
          const msg = result.message.toLowerCase();
          if (msg.includes('year')) {
            setFieldErrors((prev) => ({ ...prev, year: result.message }));
          } else if (msg.includes('home') || msg.includes('location')) {
            setFieldErrors((prev) => ({ ...prev, homeBaseLocationId: result.message }));
          } else if (msg.includes('display')) {
            setFieldErrors((prev) => ({ ...prev, displayName: result.message }));
          } else {
            setDialogError(result.message);
          }
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to edit aircraft.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      if (!result.ok) {
        if (result.reason === 'not_found') {
          // Aircraft no longer exists — close dialog + show toast
          setNotFoundToast(true);
          setOpen(false);
          return;
        }
        if (result.reason === 'invalid_home_base') {
          setFieldErrors((prev) => ({
            ...prev,
            homeBaseLocationId: 'Selected home base is not valid for this organization.',
          }));
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      // ok:true → close + notify parent
      setOpen(false);
      onSuccess?.(result.aircraft);
    } catch {
      setDialogError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      {/* not_found toast (shown after dialog closed) */}
      {notFoundToast && (
        <div
          role="alert"
          aria-live="assertive"
          className="fixed bottom-4 right-4 z-50 rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive shadow-md"
        >
          Aircraft not found — it may have been removed.
          <button
            type="button"
            className="ml-3 underline underline-offset-2 text-destructive/80 hover:text-destructive"
            onClick={() => setNotFoundToast(false)}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Edit button */}
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`Edit aircraft ${aircraft.tailNumber}`}
      >
        <Pencil className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
        Edit
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              Edit aircraft{' '}
              <span className="nums font-bold">{aircraft.tailNumber}</span>
            </DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSubmit} noValidate className="space-y-4 pt-1">
            {dialogError && (
              <Alert variant="destructive" role="alert" aria-live="assertive">
                <XCircle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>{dialogError}</AlertDescription>
              </Alert>
            )}

            {/* Display name (optional) */}
            <div className="space-y-1.5">
              <Label htmlFor="ea-displayName">Display name (optional)</Label>
              <Input
                id="ea-displayName"
                value={displayName}
                onChange={(e) => {
                  setDisplayName(e.target.value);
                  setFieldErrors((prev) => ({ ...prev, displayName: undefined }));
                }}
                placeholder={aircraft.tailNumber}
                maxLength={100}
                disabled={isSubmitting}
                aria-describedby={fieldErrors.displayName ? 'ea-displayName-err' : undefined}
                className={fieldErrors.displayName ? 'border-red-500' : ''}
              />
              {fieldErrors.displayName && (
                <p id="ea-displayName-err" role="alert" className="text-xs text-red-600">
                  {fieldErrors.displayName}
                </p>
              )}
            </div>

            {/* Make */}
            <div className="space-y-1.5">
              <Label htmlFor="ea-make">Make</Label>
              <Input
                id="ea-make"
                value={make}
                onChange={(e) => setMake(e.target.value)}
                placeholder="e.g. Cessna"
                disabled={isSubmitting}
              />
            </div>

            {/* Model */}
            <div className="space-y-1.5">
              <Label htmlFor="ea-model">Model</Label>
              <Input
                id="ea-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="e.g. 172S Skyhawk"
                disabled={isSubmitting}
              />
            </div>

            {/* Year */}
            <div className="space-y-1.5">
              <Label htmlFor="ea-year">Year</Label>
              <Input
                id="ea-year"
                type="number"
                inputMode="numeric"
                min={1900}
                max={2200}
                value={year}
                onChange={(e) => {
                  setYear(e.target.value);
                  setFieldErrors((prev) => ({ ...prev, year: undefined }));
                }}
                placeholder="e.g. 2018"
                disabled={isSubmitting}
                aria-invalid={fieldErrors.year ? 'true' : undefined}
                aria-describedby={fieldErrors.year ? 'ea-year-err' : undefined}
                className={fieldErrors.year ? 'border-red-500' : ''}
              />
              {fieldErrors.year && (
                <p id="ea-year-err" role="alert" className="text-xs text-red-600">
                  {fieldErrors.year}
                </p>
              )}
            </div>

            {/* Serial number */}
            <div className="space-y-1.5">
              <Label htmlFor="ea-serial">Serial number</Label>
              <Input
                id="ea-serial"
                value={serialNumber}
                onChange={(e) => setSerialNumber(e.target.value)}
                placeholder="e.g. 17282345"
                disabled={isSubmitting}
                className="font-mono text-sm"
              />
            </div>

            {/* Category / Class (Slice P2-LOG2) — free text, operator-entered */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ea-category">Category</Label>
                <Input
                  id="ea-category"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  placeholder="e.g. Airplane"
                  maxLength={100}
                  disabled={isSubmitting}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ea-class">Class</Label>
                <Input
                  id="ea-class"
                  value={aircraftClass}
                  onChange={(e) => setAircraftClass(e.target.value)}
                  placeholder="e.g. ASEL"
                  maxLength={100}
                  disabled={isSubmitting}
                />
              </div>
              <p className="col-span-2 text-xs text-slate-400">
                Free-text identity labels shown on logbook rows — operator-entered,
                not a certification determination.
              </p>
            </div>

            {/* Home base */}
            <div className="space-y-1.5">
              <Label htmlFor="ea-home-base">Home base</Label>
              {locationsLoading ? (
                <div
                  className="flex h-10 w-full items-center rounded-md border border-slate-200 bg-slate-50 px-3 animate-pulse"
                  aria-busy="true"
                  aria-label="Loading locations"
                >
                  <Loader2 className="h-4 w-4 text-slate-300 animate-spin" aria-hidden="true" />
                </div>
              ) : (
                <select
                  id="ea-home-base"
                  value={homeBaseLocationId}
                  onChange={(e) => {
                    setHomeBaseLocationId(e.target.value);
                    setFieldErrors((prev) => ({ ...prev, homeBaseLocationId: undefined }));
                  }}
                  disabled={isSubmitting}
                  aria-invalid={fieldErrors.homeBaseLocationId ? 'true' : undefined}
                  aria-describedby={fieldErrors.homeBaseLocationId ? 'ea-home-base-err' : undefined}
                  className={`flex h-10 w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-400 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0 disabled:opacity-50 transition-colors ${
                    fieldErrors.homeBaseLocationId ? 'border-red-500' : 'border-slate-300'
                  }`}
                >
                  <option value="">— No home base —</option>
                  {(locations ?? []).map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                      {loc.icao ? ` (${loc.icao})` : ''}
                    </option>
                  ))}
                </select>
              )}
              {fieldErrors.homeBaseLocationId && (
                <p id="ea-home-base-err" role="alert" className="text-xs text-red-600">
                  {fieldErrors.homeBaseLocationId}
                </p>
              )}
            </div>

            {/* Meter config checkboxes */}
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-700">Meter tracking</p>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={hasHobbs}
                    onChange={(e) => setHasHobbs(e.target.checked)}
                    disabled={isSubmitting}
                    className="h-4 w-4 rounded border-slate-300 text-brand focus:ring-brand"
                    id="ea-has-hobbs"
                  />
                  <span className="text-sm text-slate-700">Track Hobbs meter</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={hasTach}
                    onChange={(e) => setHasTach(e.target.checked)}
                    disabled={isSubmitting}
                    className="h-4 w-4 rounded border-slate-300 text-brand focus:ring-brand"
                    id="ea-has-tach"
                  />
                  <span className="text-sm text-slate-700">Track Tach meter</span>
                </label>
              </div>
              <p className="text-xs text-slate-400">
                Display only — does not affect the dispatch meter-capture path.
              </p>
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={isSubmitting}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={isSubmitting || locationsLoading} isLoading={isSubmitting}>
                Save changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
