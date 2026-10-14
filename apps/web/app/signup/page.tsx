/**
 * app/signup/page.tsx — public self-serve signup (Slice SIGNUP).
 *
 * Creates a new operator org + owner account. Outside /o/[slug]/* so it carries
 * no auth shell and needs no session (the visitor has no org yet). The heavy
 * lifting is in <SignupForm> (client) → signupAction → createOrgWithOwner.
 *
 * Gated by ALLOW_SIGNUP (lib/signup-enabled.ts, default OFF). When off, the
 * page renders a plain "signup is turned off" card instead of the form.
 * signupAction enforces the same switch server-side; this page is courtesy.
 *
 * The page is shared by the public demo and every self-hosted copy, so links
 * to the sample operations (alpha / bravo) render ONLY when that org exists
 * and is active on this server (lib/demo-login.ts — unknown and suspended are
 * indistinguishable, and a lookup failure just hides the link).
 */
import Link from 'next/link';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { findActiveOrgLoginHref } from '@/lib/demo-login';
import { resolveOrgForPage } from '@/lib/org';
import { isSignupEnabled } from '@/lib/signup-enabled';
import { SignupForm } from './signup-form';

export const metadata = {
  title: 'Create your AeroOps operation',
};

// Reads ALLOW_SIGNUP at request time — never prerender a stale on/off state.
export const dynamic = 'force-dynamic';

const SOURCE_URL = 'https://github.com/jredmon07-ship-it/aeroops';

export default async function SignupPage() {
  if (!isSignupEnabled()) {
    const demoLoginHref = await findActiveOrgLoginHref('bravo', resolveOrgForPage);
    return (
      <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 p-6 dark:from-slate-950 dark:to-slate-900">
        <div className="w-full max-w-md">
          <Card>
            <CardHeader className="text-center">
              <CardTitle className="text-xl">Signup is turned off on this server.</CardTitle>
              <CardDescription>
                Ask your operation&apos;s owner for a login link, or run your own copy:{' '}
                <a href={SOURCE_URL} className="underline hover:text-slate-700 dark:hover:text-slate-300">
                  github.com/jredmon07-ship-it/aeroops
                </a>
                .
              </CardDescription>
            </CardHeader>
            {demoLoginHref && (
              <CardContent>
                <p className="text-center text-sm text-slate-500 dark:text-slate-400">
                  <Link href={demoLoginHref} className="font-medium underline hover:text-slate-700 dark:hover:text-slate-300">
                    Back to the demo login
                  </Link>
                </p>
              </CardContent>
            )}
          </Card>
        </div>
      </main>
    );
  }

  const liveDemoHref = await findActiveOrgLoginHref('alpha', resolveOrgForPage);

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 p-6 dark:from-slate-950 dark:to-slate-900">
      <div className="w-full max-w-md">
        <Card>
          <CardHeader className="text-center">
            <div className="mb-1 flex items-center justify-center gap-2">
              <span
                aria-hidden
                className="grid h-8 w-8 place-items-center rounded-sm bg-brand-ink text-sm font-bold leading-none text-white shadow-sm"
              >
                ✈
              </span>
            </div>
            <CardTitle className="text-xl">Create your operation</CardTitle>
            <CardDescription>
              Set up your flight school, club, or FBO on AeroOps. The software is free.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <SignupForm />
            <p className="mt-6 text-center text-sm text-slate-500 dark:text-slate-400">
              Already have an account? Your operation has its own sign-in page at
              {' '}
              <span className="font-mono text-slate-600 dark:text-slate-300">/o/your-org/login</span>.
            </p>
            {liveDemoHref && (
              <p className="mt-2 text-center text-xs text-slate-400 dark:text-slate-500">
                Want to look around first?{' '}
                <Link href={liveDemoHref} className="underline hover:text-slate-600 dark:hover:text-slate-300">
                  Open the live demo
                </Link>
                .
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
