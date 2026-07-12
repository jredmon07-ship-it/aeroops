/**
 * board-gutter.tsx — Sticky left gutter with group labels + per-resource cells.
 *
 * Shows "Aircraft" / "Instructors" group headers (text-xs uppercase) and
 * per-resource cells (h-16) with tail # (font-mono text-xs) or displayName.
 *
 * Slice 3b: aircraft cells show a Grounded chip (red) and open-squawk count
 * badge when the session has maintenance:access. Ground/Release buttons visible
 * when the session has maintenance:ground.
 */
'use client';

import * as React from 'react';
import type { ResourceRow, GroundingStatusView } from '@aeroops/api';
import type { GroupedResources } from '../_utils/board-layout';

interface BoardGutterProps {
  grouped: GroupedResources;
  /** Grounding status per aircraft resource id (from board page parallel fetch). */
  groundingStatus: Map<string, GroundingStatusView>;
  /** Open squawk counts per aircraft resource id. */
  openSquawkCounts: Map<string, number>;
  /** Whether the session has maintenance:access (shows chips). */
  canMaintenanceAccess: boolean;
  /** Whether the session has maintenance:ground (shows Ground/Release buttons). */
  canGround: boolean;
  /** Called when the Ground button is clicked for a resource. */
  onGroundClick: (resource: ResourceRow) => void;
  /** Called when the Release button is clicked for a resource. */
  onReleaseClick: (resource: ResourceRow) => void;
}

interface ResourceCellProps {
  resource: ResourceRow;
  groundingStatus: Map<string, GroundingStatusView>;
  openSquawkCounts: Map<string, number>;
  canMaintenanceAccess: boolean;
  canGround: boolean;
  onGroundClick: (resource: ResourceRow) => void;
  onReleaseClick: (resource: ResourceRow) => void;
}

function ResourceCell({
  resource,
  groundingStatus,
  openSquawkCounts,
  canMaintenanceAccess,
  canGround,
  onGroundClick,
  onReleaseClick,
}: ResourceCellProps) {
  const isAircraft = resource.kind === 'aircraft';
  const status = isAircraft ? groundingStatus.get(resource.id) : undefined;
  const isGrounded = status?.grounded === true;
  const squawkCount = isAircraft ? (openSquawkCounts.get(resource.id) ?? 0) : 0;

  return (
    <div className="h-16 flex flex-col justify-center px-3 border-b border-slate-100 select-none gap-0.5">
      {isAircraft ? (
        <>
          <span className="font-mono text-xs text-slate-700 leading-tight truncate nums">
            {resource.tailNumber ?? resource.displayName}
          </span>
          {resource.tailNumber && (
            <span className="text-xs text-slate-500 truncate leading-tight">
              {resource.displayName}
            </span>
          )}
        </>
      ) : (
        <span className="text-sm font-medium text-slate-800 truncate">
          {resource.displayName}
        </span>
      )}

      {/* Grounded chip + squawk badge — aircraft only, maintenance:access */}
      {isAircraft && canMaintenanceAccess && (
        <div className="flex items-center gap-1 flex-wrap">
          {isGrounded && (
            <span
              title={status?.reason ?? 'Grounded'}
              className="inline-flex items-center rounded-sm border border-destructive/30 bg-destructive/10 px-1 py-0 text-[0.6875rem] font-semibold text-destructive leading-4"
              aria-label={`Grounded: ${status?.reason ?? ''}`}
            >
              Grounded
            </span>
          )}
          {squawkCount > 0 && (
            <span
              className="inline-flex items-center rounded-sm border border-slate-200 bg-slate-50 px-1 py-0 text-[0.6875rem] font-medium text-slate-600 leading-4 nums"
              aria-label={`${squawkCount} open squawk${squawkCount !== 1 ? 's' : ''}`}
            >
              {squawkCount} sqwk
            </span>
          )}
          {/* Ground / Release button — maintenance:ground only */}
          {canGround && (
            isGrounded ? (
              <button
                type="button"
                onClick={() => onReleaseClick(resource)}
                className="text-[0.6875rem] text-slate-500 hover:text-slate-800 underline leading-4"
                aria-label={`Release ${resource.tailNumber ?? resource.displayName}`}
              >
                Release
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onGroundClick(resource)}
                className="text-[0.6875rem] text-destructive hover:text-destructive/80 underline leading-4"
                aria-label={`Ground ${resource.tailNumber ?? resource.displayName}`}
              >
                Ground
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

export function BoardGutter({
  grouped,
  groundingStatus,
  openSquawkCounts,
  canMaintenanceAccess,
  canGround,
  onGroundClick,
  onReleaseClick,
}: BoardGutterProps) {
  const hasAircraft = grouped.aircraft.length > 0;
  const hasInstructors = grouped.instructors.length > 0;

  return (
    <div className="flex-shrink-0 w-40 bg-white border-r border-slate-200 z-20">
      {/* Aircraft group */}
      {hasAircraft && (
        <>
          <div className="h-8 flex items-end px-3 pb-1 border-b border-slate-200">
            <span className="text-xs uppercase text-slate-400 font-medium tracking-wide">
              Aircraft
            </span>
          </div>
          {grouped.aircraft.map((r) => (
            <ResourceCell
              key={r.id}
              resource={r}
              groundingStatus={groundingStatus}
              openSquawkCounts={openSquawkCounts}
              canMaintenanceAccess={canMaintenanceAccess}
              canGround={canGround}
              onGroundClick={onGroundClick}
              onReleaseClick={onReleaseClick}
            />
          ))}
        </>
      )}

      {/* Group separator — only when both groups have entries */}
      {hasAircraft && hasInstructors && (
        <div className="h-px bg-slate-300" />
      )}

      {/* Instructors group */}
      {hasInstructors && (
        <>
          <div className="h-8 flex items-end px-3 pb-1 border-b border-slate-200">
            <span className="text-xs uppercase text-slate-400 font-medium tracking-wide">
              Instructors
            </span>
          </div>
          {grouped.instructors.map((r) => (
            <ResourceCell
              key={r.id}
              resource={r}
              groundingStatus={groundingStatus}
              openSquawkCounts={openSquawkCounts}
              canMaintenanceAccess={canMaintenanceAccess}
              canGround={canGround}
              onGroundClick={onGroundClick}
              onReleaseClick={onReleaseClick}
            />
          ))}
        </>
      )}
    </div>
  );
}
