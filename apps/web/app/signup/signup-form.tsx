/**
 * signup/signup-form.tsx — the client signup form (Slice SIGNUP).
 *
 * Collects org name, owner name, email, password, and a REQUIRED clickwrap
 * acceptance of the Terms + Privacy Policy (plus a hidden honeypot). On success
 * it signs the new owner in with the SAME password (already in hand) via the
 * existing credentials flow, then lands them on the setup checklist.
 */
'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { signupAction, type SignupActionResult } from './actions';

/**
 * One message per refusal reason. Typed as an exhaustive Record so adding a new
 * reason to SignupActionResult is a compile error here until it gets copy.
 */
type SignupRefusalReason = Extract<SignupActionResult, { ok: false }>['reason'];
const REASON_MESSAGE: Record<SignupRefusalReason, string> = {
  signup_disabled: 'Signup is turned off on this server.',
  invalid_name: 'Please use a name with a few letters or numbers.',
  slug_unavailable: 'That name is taken. Try a slightly different one.',
};

type FormState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'error'; message: string };

export function SignupForm() {
  const router = useRouter();
  const [state, setState] = React.useState<FormState>({ status: 'idle' });
  const [accepted, setAccepted] = React.useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const orgName = (fd.get('orgName') as string).trim();
    const ownerFullName = (fd.get('ownerFullName') as string).trim();
    const email = (fd.get('email') as string).trim();
    const password = fd.get('password') as string;
    const website = (fd.get('website') as string) || ''; // honeypot

    if (!orgName || !ownerFullName || !email || !password) {
      setState({ status: 'error', message: 'Please fill in every field.' });
      return;
    }
    if (!accepted) {
      setState({ status: 'error', message: 'Please accept the Terms and Privacy Policy to continue.' });
      return;
    }
    if (password.length < 10) {
      setState({ status: 'error', message: 'Use a password of at least 10 characters.' });
      return;
    }

    setState({ status: 'submitting' });
    try {
      const result = await signupAction({
        orgName,
        ownerFullName,
        email,
        password,
        acceptedTerms: accepted,
        website,
      });

      if ('error' in result) {
        setState({
          status: 'error',
          message:
            result.error === 'validation'
              ? 'Please check your details and try again.'
              : 'Something went wrong creating your operation. Please try again.',
        });
        return;
      }
      if (!result.ok) {
        setState({
          status: 'error',
          message: REASON_MESSAGE[result.reason],
        });
        return;
      }

      // Created. Sign the new owner in with the password they just set, then
      // land on the setup checklist.
      const signInResult = await signIn('credentials', {
        slug: result.slug,
        email: result.email,
        password,
        redirect: false,
      });
      if (!signInResult || signInResult.error) {
        // Account exists but auto sign-in hiccuped — send them to their login.
        router.push(`/o/${result.slug}/login`);
        return;
      }
      router.push(`/o/${result.slug}/setup`);
      router.refresh();
    } catch {
      setState({ status: 'error', message: 'An unexpected error occurred. Please try again.' });
    }
  }

  const submitting = state.status === 'submitting';

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {state.status === 'error' && (
        <Alert variant="destructive" role="alert" aria-live="assertive">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="orgName">Operation name</Label>
        <Input id="orgName" name="orgName" autoComplete="organization" placeholder="Your operation's name" required />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="ownerFullName">Your name</Label>
        <Input id="ownerFullName" name="ownerFullName" autoComplete="name" placeholder="Your name" required />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="email">Email address</Label>
        <Input id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          placeholder="At least 10 characters"
          minLength={10}
          required
        />
      </div>

      {/* Honeypot — visually hidden, off the tab order. Bots fill it. */}
      <div aria-hidden className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="website">Website</label>
        <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <div className="flex items-start gap-2 pt-1">
        <input
          id="acceptedTerms"
          type="checkbox"
          checked={accepted}
          onChange={(e) => setAccepted(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-ink focus:ring-brand-ink dark:border-slate-600"
        />
        <Label htmlFor="acceptedTerms" className="text-sm font-normal leading-snug text-slate-600 dark:text-slate-300">
          I agree to the{' '}
          <a href="/terms.html" target="_blank" rel="noreferrer" className="underline">
            Terms of Service
          </a>{' '}
          and{' '}
          <a href="/privacy.html" target="_blank" rel="noreferrer" className="underline">
            Privacy Policy
          </a>
          , and I have authority to enroll this operation.
        </Label>
      </div>

      <Button type="submit" className="w-full" disabled={submitting} aria-busy={submitting}>
        {submitting ? 'Creating your operation…' : 'Create operation'}
      </Button>
    </form>
  );
}
