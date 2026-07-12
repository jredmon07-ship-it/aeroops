/**
 * locations-client.tsx — Locations list + add/edit dialog.
 *
 * fleet:manage gates the write controls (add/edit). The server actions re-check
 * the capability regardless of what the UI shows.
 *
 * Coordinates are validated inline as a matched pair (both or neither) within
 * range, mirroring the server. A note explains they enable day/night scheduling
 * and are operator data — NOT an FAA determination.
 *
 * BOUNDARY: imports only from '@aeroops/api' types + local actions.
 */
'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { MapPin, Plus, Pencil, XCircle } from 'lucide-react';
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
import type { LocationOption } from '@aeroops/api';
import { createLocationAction, updateLocationAction } from '../../actions';
import { EmptyState } from '@/components/ui/empty-state';

interface LocationsClientProps {
  locations: LocationOption[];
  slug: string;
  canManage: boolean;
}

interface FieldErrors {
  name?: string;
  icao?: string;
  latitude?: string;
  longitude?: string;
}

export function LocationsClient({ locations, slug, canManage }: LocationsClientProps) {
  const [editing, setEditing] = React.useState<LocationOption | null>(null);
  const [addOpen, setAddOpen] = React.useState(false);

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4 mr-1.5" aria-hidden="true" />
            Add location
          </Button>
        </div>
      )}

      {locations.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title="No locations yet."
          body={
            canManage
              ? 'Add your base airport and its coordinates to enable accurate day/night scheduling.'
              : 'No bases have been added yet.'
          }
        />
      ) : (
        <div className="rounded-md border border-slate-200 overflow-x-auto">
          <table className="w-full text-sm" aria-label="Locations">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200">
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                  Name
                </th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                  ICAO
                </th>
                <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-slate-500 uppercase tracking-wide">
                  Coordinates
                </th>
                {canManage && <th scope="col" className="px-3 py-2 w-16" />}
              </tr>
            </thead>
            <tbody>
              {locations.map((loc) => {
                const hasCoords = loc.latitude != null && loc.longitude != null;
                return (
                  <tr key={loc.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-3 font-medium text-slate-900">{loc.name}</td>
                    <td className="px-3 py-3 nums text-slate-600">{loc.icao ?? '—'}</td>
                    <td className="px-3 py-3 nums text-slate-600">
                      {hasCoords ? (
                        `${loc.latitude!.toFixed(4)}, ${loc.longitude!.toFixed(4)}`
                      ) : (
                        <span className="text-amber-600">No coordinates</span>
                      )}
                    </td>
                    {canManage && (
                      <td className="px-3 py-3 text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setEditing(loc)}
                          aria-label={`Edit ${loc.name}`}
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        </Button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {canManage && addOpen && (
        <LocationDialog
          mode="create"
          slug={slug}
          open={addOpen}
          onOpenChange={setAddOpen}
        />
      )}
      {canManage && editing && (
        <LocationDialog
          mode="edit"
          slug={slug}
          location={editing}
          open={editing !== null}
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
    </div>
  );
}

// ─── Add/Edit dialog ────────────────────────────────────────────────────────────

interface LocationDialogProps {
  mode: 'create' | 'edit';
  slug: string;
  location?: LocationOption;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function LocationDialog({ mode, slug, location, open, onOpenChange }: LocationDialogProps) {
  const router = useRouter();
  const [name, setName] = React.useState(location?.name ?? '');
  const [icao, setIcao] = React.useState(location?.icao ?? '');
  const [latitude, setLatitude] = React.useState(
    location?.latitude != null ? String(location.latitude) : '',
  );
  const [longitude, setLongitude] = React.useState(
    location?.longitude != null ? String(location.longitude) : '',
  );
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  function validate(): boolean {
    const errors: FieldErrors = {};
    if (!name.trim()) errors.name = 'Name is required.';
    if (name.trim().length > 120) errors.name = 'Name must be 120 characters or fewer.';

    if (icao.trim() && !/^[A-Za-z0-9]{3,4}$/.test(icao.trim())) {
      errors.icao = 'ICAO must be 3–4 letters or digits (e.g. KOSU).';
    }

    const latStr = latitude.trim();
    const lonStr = longitude.trim();
    const latSet = latStr !== '';
    const lonSet = lonStr !== '';
    if (latSet !== lonSet) {
      const msg = 'Enter latitude and longitude together, or leave both blank.';
      if (!latSet) errors.latitude = msg;
      if (!lonSet) errors.longitude = msg;
    } else if (latSet && lonSet) {
      const lat = Number(latStr);
      const lon = Number(lonStr);
      if (Number.isNaN(lat) || lat < -90 || lat > 90) {
        errors.latitude = 'Latitude must be between -90 and 90.';
      }
      if (Number.isNaN(lon) || lon < -180 || lon > 180) {
        errors.longitude = 'Longitude must be between -180 and 180.';
      }
    }

    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDialogError(null);
    if (!validate()) return;

    setIsSubmitting(true);
    try {
      const latStr = latitude.trim();
      const lonStr = longitude.trim();
      const coordsSet = latStr !== '' && lonStr !== '';

      let result;
      if (mode === 'create') {
        result = await createLocationAction(
          {
            name: name.trim(),
            ...(icao.trim() ? { icao: icao.trim() } : {}),
            ...(coordsSet ? { latitude: Number(latStr), longitude: Number(lonStr) } : {}),
          },
          slug,
        );
      } else {
        // Edit: always send name + icao (null clears) + coords as a unit
        // (numbers to set, null to clear).
        result = await updateLocationAction(
          {
            locationId: location!.id,
            name: name.trim(),
            icao: icao.trim() ? icao.trim() : null,
            latitude: coordsSet ? Number(latStr) : null,
            longitude: coordsSet ? Number(lonStr) : null,
          },
          slug,
        );
      }

      if ('error' in result) {
        if (result.error === 'validation') {
          setDialogError(result.message);
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to manage locations.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      if (!result.ok) {
        setDialogError('This location no longer exists — it may have been removed.');
        return;
      }

      onOpenChange(false);
      router.refresh();
    } catch {
      setDialogError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Add location' : `Edit ${location?.name ?? 'location'}`}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} noValidate className="space-y-4 pt-1">
          {dialogError && (
            <Alert variant="destructive" role="alert" aria-live="assertive">
              <XCircle className="h-4 w-4" aria-hidden="true" />
              <AlertDescription>{dialogError}</AlertDescription>
            </Alert>
          )}

          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="loc-name">Name</Label>
            <Input
              id="loc-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setFieldErrors((p) => ({ ...p, name: undefined }));
              }}
              placeholder="e.g. Main Base"
              maxLength={120}
              disabled={isSubmitting}
              aria-invalid={fieldErrors.name ? 'true' : undefined}
              aria-describedby={fieldErrors.name ? 'loc-name-err' : undefined}
              className={fieldErrors.name ? 'border-red-500' : ''}
            />
            {fieldErrors.name && (
              <p id="loc-name-err" role="alert" className="text-xs text-red-600">
                {fieldErrors.name}
              </p>
            )}
          </div>

          {/* ICAO */}
          <div className="space-y-1.5">
            <Label htmlFor="loc-icao">ICAO / airport identifier (optional)</Label>
            <Input
              id="loc-icao"
              value={icao}
              onChange={(e) => {
                setIcao(e.target.value.toUpperCase());
                setFieldErrors((p) => ({ ...p, icao: undefined }));
              }}
              placeholder="e.g. KOSU"
              maxLength={4}
              disabled={isSubmitting}
              aria-invalid={fieldErrors.icao ? 'true' : undefined}
              aria-describedby={fieldErrors.icao ? 'loc-icao-err' : undefined}
              className={`nums ${fieldErrors.icao ? 'border-red-500' : ''}`}
            />
            {fieldErrors.icao && (
              <p id="loc-icao-err" role="alert" className="text-xs text-red-600">
                {fieldErrors.icao}
              </p>
            )}
          </div>

          {/* Coordinates */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="loc-lat">Latitude (optional)</Label>
              <Input
                id="loc-lat"
                type="number"
                inputMode="decimal"
                step="any"
                value={latitude}
                onChange={(e) => {
                  setLatitude(e.target.value);
                  setFieldErrors((p) => ({ ...p, latitude: undefined, longitude: undefined }));
                }}
                placeholder="40.078"
                disabled={isSubmitting}
                aria-invalid={fieldErrors.latitude ? 'true' : undefined}
                aria-describedby={fieldErrors.latitude ? 'loc-lat-err' : undefined}
                className={`nums ${fieldErrors.latitude ? 'border-red-500' : ''}`}
              />
              {fieldErrors.latitude && (
                <p id="loc-lat-err" role="alert" className="text-xs text-red-600">
                  {fieldErrors.latitude}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="loc-lon">Longitude (optional)</Label>
              <Input
                id="loc-lon"
                type="number"
                inputMode="decimal"
                step="any"
                value={longitude}
                onChange={(e) => {
                  setLongitude(e.target.value);
                  setFieldErrors((p) => ({ ...p, latitude: undefined, longitude: undefined }));
                }}
                placeholder="-83.073"
                disabled={isSubmitting}
                aria-invalid={fieldErrors.longitude ? 'true' : undefined}
                aria-describedby={fieldErrors.longitude ? 'loc-lon-err' : undefined}
                className={`nums ${fieldErrors.longitude ? 'border-red-500' : ''}`}
              />
              {fieldErrors.longitude && (
                <p id="loc-lon-err" role="alert" className="text-xs text-red-600">
                  {fieldErrors.longitude}
                </p>
              )}
            </div>
          </div>
          <p className="text-xs text-slate-400">
            Coordinates (WGS84 decimal degrees) enable accurate day/night scheduling.
            Operator data — not an FAA determination.
          </p>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isSubmitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isSubmitting} isLoading={isSubmitting}>
              {mode === 'create' ? (
                'Add location'
              ) : (
                'Save changes'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
