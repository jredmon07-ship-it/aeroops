/**
 * setup/loading.tsx — Suspense skeleton for the "Set up your operation" page.
 *
 * Rendered while the server component runs the RBAC check + derives the
 * onboarding status.
 */
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function SetupLoading() {
  return (
    <div className="max-w-3xl space-y-6" aria-busy="true" aria-label="Loading setup">
      {/* Heading */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-80" />
      </div>

      {/* Progress card */}
      <Card>
        <CardContent className="space-y-3 pt-6">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-7 w-12" />
          </div>
          <Skeleton className="h-2 w-full rounded-full" />
        </CardContent>
      </Card>

      {/* Two step groups */}
      {[0, 1].map((g) => (
        <div key={g} className="space-y-2">
          <Skeleton className="h-4 w-32" />
          <Card className="overflow-hidden p-0">
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {[0, 1].map((i) => (
                <div key={i} className="flex items-start gap-4 px-5 py-4">
                  <Skeleton className="h-5 w-5 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-64" />
                  </div>
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
              ))}
            </div>
          </Card>
        </div>
      ))}
    </div>
  );
}
