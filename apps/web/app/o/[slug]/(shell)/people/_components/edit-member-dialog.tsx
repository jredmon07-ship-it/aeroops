/**
 * edit-member-dialog.tsx — Dialog for editing a member's identity + role.
 *
 * Editable: fullName, phone, role.
 * NOT editable: email, any meter/dispatch/audit records.
 *
 * people:manage only. Server-side gate in updateMemberAction.
 * Handles last_owner refusal with an inline message.
 */
'use client';

import * as React from 'react';
import { Pencil, XCircle } from 'lucide-react';
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
import { MEMBERSHIP_ROLES, ROLE_LABELS } from '@aeroops/core';
import type { MembershipRole } from '@aeroops/core';
import { updateMemberAction } from '../actions';
import type { SerializedMemberDetail } from '../actions';

interface EditMemberDialogProps {
  member: SerializedMemberDetail;
  onSuccess?: (updated: SerializedMemberDetail) => void;
}

interface FieldErrors {
  fullName?: string;
  phone?: string;
  role?: string;
}

export function EditMemberDialog({ member, onSuccess }: EditMemberDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [fullName, setFullName] = React.useState(member.displayName !== member.email ? member.displayName : '');
  const [phone, setPhone] = React.useState(member.phone ?? '');
  const [role, setRole] = React.useState<MembershipRole>(member.role as MembershipRole);
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setFullName(member.displayName !== member.email ? member.displayName : '');
    setPhone(member.phone ?? '');
    setRole(member.role as MembershipRole);
    setFieldErrors({});
    setDialogError(null);
  }, [open, member]);

  function validate(): boolean {
    const errors: FieldErrors = {};
    if (fullName.trim().length > 200) {
      errors.fullName = 'Name must be 200 characters or fewer.';
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
      const result = await updateMemberAction({
        userId: member.userId,
        fullName: fullName.trim() || undefined,
        phone: phone.trim() || null,
        role,
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          setDialogError(result.message);
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to edit this member.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      if (!result.ok) {
        if (result.reason === 'last_owner') {
          setDialogError(
            'Cannot change this role — they are the only active owner. Add another owner first.',
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
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} aria-label="Edit member">
        <Pencil className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
        Edit
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit {member.displayName}</DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSubmit} noValidate className="space-y-4 pt-1">
            {dialogError && (
              <Alert variant="destructive" role="alert" aria-live="assertive">
                <XCircle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>{dialogError}</AlertDescription>
              </Alert>
            )}

            {/* Full name */}
            <div className="space-y-1.5">
              <Label htmlFor="em-fullName">Full name</Label>
              <Input
                id="em-fullName"
                value={fullName}
                onChange={(e) => {
                  setFullName(e.target.value);
                  setFieldErrors((p) => ({ ...p, fullName: undefined }));
                }}
                placeholder="Jane Smith"
                disabled={isSubmitting}
                aria-invalid={fieldErrors.fullName ? 'true' : undefined}
                aria-describedby={fieldErrors.fullName ? 'em-fullName-err' : undefined}
                className={fieldErrors.fullName ? 'border-red-500' : ''}
              />
              {fieldErrors.fullName && (
                <p id="em-fullName-err" role="alert" className="text-xs text-red-600">
                  {fieldErrors.fullName}
                </p>
              )}
            </div>

            {/* Phone */}
            <div className="space-y-1.5">
              <Label htmlFor="em-phone">Phone</Label>
              <Input
                id="em-phone"
                type="tel"
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="555-867-5309"
                disabled={isSubmitting}
              />
            </div>

            {/* Role */}
            <div className="space-y-1.5">
              <Label htmlFor="em-role">Role</Label>
              <select
                id="em-role"
                value={role}
                onChange={(e) => setRole(e.target.value as MembershipRole)}
                disabled={isSubmitting}
                className="flex h-10 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 hover:border-slate-400 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0 disabled:opacity-50 transition-colors"
              >
                {MEMBERSHIP_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={isSubmitting}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={isSubmitting} isLoading={isSubmitting}>
                Save changes
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
