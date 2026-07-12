/**
 * resource-row.tsx — Single resource row in the resource admin list.
 *
 * Spec §5 (Slice 1): compact Card p-4, tail number in font-mono, status badge,
 * Deactivate button on active rows only.
 *
 * Spec §3.1 (Slice 2a): "Booking rules" button opens the per-resource policy
 * editor (BookingRulesDialog). Shown on ALL rows (active + inactive) so an
 * inactive resource's existing rules remain visible and editable.
 */
'use client';

import * as React from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { DeactivateResourceDialog } from './deactivate-resource-dialog';
import { BookingRulesDialog } from './booking-rules-dialog';
import type { ResourceRow } from '@aeroops/api';

interface ResourceRowProps {
  resource: ResourceRow;
  onDeactivated: (resourceId: string) => void;
}

export function ResourceRowCard({ resource, onDeactivated }: ResourceRowProps) {
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);

  const handleSuccess = () => {
    setErrorMsg(null);
    // Announcement is handled by the persistent aria-live region in ResourceList (spec §5).
    onDeactivated(resource.id);
  };

  const handleError = (message: string) => {
    setErrorMsg(message);
  };

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3">
        {/* Resource identity */}
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex items-center gap-2 flex-wrap">
            {resource.kind === 'aircraft' && resource.tailNumber && (
              <span className="font-mono text-sm text-slate-700 dark:text-slate-300">
                {resource.tailNumber}
              </span>
            )}
            <span className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
              {resource.displayName}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 dark:text-slate-400 capitalize">{resource.kind}</span>
          </div>
        </div>

        {/* Status + actions */}
        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
          <Badge variant={resource.active ? 'default' : 'secondary'}>
            {resource.active ? 'Active' : 'Inactive'}
          </Badge>
          {/* Booking rules button — shown on all rows (active + inactive) */}
          <BookingRulesDialog
            resourceId={resource.id}
            displayName={resource.displayName}
          />
          {resource.active && (
            <DeactivateResourceDialog
              resourceId={resource.id}
              displayName={resource.displayName}
              onSuccess={handleSuccess}
              onError={handleError}
            />
          )}
        </div>
      </div>

      {/* Error feedback */}
      {errorMsg && (
        <Alert variant="destructive" role="alert" className="mt-2">
          <AlertDescription>{errorMsg}</AlertDescription>
        </Alert>
      )}
    </Card>
  );
}
