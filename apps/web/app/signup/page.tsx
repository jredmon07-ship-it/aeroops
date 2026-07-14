/**
 * app/signup/page.tsx — public self-serve signup (Slice SIGNUP).
 *
 * Creates a new operator org + owner account. Outside /o/[slug]/* so it carries
 * no auth shell and needs no session (the visitor has no org yet). The heavy
 * lifting is in <SignupForm> (client) → signupAction → createOrgWithOwner.
 */
import Link from 'next/link';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { SignupForm } from './signup-form';

export const metadata = {
  title: 'Create your AeroOps operation',
};

export default function SignupPage() {
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
            <p className="mt-2 text-center text-xs text-slate-400 dark:text-slate-500">
              Want to look around first?{' '}
              <Link href="/o/alpha/login" className="underline hover:text-slate-600 dark:hover:text-slate-300">
                Open the live demo
              </Link>
              .
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
