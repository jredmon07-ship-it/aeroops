/**
 * status-toggle.tsx — Deactivate/Reactivate button with confirm step.
 *
 * Destructive action (deactivation) requires explicit confirmation.
 * Handles cannot_deactivate_self and last_owner refusals with inline messages.
 *
 * [VERIFY-6-D]: status is a roster flag, NOT a login gate in this slice.
 */
'use client';

import * as React from 'react';
import { UserX, UserCheck, XCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { setMemberStatusAction } from '../actions';
import type { SerializedMemberDetail } from '../actions';

interface StatusToggleProps {
  member: SerializedMemberDetail;
  onSuccess?: (updated: SerializedMemberDetail) => void;
}

export function StatusToggle({ member, onSuccess }: StatusToggleProps) {
  const [open, setOpen] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [dialogError, setDialogError] = React.useState<string | null>(null);

  const isActive = member.status === 'active';
  const newStatus = isActive ? 'inactive' : 'active';

  React.useEffect(() => {
    if (open) setDialogError(null);
  }, [open]);

  async function handleConfirm() {
    setDialogError(null);
    setIsSubmitting(true);
    try {
      const result = await setMemberStatusAction({ userId: member.userId, status: newStatus });

      if ('error' in result) {
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to change this member\'s status.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      if (!result.ok) {
        if (result.reason === 'cannot_deactivate_self') {
          setDialogError('You cannot deactivate your own account.');
          return;
        }
        if (result.reason === 'last_owner') {
          setDialogError(
            'Cannot deactivate — this member is the only active owner. Assign another owner first.',
          );
          return;
        }
        if (result.reason === 'not_found') {
          setOpen(false);
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      setOpen(false);
      onSuccess?.(result.member);
    } catch {
      setDialogError('Something went wrong. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <Button
        variant={isActive ? 'destructive' : 'outline'}
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={isActive ? 'Deactivate member' : 'Reactivate member'}
      >
        {isActive ? (
          <>
            <UserX className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
            Deactivate
          </>
        ) : (
          <>
            <UserCheck className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
            Reactivate
          </>
        )}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {isActive ? 'Deactivate' : 'Reactivate'} {member.displayName}?
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-3 py-1">
            {dialogError && (
              <Alert variant="destructive" role="alert" aria-live="assertive">
                <XCircle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>{dialogError}</AlertDescription>
              </Alert>
            )}

            {isActive ? (
              <p className="text-sm text-slate-600 dark:text-slate-300">
                This will mark <strong>{member.displayName}</strong> as inactive on the roster.
                They will no longer appear in active-only views.
              </p>
            ) : (
              <p className="text-sm text-slate-600 dark:text-slate-300">
                This will mark <strong>{member.displayName}</strong> as active on the roster again.
              </p>
            )}

            {/* [VERIFY-6-D]: status flag disclaimer */}
            <p className="text-xs text-slate-400 dark:text-slate-500">
              Note: roster status is a flag only and does not affect login access in this release.
            </p>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isSubmitting}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              variant={isActive ? 'destructive' : 'default'}
              disabled={isSubmitting}
              onClick={handleConfirm}
              isLoading={isSubmitting}
            >
              {isActive ? (
                'Yes, deactivate'
              ) : (
                'Yes, reactivate'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
