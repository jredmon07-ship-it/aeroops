/**
 * immediate-sign-out-button.tsx — Sign-out button without a confirm dialog.
 *
 * Used on the no-access page where the user is already in an error state
 * and there is nothing to lose by signing out immediately.
 *
 * Contrast with <SignOutButton> on the landing page, which requires an
 * AlertDialog confirmation.
 */
'use client';

import * as React from 'react';
import { Button } from '@/components/ui/button';
import { signOutAction } from '../actions';

interface ImmediateSignOutButtonProps {
  slug: string;
}

export function ImmediateSignOutButton({ slug }: ImmediateSignOutButtonProps) {
  const [isPending, startTransition] = React.useTransition();

  function handleSignOut() {
    startTransition(async () => {
      await signOutAction(slug);
    });
  }

  return (
    <Button
      variant="outline"
      onClick={handleSignOut}
      disabled={isPending}
      aria-busy={isPending}
    >
      {isPending ? 'Signing out…' : 'Sign out'}
    </Button>
  );
}
