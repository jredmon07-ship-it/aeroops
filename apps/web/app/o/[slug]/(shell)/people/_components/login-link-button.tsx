/**
 * login-link-button.tsx — "Create login link" / "Create reset link" on member
 * detail (people:manage only; rendered only when the viewer may create one).
 *
 * Clicking mints a 7-day, single-use link (createLoginLinkAction → the
 * server enforces people:manage + the owner-only rule for owner/manager
 * targets) and shows it in a dialog with a Copy button and the expiry.
 * AeroOps sends no email — the operator passes the link on themselves.
 *
 * Creating a new link does not cancel an older unused one; whichever is used
 * first sets the password and every other link for that member stops working.
 */
'use client';

import * as React from 'react';
import { KeyRound, Copy, Check, XCircle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { createLoginLinkAction } from '../actions';
import type { CreateLoginLinkActionResult } from '../actions';

interface LoginLinkButtonProps {
  userId: string;
  displayName: string;
  /** true → the member already has a password; the link replaces it. */
  hasLogin: boolean;
}

type LinkState =
  | { phase: 'idle' }
  | { phase: 'creating' }
  | { phase: 'ready'; url: string; expiresAt: string }
  | { phase: 'error'; message: string };

/** Specific copy for every refusal/error the action can return. */
function errorMessage(result: Exclude<CreateLoginLinkActionResult, { ok: true }>): string {
  if ('error' in result) {
    if (result.error === 'forbidden' || result.error === 'unauthenticated') {
      return 'You do not have permission to create login links.';
    }
    return "Couldn't create the link. Please try again.";
  }
  switch (result.reason) {
    case 'not_found':
      return 'This member was not found. They may have been removed.';
    case 'inactive':
      return 'This member is deactivated. Reactivate them first, then create a link.';
    case 'self_not_allowed':
      return 'You cannot create a login link for yourself. Ask an owner.';
    case 'target_outranks':
      return 'Only an owner can create a login link for an owner or manager.';
    case 'demo_org':
      return 'Login links are turned off on the shared demo.';
  }
}

function formatExpiry(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export function LoginLinkButton({ userId, displayName, hasLogin }: LoginLinkButtonProps) {
  const [open, setOpen] = React.useState(false);
  const [state, setState] = React.useState<LinkState>({ phase: 'idle' });
  const [copied, setCopied] = React.useState(false);
  const [copyError, setCopyError] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const label = hasLogin ? 'Create reset link' : 'Create login link';

  async function handleCreate() {
    setOpen(true);
    setCopied(false);
    setCopyError(false);
    setState({ phase: 'creating' });
    try {
      const result = await createLoginLinkAction({ userId });
      if ('ok' in result && result.ok) {
        setState({
          phase: 'ready',
          url: `${window.location.origin}${result.path}`,
          expiresAt: result.expiresAt,
        });
        return;
      }
      setState({ phase: 'error', message: errorMessage(result as Exclude<CreateLoginLinkActionResult, { ok: true }>) });
    } catch {
      setState({ phase: 'error', message: "Couldn't create the link. Please try again." });
    }
  }

  async function handleCopy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopyError(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (permissions / insecure context) — select it instead.
      setCopyError(true);
      inputRef.current?.select();
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={handleCreate}>
        <KeyRound className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
        {label}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{hasLogin ? 'Password reset link' : 'Login link'}</DialogTitle>
            <DialogDescription>
              {hasLogin
                ? `${displayName} opens this link to choose a new password. Their current password stops working once they do.`
                : `${displayName} opens this link to choose a password, then signs in with their email.`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-1" aria-live="polite">
            {state.phase === 'creating' && (
              <div className="space-y-2 animate-pulse" aria-busy="true" aria-label="Creating link">
                <div className="h-10 w-full rounded-md bg-slate-100 dark:bg-slate-800" />
                <div className="h-4 w-2/3 rounded bg-slate-100 dark:bg-slate-800" />
              </div>
            )}

            {state.phase === 'error' && (
              <Alert variant="destructive" role="alert">
                <XCircle className="h-4 w-4" aria-hidden="true" />
                <AlertDescription>{state.message}</AlertDescription>
              </Alert>
            )}

            {state.phase === 'ready' && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="login-link-url">Link</Label>
                  <div className="flex gap-2">
                    <Input
                      id="login-link-url"
                      ref={inputRef}
                      readOnly
                      value={state.url}
                      onFocus={(e) => e.currentTarget.select()}
                      className="font-mono text-xs"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-10 shrink-0"
                      onClick={() => handleCopy(state.url)}
                      aria-label={copied ? 'Link copied' : 'Copy link'}
                    >
                      {copied ? (
                        <Check className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
                      ) : (
                        <Copy className="h-3.5 w-3.5 mr-1.5" aria-hidden="true" />
                      )}
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                  {copyError && (
                    <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                      Couldn&apos;t copy automatically — the link is selected; copy it with your keyboard.
                    </p>
                  )}
                </div>
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  Expires <strong>{formatExpiry(state.expiresAt)}</strong>. Works once.
                </p>
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  Send this link to {displayName} yourself — AeroOps does not send email.
                </p>
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  Anyone with this link can set this member&apos;s password, so send it only to them.
                </p>
              </>
            )}
          </div>

          <DialogFooter>
            {state.phase === 'error' && (
              <Button type="button" variant="outline" onClick={handleCreate}>
                Try again
              </Button>
            )}
            <DialogClose asChild>
              <Button type="button">Done</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
