/**
 * sign-out-button.tsx — Client component for the sign-out button with confirm dialog.
 *
 * Wraps the sign-out server action behind an AlertDialog so the user must
 * explicitly confirm before their session is destroyed.
 *
 * Focus management:
 *   - Dialog opens on "Sign out" click
 *   - Cancel button receives focus by default (safer default — Escape also cancels)
 *   - Confirm triggers the server action → redirects to /o/[slug]/login
 *
 * Used on the authenticated landing page (/o/[slug]).
 * NOT used on /o/[slug]/no-access (that one signs out immediately, no confirm).
 */
'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
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
import { signOutAction } from './actions';

interface SignOutButtonProps {
  slug: string;
}

export function SignOutButton({ slug }: SignOutButtonProps) {
  const [isPending, startTransition] = React.useTransition();

  function handleConfirm() {
    startTransition(async () => {
      await signOutAction(slug);
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" disabled={isPending}>
          {isPending ? 'Signing out…' : 'Sign out'}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Sign out?</AlertDialogTitle>
          <AlertDialogDescription>
            You will be returned to the login page. Any unsaved work will be
            lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* Cancel has autofocus — safer default, Escape also cancels */}
          <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirm}>
            Sign out
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
