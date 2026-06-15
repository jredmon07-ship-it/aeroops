/**
 * login-form.tsx — Client component for the credentials login form.
 *
 * Handles:
 *   - idle state: empty form
 *   - submitting state: disabled inputs + spinner
 *   - invalid-credentials error: generic Alert (never reveals which field)
 *   - generic server error: Alert with fallback message
 *
 * The slug comes from the parent server component (derived from the URL route),
 * never from user input.
 *
 * Auth flow: signIn('credentials', { slug, email, password, redirect: false })
 * On success: router.push to the org landing page.
 * On failure: render error alert; keep form interactive.
 */
'use client';

import * as React from 'react';
import { signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

interface LoginFormProps {
  slug: string;
}

type FormState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'error'; message: string };

export function LoginForm({ slug }: LoginFormProps) {
  const router = useRouter();
  const [state, setState] = React.useState<FormState>({ status: 'idle' });

  const emailRef = React.useRef<HTMLInputElement>(null);

  // Autofocus on mount
  React.useEffect(() => {
    emailRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();

    const formData = new FormData(e.currentTarget);
    const email = (formData.get('email') as string).trim();
    const password = formData.get('password') as string;

    // Basic client-side empty check (server validates fully)
    if (!email || !password) {
      setState({
        status: 'error',
        message: 'Please enter your email address and password.',
      });
      return;
    }

    setState({ status: 'submitting' });

    try {
      const result = await signIn('credentials', {
        slug,
        email,
        password,
        redirect: false,
      });

      if (!result || result.error) {
        // Auth.js Credentials returns error: 'CredentialsSignin' for invalid creds.
        // We surface a generic message — never reveal which field was wrong.
        setState({
          status: 'error',
          message: 'Incorrect email or password.',
        });
        return;
      }

      // Success — navigate to the org landing page
      router.push(`/o/${slug}`);
      router.refresh();
    } catch {
      setState({
        status: 'error',
        message: 'An unexpected error occurred. Please try again.',
      });
    }
  }

  const isSubmitting = state.status === 'submitting';

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {state.status === 'error' && (
        <Alert variant="destructive" role="alert" aria-live="assertive">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="email">Email address</Label>
        <Input
          ref={emailRef}
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          disabled={isSubmitting}
          placeholder="you@example.com"
          aria-describedby={state.status === 'error' ? 'login-error' : undefined}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={isSubmitting}
          placeholder="••••••••"
        />
      </div>

      <Button
        type="submit"
        className="w-full"
        disabled={isSubmitting}
        aria-busy={isSubmitting}
      >
        {isSubmitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span>Signing in…</span>
          </>
        ) : (
          'Sign in'
        )}
      </Button>
    </form>
  );
}
