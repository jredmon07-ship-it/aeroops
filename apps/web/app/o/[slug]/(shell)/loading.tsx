/**
 * loading.tsx — Suspense loading skeleton for the org dashboard.
 *
 * Rendered by Next.js while the dashboard server component fetches
 * getDashboardSummary. The layout shell (header + sidebar) renders
 * immediately from the layout.tsx server component; only the inner
 * dashboard content triggers this skeleton.
 */
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function DashboardLoading() {
  return (
    <div className="space-y-6">
      {/* Welcome heading skeleton */}
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-40" />
      </div>

      {/* Status banner skeleton */}
      <Skeleton className="h-12 w-full rounded-md" />

      {/* Hub card skeletons */}
      <div>
        <Skeleton className="mb-3 h-4 w-28" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-24" />
                <Skeleton className="mt-1 h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-5 w-28 rounded-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
