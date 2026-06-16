/**
 * board-gutter.tsx — Sticky left gutter with group labels + per-resource cells.
 *
 * Shows "Aircraft" / "Instructors" group headers (text-xs uppercase) and
 * per-resource cells (h-16) with tail # (font-mono text-xs) or displayName.
 */
import * as React from 'react';
import type { ResourceRow } from '@aeroops/api';
import type { GroupedResources } from '../_utils/board-layout';

interface BoardGutterProps {
  grouped: GroupedResources;
}

function ResourceCell({ resource }: { resource: ResourceRow }) {
  return (
    <div className="h-16 flex flex-col justify-center px-3 border-b border-slate-100 select-none">
      {resource.kind === 'aircraft' ? (
        <>
          <span className="font-mono text-xs text-slate-700 leading-tight truncate">
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
    </div>
  );
}

export function BoardGutter({ grouped }: BoardGutterProps) {
  const hasAircraft = grouped.aircraft.length > 0;
  const hasInstructors = grouped.instructors.length > 0;

  return (
    <div className="flex-shrink-0 w-36 bg-white border-r border-slate-200 z-20">
      {/* Aircraft group */}
      {hasAircraft && (
        <>
          <div className="h-8 flex items-end px-3 pb-1 border-b border-slate-200">
            <span className="text-xs uppercase text-slate-400 font-medium tracking-wide">
              Aircraft
            </span>
          </div>
          {grouped.aircraft.map((r) => (
            <ResourceCell key={r.id} resource={r} />
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
            <ResourceCell key={r.id} resource={r} />
          ))}
        </>
      )}
    </div>
  );
}
