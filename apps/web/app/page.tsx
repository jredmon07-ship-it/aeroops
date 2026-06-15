/**
 * app/page.tsx — Root placeholder page.
 *
 * Neutral landing — no org chooser logic, no auth required.
 * Users arrive here if they navigate to the root URL without a slug.
 */
export default function RootPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-bold text-slate-900">AeroOps</h1>
        <p className="mt-3 text-slate-600">
          Enter your operator&apos;s address, e.g.{' '}
          <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-sm text-slate-800">
            /o/your-school
          </code>
        </p>
      </div>
    </main>
  );
}
