/**
 * set-password-form.tsx — the client form on a login link: new password +
 * confirm, inline validation, submitting / error / invalid-link / success.
 *
 * On success it sends the member to /o/[slug]/login?notice=password-set,
 * where the sign-in card confirms the password was saved. The server
 * (acceptLoginLink) re-validates everything; the checks here are courtesy.
 * The password lengths come from the server page (the shared signup policy)
 * so the client never imports @aeroops/api.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { acceptLoginLinkAction } from './actions';

interface SetPasswordFormProps {
  slug: string;
  token: string;
  email: string;
  minLength: number;
  maxLength: number;
}

type FormState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'invalid' }
  | { status: 'success' }
  | { status: 'error'; message: string };

interface FieldErrors {
  password?: string;
  confirm?: string;
}

export function SetPasswordForm({ slug, token, email, minLength, maxLength }: SetPasswordFormProps) {
  const router = useRouter();
  const [state, setState] = React.useState<FormState>({ status: 'idle' });
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [errors, setErrors] = React.useState<FieldErrors>({});
  const passwordRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    passwordRef.current?.focus();
  }, []);

  function validatePassword(value: string): string | undefined {
    if (!value) return 'Enter a password.';
    if (value.length < minLength) return `Use at least ${minLength} characters.`;
    if (value.length > maxLength) return `Use ${maxLength} characters or fewer.`;
    return undefined;
  }

  function validateConfirm(value: string, pw: string): string | undefined {
    if (!value) return 'Type the password again.';
    if (value !== pw) return "Passwords don't match.";
    return undefined;
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next: FieldErrors = {
      password: validatePassword(password),
      confirm: validateConfirm(confirm, password),
    };
    setErrors(next);
    if (next.password || next.confirm) return;

    setState({ status: 'submitting' });
    try {
      const result = await acceptLoginLinkAction({ slug, token, password });
      if ('error' in result) {
        if (result.error === 'validation') {
          setErrors({ password: result.message });
          setState({ status: 'idle' });
          return;
        }
        setState({ status: 'error', message: "Couldn't save your password. Please try again." });
        return;
      }
      if (!result.ok) {
        setState({ status: 'invalid' });
        return;
      }
      setState({ status: 'success' });
      router.push(`/o/${slug}/login?notice=password-set`);
    } catch {
      setState({ status: 'error', message: "Couldn't save your password. Check your connection and try again." });
    }
  }

  if (state.status === 'invalid') {
    return (
      <div className="space-y-4">
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            This link is no longer valid. It may have expired or already been used. Ask your operator
            for a new one.
          </AlertDescription>
        </Alert>
        <p className="text-center text-sm text-slate-500 dark:text-slate-400">
          <Link href={`/o/${slug}/login`} className="font-medium underline hover:text-slate-700 dark:hover:text-slate-300">
            Go to sign in
          </Link>
        </p>
      </div>
    );
  }

  if (state.status === 'success') {
    return (
      <div role="status" aria-live="polite" className="space-y-2 text-center text-sm text-slate-600 dark:text-slate-300">
        <p className="font-medium text-slate-900 dark:text-slate-100">Password saved.</p>
        <p>Taking you to sign in…</p>
      </div>
    );
  }

  const isSubmitting = state.status === 'submitting';

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      {state.status === 'error' && (
        <Alert variant="destructive" role="alert" aria-live="assertive">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}

      {/* Lets password managers save the new password against the right account. */}
      <input
        type="email"
        name="username"
        autoComplete="username"
        value={email}
        readOnly
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
      />

      <div className="space-y-1.5">
        <Label htmlFor="new-password">New password</Label>
        <Input
          ref={passwordRef}
          id="new-password"
          name="new-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (errors.password) setErrors((p) => ({ ...p, password: undefined }));
          }}
          onBlur={() => password && setErrors((p) => ({ ...p, password: validatePassword(password) }))}
          disabled={isSubmitting}
          placeholder={`At least ${minLength} characters`}
          aria-required="true"
          aria-invalid={errors.password ? 'true' : undefined}
          aria-describedby={errors.password ? 'new-password-err' : 'new-password-hint'}
          className={errors.password ? 'border-red-500' : ''}
        />
        {errors.password ? (
          <p id="new-password-err" role="alert" className="text-xs text-red-600 dark:text-red-400">
            {errors.password}
          </p>
        ) : (
          <p id="new-password-hint" className="text-xs text-slate-500 dark:text-slate-400">
            At least {minLength} characters. A short phrase is easier to remember.
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="confirm-password">Confirm password</Label>
        <Input
          id="confirm-password"
          name="confirm-password"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => {
            setConfirm(e.target.value);
            if (errors.confirm) setErrors((p) => ({ ...p, confirm: undefined }));
          }}
          onBlur={() => confirm && setErrors((p) => ({ ...p, confirm: validateConfirm(confirm, password) }))}
          disabled={isSubmitting}
          aria-required="true"
          aria-invalid={errors.confirm ? 'true' : undefined}
          aria-describedby={errors.confirm ? 'confirm-password-err' : undefined}
          className={errors.confirm ? 'border-red-500' : ''}
        />
        {errors.confirm && (
          <p id="confirm-password-err" role="alert" className="text-xs text-red-600 dark:text-red-400">
            {errors.confirm}
          </p>
        )}
      </div>

      <Button type="submit" className="w-full" disabled={isSubmitting} aria-busy={isSubmitting}>
        {isSubmitting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            Saving…
          </>
        ) : (
          'Save password'
        )}
      </Button>
    </form>
  );
}
