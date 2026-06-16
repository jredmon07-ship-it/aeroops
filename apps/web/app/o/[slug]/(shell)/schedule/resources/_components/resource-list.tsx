/**
 * resource-list.tsx — Client component managing the resource admin tab state.
 *
 * Spec §5: button-based tabs "Aircraft (n)" / "Instructors (n)" with role="tablist"
 * and arrow-key navigation (handled by Tabs primitive). Active section then inactive
 * section within each tab panel. "+ Add Resource" button in the header row.
 *
 * Receives initial resources + org members (for the Add Resource dialog) from the
 * RSC page. Handles optimistic updates after add/deactivate.
 */
'use client';

import * as React from 'react';
import { PlaneTakeoff, UserCheck } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AddResourceDialog } from './add-resource-dialog';
import { ResourceRowCard } from './resource-row';
import type { ResourceRow, OrgMemberRow } from '@aeroops/api';

interface ResourceListProps {
  resources: ResourceRow[];
  orgMembers: OrgMemberRow[];
}

export function ResourceList({ resources: initialResources, orgMembers }: ResourceListProps) {
  const [resources, setResources] = React.useState<ResourceRow[]>(initialResources);
  const [activeTab, setActiveTab] = React.useState<'aircraft' | 'instructors'>('aircraft');
  const [addSuccessVisible, setAddSuccessVisible] = React.useState(false);
  const [addedName, setAddedName] = React.useState<string>('');
  // Persistently-mounted live region text for deactivation announcements (spec §5).
  // Must be a stable DOM node whose text changes — NOT a conditionally-mounted node —
  // so screen readers reliably announce it.
  const [deactivateAnnouncement, setDeactivateAnnouncement] = React.useState('');

  // Split by kind × active
  const aircraft = resources.filter((r) => r.kind === 'aircraft');
  const instructors = resources.filter((r) => r.kind === 'instructor');
  const activeAircraft = aircraft.filter((r) => r.active);
  const inactiveAircraft = aircraft.filter((r) => !r.active);
  const activeInstructors = instructors.filter((r) => r.active);
  const inactiveInstructors = instructors.filter((r) => !r.active);

  const handleAddSuccess = (resource: ResourceRow) => {
    setResources((prev) => [...prev, resource]);
    setAddedName(resource.displayName);
    setAddSuccessVisible(true);
    // Switch to the tab matching the new resource's kind
    setActiveTab(resource.kind === 'aircraft' ? 'aircraft' : 'instructors');
  };

  const handleDeactivated = (resourceId: string, displayName: string) => {
    setResources((prev) =>
      prev.map((r) => (r.id === resourceId ? { ...r, active: false } : r)),
    );
    // Update the persistent live region text so screen readers announce it (spec §5).
    setDeactivateAnnouncement(`${displayName} deactivated.`);
  };

  return (
    <div className="space-y-4">
      {/* Persistently-mounted aria-live region for deactivation announcements.
          Spec §5: ok:true → "[name] deactivated." The region must always be in
          the DOM; only its text content changes so screen readers announce it. */}
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {deactivateAnnouncement}
      </span>

      {/* ── Header row: h1 + Add Resource ──────────────────────────────── */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold text-slate-900">Resources</h1>
        <AddResourceDialog orgMembers={orgMembers} onSuccess={handleAddSuccess} />
      </div>

      {/* Success banner after add */}
      {addSuccessVisible && (
        <Alert
          className="border-green-200 bg-green-50 text-green-800"
          role="status"
          aria-live="polite"
        >
          <AlertDescription className="flex items-center justify-between gap-4">
            <span>Resource &ldquo;{addedName}&rdquo; added.</span>
            <button
              type="button"
              onClick={() => setAddSuccessVisible(false)}
              className="text-green-700 hover:text-green-900 text-sm underline shrink-0"
              aria-label="Dismiss success message"
            >
              Dismiss
            </button>
          </AlertDescription>
        </Alert>
      )}

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as 'aircraft' | 'instructors')}
      >
        <TabsList>
          <TabsTrigger value="aircraft">
            Aircraft ({aircraft.length})
          </TabsTrigger>
          <TabsTrigger value="instructors">
            Instructors ({instructors.length})
          </TabsTrigger>
        </TabsList>

        {/* ── Aircraft tab ──────────────────────────────────────────────── */}
        <TabsContent value="aircraft">
          <AircraftSection
            activeAircraft={activeAircraft}
            inactiveAircraft={inactiveAircraft}
            onDeactivated={(id, name) => handleDeactivated(id, name)}
          />
        </TabsContent>

        {/* ── Instructors tab ──────────────────────────────────────────── */}
        <TabsContent value="instructors">
          <InstructorsSection
            activeInstructors={activeInstructors}
            inactiveInstructors={inactiveInstructors}
            onDeactivated={(id, name) => handleDeactivated(id, name)}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Sub-sections ─────────────────────────────────────────────────────────────

interface AircraftSectionProps {
  activeAircraft: ResourceRow[];
  inactiveAircraft: ResourceRow[];
  onDeactivated: (id: string, displayName: string) => void;
}

function AircraftSection({ activeAircraft, inactiveAircraft, onDeactivated }: AircraftSectionProps) {
  const hasAny = activeAircraft.length > 0 || inactiveAircraft.length > 0;

  if (!hasAny) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center space-y-2" aria-label="No aircraft">
        <PlaneTakeoff className="h-8 w-8 text-slate-300" aria-hidden="true" />
        <p className="text-sm text-slate-500">No aircraft added yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 pt-4">
      {activeAircraft.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-slate-400 px-1">
            Active
          </h2>
          <div className="space-y-2">
            {activeAircraft.map((r) => (
              <ResourceRowCard
                key={r.id}
                resource={r}
                onDeactivated={(id) => onDeactivated(id, r.displayName)}
              />
            ))}
          </div>
        </div>
      )}
      {inactiveAircraft.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-slate-400 px-1">
            Inactive
          </h2>
          <div className="space-y-2">
            {inactiveAircraft.map((r) => (
              <ResourceRowCard
                key={r.id}
                resource={r}
                onDeactivated={(id) => onDeactivated(id, r.displayName)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface InstructorsSectionProps {
  activeInstructors: ResourceRow[];
  inactiveInstructors: ResourceRow[];
  onDeactivated: (id: string, displayName: string) => void;
}

function InstructorsSection({ activeInstructors, inactiveInstructors, onDeactivated }: InstructorsSectionProps) {
  const hasAny = activeInstructors.length > 0 || inactiveInstructors.length > 0;

  if (!hasAny) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center space-y-2" aria-label="No instructors">
        <UserCheck className="h-8 w-8 text-slate-300" aria-hidden="true" />
        <p className="text-sm text-slate-500">No instructors added yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 pt-4">
      {activeInstructors.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-slate-400 px-1">
            Active
          </h2>
          <div className="space-y-2">
            {activeInstructors.map((r) => (
              <ResourceRowCard
                key={r.id}
                resource={r}
                onDeactivated={(id) => onDeactivated(id, r.displayName)}
              />
            ))}
          </div>
        </div>
      )}
      {inactiveInstructors.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-xs font-medium uppercase tracking-wide text-slate-400 px-1">
            Inactive
          </h2>
          <div className="space-y-2">
            {inactiveInstructors.map((r) => (
              <ResourceRowCard
                key={r.id}
                resource={r}
                onDeactivated={(id) => onDeactivated(id, r.displayName)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Loading skeleton (exported for Suspense boundary in RSC) ─────────────────

export function ResourceListSkeleton() {
  return (
    <div className="space-y-4">
      {/* Header skeleton */}
      <div className="flex items-center justify-between gap-4">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-10 w-32" />
      </div>
      {/* Tab skeleton */}
      <div className="flex gap-1 border-b border-slate-200 pb-0">
        <Skeleton className="h-10 w-28" />
        <Skeleton className="h-10 w-28" />
      </div>
      {/* Row skeletons */}
      <div className="space-y-2 pt-4">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    </div>
  );
}
