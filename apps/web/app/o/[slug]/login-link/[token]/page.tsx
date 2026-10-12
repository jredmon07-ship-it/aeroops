/**
 * app/o/[slug]/login-link/[token]/page.tsx — open a login link, choose a
 * password (public; no session required — see middleware.ts).
 *
 * States:
 *   1. invalid  — token bad/expired/used, slug isn't the token's org, org
 *                 suspended, member removed or deactivated. ONE generic
 *                 message ("no longer valid, ask for a new one") — never which.
 *   2. error    — the check itself failed (infrastructure); try again.
 *   3. ready    — set-password form (<SetPasswordForm>, which owns the
 *                 submitting / validation / invalid / success states and
 *                 redirects to /o/[slug]/login?notice=password-set).
 *
 * The URL carries a credential, so the page is noindex and sends no Referer.
 * org_id comes ONLY from the signed token (cross-checked against the slug
 * inside checkLoginLink) — never from the URL alone.
 */
import Link from 'next/link';
import type { Metadata } from 'next';
import { checkLoginLink, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '@aeroops/api';
import type { CheckLoginLinkResult } from '@aeroops/api';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SetPasswordForm } from './set-password-form';

export const metadata: Metadata = {
  title: 'Set your password · AeroOps',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

interface LoginLinkPageProps {
  params: Promise<{ slug: string; token: string }>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm" role="main">
        <Card>{children}</Card>
      </div>
    </main>
  );
}

export default async function LoginLinkPage({ params }: LoginLinkPageProps) {
  const { slug, token } = await params;

  let check: CheckLoginLinkResult | 'error';
  try {
    check = await checkLoginLink({ slug, token });
  } catch {
    check = 'error';
  }

  if (check === 'error') {
    return (
      <Shell>
        <CardHeader>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            Something went wrong
          </h1>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              We couldn&apos;t check this link right now. Reload the page in a minute to try again.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Shell>
    );
  }

  if (!check.ok) {
    return (
      <Shell>
        <CardHeader>
          <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            Link no longer valid
          </h1>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant="destructive" role="alert">
            <AlertDescription>
              This link is no longer valid. It may have expired or already been used. Ask your
              operator for a new one.
            </AlertDescription>
          </Alert>
          <p className="text-center text-sm text-slate-500 dark:text-slate-400">
            Already set a password?{' '}
            <Link href={`/o/${slug}/login`} className="font-medium underline hover:text-slate-700 dark:hover:text-slate-300">
              Sign in
            </Link>
          </p>
        </CardContent>
      </Shell>
    );
  }

  const isReset = check.mode === 'reset';

  return (
    <Shell>
      <CardHeader className="text-center">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
          {isReset ? 'Choose a new password' : `Welcome to ${check.orgName}`}
        </h1>
        <CardDescription>
          {isReset
            ? `Set a new password for ${check.email}. Your old password stops working.`
            : `Choose a password for ${check.email}. You'll use it with this email to sign in.`}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <SetPasswordForm
          slug={slug}
          token={token}
          email={check.email}
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
        />
      </CardContent>
    </Shell>
  );
}
