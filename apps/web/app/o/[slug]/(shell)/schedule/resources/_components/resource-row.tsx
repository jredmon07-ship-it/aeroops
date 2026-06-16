/**
 * resource-row.tsx — Single resource row in the resource admin list.
 *
 * Spec §5: compact Card p-4, tail number in font-mono, status badge,
 * Deactivate button on active rows only.
 */
'use client';

import * as React from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { DeactivateResourceDialog } from './deactivate-resource-dialog';
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
              <span className="font-mono text-sm text-slate-700">
                {resource.tailNumber}
              </span>
            )}
            <span className="text-sm font-medium text-slate-900 truncate">
              {resource.displayName}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 capitalize">{resource.kind}</span>
          </div>
        </div>

        {/* Status + action */}
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant={resource.active ? 'default' : 'secondary'}>
            {resource.active ? 'Active' : 'Inactive'}
          </Badge>
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
