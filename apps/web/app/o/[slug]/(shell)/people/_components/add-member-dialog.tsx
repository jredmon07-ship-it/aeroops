/**
 * add-member-dialog.tsx — Dialog for adding a new roster member.
 *
 * people:manage only (owner/manager). Server-side gate in addMemberAction.
 *
 * Writes app_user + membership ONLY — NO auth_credential.
 * The added member has no password yet. To give them a login, open their
 * detail page and use "Create login link" (login-link-button.tsx); the UI
 * says so here.
 *
 * [AUTH-DECISION]: no password, no credential, no auth-boundary crossing.
 * [VERIFY-6-A]: tag field is NOT in this dialog (tags have their own editor).
 */
'use client';

import * as React from 'react';
import { UserPlus, XCircle, Info } from 'lucide-react';
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
import { addMemberAction } from '../actions';
import type { SerializedMemberDetail } from '../actions';

interface AddMemberDialogProps {
  onSuccess?: (member: SerializedMemberDetail) => void;
}

interface FieldErrors {
  email?: string;
  fullName?: string;
  phone?: string;
  role?: string;
}

export function AddMemberDialog({ onSuccess }: AddMemberDialogProps) {
  const [open, setOpen] = React.useState(false);
  const [email, setEmail] = React.useState('');
  const [fullName, setFullName] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [role, setRole] = React.useState<MembershipRole>('renter');
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [dialogError, setDialogError] = React.useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  function resetForm() {
    setEmail('');
    setFullName('');
    setPhone('');
    setRole('renter');
    setFieldErrors({});
    setDialogError(null);
  }

  React.useEffect(() => {
    if (open) resetForm();
  }, [open]);

  function validate(): boolean {
    const errors: FieldErrors = {};
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      errors.email = 'Email is required.';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      errors.email = 'Enter a valid email address.';
    }
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
      const result = await addMemberAction({
        email: email.trim().toLowerCase(),
        fullName: fullName.trim() || undefined,
        phone: phone.trim() || undefined,
        role,
      });

      if ('error' in result) {
        if (result.error === 'validation') {
          const msg = result.message.toLowerCase();
          if (msg.includes('email')) {
            setFieldErrors((p) => ({ ...p, email: result.message }));
          } else {
            setDialogError(result.message);
          }
          return;
        }
        if (result.error === 'forbidden' || result.error === 'unauthenticated') {
          setDialogError('You do not have permission to add members.');
          return;
        }
        setDialogError('Something went wrong. Please try again.');
        return;
      }

      if (!result.ok) {
        if (result.reason === 'email_taken') {
          setFieldErrors((p) => ({
            ...p,
            email: 'This email address is already in use by another member.',
          }));
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
      <Button onClick={() => setOpen(true)} size="sm">
        <UserPlus className="h-4 w-4 mr-1.5" aria-hidden="true" />
        Add member
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add roster member</DialogTitle>
          </DialogHeader>

          {/* [AUTH-DECISION] how-they-get-a-login notice */}
          <div className="flex items-start gap-2 rounded-md border border-brand/20 bg-brand/5 px-3 py-2.5 text-sm text-brand-ink">
            <Info className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              <strong>No login yet.</strong> To let them sign in, open their profile after adding
              them and use <strong>Create login link</strong>, then send them the link.
            </span>
          </div>

          <form onSubmit={handleSubmit} noValidate className="space-y-4 pt-1">
            {dialogError && (
              <Alert variant="destructive" role="alert" aria-live="assertive">
                <XCircle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>{dialogError}</AlertDescription>
              </Alert>
            )}

            {/* Email (required) */}
            <div className="space-y-1.5">
              <Label htmlFor="am-email">
                Email <span aria-hidden="true" className="text-red-500 dark:text-red-400">*</span>
              </Label>
              <Input
                id="am-email"
                type="email"
                inputMode="email"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setFieldErrors((p) => ({ ...p, email: undefined }));
                }}
                placeholder="pilot@example.com"
                autoComplete="email"
                disabled={isSubmitting}
                aria-required="true"
                aria-invalid={fieldErrors.email ? 'true' : undefined}
                aria-describedby={fieldErrors.email ? 'am-email-err' : undefined}
                className={fieldErrors.email ? 'border-red-500' : ''}
              />
              {fieldErrors.email && (
                <p id="am-email-err" role="alert" className="text-xs text-red-600 dark:text-red-400">
                  {fieldErrors.email}
                </p>
              )}
            </div>

            {/* Full name (optional) */}
            <div className="space-y-1.5">
              <Label htmlFor="am-fullName">Full name (optional)</Label>
              <Input
                id="am-fullName"
                value={fullName}
                onChange={(e) => {
                  setFullName(e.target.value);
                  setFieldErrors((p) => ({ ...p, fullName: undefined }));
                }}
                placeholder="Jane Smith"
                disabled={isSubmitting}
                aria-invalid={fieldErrors.fullName ? 'true' : undefined}
                aria-describedby={fieldErrors.fullName ? 'am-fullName-err' : undefined}
                className={fieldErrors.fullName ? 'border-red-500' : ''}
              />
              {fieldErrors.fullName && (
                <p id="am-fullName-err" role="alert" className="text-xs text-red-600 dark:text-red-400">
                  {fieldErrors.fullName}
                </p>
              )}
            </div>

            {/* Phone (optional) */}
            <div className="space-y-1.5">
              <Label htmlFor="am-phone">Phone (optional)</Label>
              <Input
                id="am-phone"
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
              <Label htmlFor="am-role">Role</Label>
              <select
                id="am-role"
                value={role}
                onChange={(e) => setRole(e.target.value as MembershipRole)}
                disabled={isSubmitting}
                className="flex h-10 w-full rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 hover:border-slate-400 dark:hover:border-slate-500 focus-visible:outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-offset-0 disabled:opacity-50 transition-colors"
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
                Add member
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
