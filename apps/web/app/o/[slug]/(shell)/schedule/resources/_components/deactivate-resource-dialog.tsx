/**
 * deactivate-resource-dialog.tsx — AlertDialog for deactivating a resource.
 *
 * Spec §5: soft-delete, not permanent deletion. Title "Deactivate [name]?",
 * safer default "Keep active". Never says "permanently deleted".
 */
'use client';

import * as React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { deactivateResourceAction } from '../../actions';

interface DeactivateResourceDialogProps {
  resourceId: string;
  displayName: string;
  onSuccess: () => void;
  onError: (message: string) => void;
}

export function DeactivateResourceDialog({
  resourceId,
  displayName,
  onSuccess,
  onError,
}: DeactivateResourceDialogProps) {
  const [pending, setPending] = React.useState(false);

  const handleDeactivate = async () => {
    setPending(true);
    try {
      const result = await deactivateResourceAction({ resourceId });

      if ('error' in result) {
        onError('Could not deactivate the resource. Please try again.');
        return;
      }

      if (!result.ok && result.reason === 'not_found') {
        onError(
          'Resource not found. It may have already been removed.',
        );
        return;
      }

      onSuccess();
    } catch {
      onError('Something went wrong. Please try again.');
    } finally {
      setPending(false);
    }
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Deactivate ${displayName}`}
        >
          Deactivate
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Deactivate {displayName}?</AlertDialogTitle>
          <AlertDialogDescription>
            This resource will no longer be available for booking. Existing
            reservations are not affected. This cannot be undone from this
            interface.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus disabled={pending}>
            Keep active
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              e.preventDefault();
              void handleDeactivate();
            }}
            disabled={pending}
          >
            {pending ? 'Deactivating…' : 'Deactivate'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
