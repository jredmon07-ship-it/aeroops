/**
 * activity/page.tsx — Activity feed page (Slice A1.2, RSC).
 *
 * Route: /o/[slug]/activity
 * Capability: reporting:access (owner/manager/dispatcher/cfi/accountant).
 *   — NO redirect on denied (shell is app:access); renders permission-denied panel.
 *   — Real gate is enforced inside listActivity (requireCapability).
 *
 * Layout (top → bottom):
 *   A. Heading "Activity" (OUTSIDE Suspense — always instant)
 *   B. Vertical timeline list — each entry:
 *        actorName (bold) + summary + relative time + optional entity link
 *   C. "Load more" link (server-link ?before=<cursor> approach — RSC-native)
 *
 * States:
 *   Loading           — ActivitySkeleton (Suspense boundary, aria-busy)
 *   Populated         — timeline entries
 *   Empty             — "No activity yet" nudge
 *   Error             — destructive Alert + Retry
 *   Permission-denied — tasteful "not available" panel; NO redirect
 *
 * "Load more" uses a ?before=<base64-encoded cursor JSON> server link so the
 * RSC page re-renders at the server with the cursor, accumulating pages via
 * ?before= on each subsequent page link. This mirrors the reports ?range=
 * server-link approach — no client JS needed.
 *
 * BOUNDARY: imports ONLY from '@aeroops/api'. Never '@aeroops/db'.
 *
 * [VERIFY-A1-CAP]       Actor names visible to full reporting:access set.
 * [VERIFY-A1-RETENTION] No retention obligation imposed by this page.
 */

import * as React from 'react';
import { Suspense } from 'react';
import Link from 'next/link';
import { Activity, AlertCircle } from 'lucide-react';
import { auth } from '@/auth';
import { hasCapability, getOrgFeatures } from '@aeroops/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { listActivityAction } from './actions';
import type { SerializedActivityEntry, SerializedActivityCursor } from './actions';
import { formatRelativeTime } from '@/lib/activity-utils';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';

// ─── Permission-denied panel (mirrors dashboard + reports design) ─────────────

function PermissionDeniedPanel() {
  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-6 py-10 text-center space-y-2">
      <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
        Activity isn&apos;t available for your role.
      </p>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Contact your administrator if you need access.
      </p>
    </div>
  );
}

// ─── Module-disabled panel (Slice CLUB-MODE) ──────────────────────────────────

function ModuleDisabledPanel() {
  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-6 py-10 text-center space-y-2">
      <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
        Reports are turned off for this organization.
      </p>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        An owner or manager can turn them back on in Org settings.
      </p>
    </div>
  );
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function ActivitySkeleton() {
  return (
    <div
      className="space-y-0 animate-pulse"
      aria-busy="true"
      aria-label="Loading activity feed"
    >
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <div
          key={i}
          className="flex gap-4 py-4 border-b border-slate-100 dark:border-slate-800 last:border-0"
        >
          {/* Timeline dot */}
          <div className="flex flex-col items-center pt-1 shrink-0">
            <Skeleton className="h-2 w-2 rounded-full" />
            {i < 7 && <div className="w-px flex-1 bg-slate-100 dark:bg-slate-800 mt-2" />}
          </div>
          {/* Content */}
          <div className="flex-1 space-y-2 min-w-0 pb-2">
            <div className="flex items-start justify-between gap-4">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-12 shrink-0" />
            </div>
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Single timeline entry ────────────────────────────────────────────────────

interface TimelineEntryProps {
  entry: SerializedActivityEntry;
  slug: string;
  isLast: boolean;
}

function TimelineEntry({ entry, slug, isLast }: TimelineEntryProps) {
  const relTime = formatRelativeTime(entry.createdAt);
  const fullPath = entry.entityPath ? `/o/${slug}${entry.entityPath}` : null;

  return (
    <div className="flex gap-4 py-4 border-b border-slate-100 dark:border-slate-800 last:border-0">
      {/* Timeline dot + connector */}
      <div className="flex flex-col items-center pt-1.5 shrink-0">
        <div
          className="h-2 w-2 rounded-full bg-brand shrink-0"
          aria-hidden="true"
        />
        {!isLast && (
          <div className="w-px flex-1 bg-slate-100 dark:bg-slate-800 mt-2" aria-hidden="true" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0 pb-2">
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm text-slate-700 dark:text-slate-300 leading-snug">
            <span className="font-semibold text-slate-900 dark:text-slate-100">
              {entry.actorName}
            </span>{' '}
            {fullPath ? (
              <Link
                href={fullPath}
                className="text-brand hover:text-brand-ink underline underline-offset-2"
              >
                {entry.summary}
              </Link>
            ) : (
              <span>{entry.summary}</span>
            )}
          </p>
          <time
            dateTime={entry.createdAt}
            className="nums text-xs text-slate-400 dark:text-slate-500 shrink-0 tabular-nums whitespace-nowrap pt-0.5"
            title={entry.createdAt}
          >
            {relTime}
          </time>
        </div>
        <p className="mt-0.5 text-[0.6875rem] text-slate-400 dark:text-slate-500 capitalize">
          {entry.entityType.replace(/_/g, ' ')}
        </p>
      </div>
    </div>
  );
}

// ─── Cursor codec (base64-encoded JSON — URL-safe) ────────────────────────────

function encodeCursor(cursor: SerializedActivityCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(raw: string): SerializedActivityCursor | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'createdAt' in parsed &&
      'id' in parsed &&
      typeof (parsed as Record<string, unknown>).createdAt === 'string' &&
      typeof (parsed as Record<string, unknown>).id === 'string'
    ) {
      return parsed as SerializedActivityCursor;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Activity content (async RSC) ─────────────────────────────────────────────

interface ActivityContentProps {
  slug: string;
  cursor: SerializedActivityCursor | null;
}

async function ActivityContent({ slug, cursor }: ActivityContentProps) {
  const result = await listActivityAction(cursor ? { cursor } : undefined);

  // Error state
  if ('error' in result) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        <AlertDescription className="flex items-center justify-between gap-4">
          <span>Could not load activity. Please try again.</span>
          <Link
            href={`/o/${slug}/activity`}
            className="text-sm underline underline-offset-2 hover:no-underline"
          >
            Retry
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  const { data } = result;
  const { entries, nextCursor } = data;

  // Empty state
  if (entries.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        title="No activity yet."
        body="Actions by your team will appear here."
        className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 py-12"
      />
    );
  }

  const loadMoreHref = nextCursor
    ? `/o/${slug}/activity?before=${encodeCursor(nextCursor)}`
    : null;

  return (
    <div>
      {/* Timeline list */}
      <div
        className="rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs divide-y-0"
        aria-label="Activity timeline"
        role="feed"
      >
        <div className="px-4 pt-1 pb-1">
          {entries.map((entry, idx) => (
            <TimelineEntry
              key={entry.id}
              entry={entry}
              slug={slug}
              isLast={idx === entries.length - 1 && !loadMoreHref}
            />
          ))}
        </div>
      </div>

      {/* Load more — server link (RSC-native, no client JS) */}
      {loadMoreHref && (
        <div className="mt-4 flex justify-center">
          <Link
            href={loadMoreHref}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-2 text-sm font-medium text-slate-700 dark:text-slate-300 shadow-xs hover:bg-slate-50 dark:hover:bg-slate-800 hover:border-slate-300 dark:hover:border-slate-600 transition-colors"
            aria-label="Load more activity entries"
          >
            Load more
          </Link>
        </div>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

interface ActivityPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ before?: string }>;
}

export default async function ActivityPage({
  params,
  searchParams,
}: ActivityPageProps) {
  const { slug } = await params;
  const sp = await searchParams;
  const rawBefore = sp.before;

  const session = await auth();

  // Parse + validate the ?before= cursor param.
  const cursor = rawBefore ? decodeCursor(rawBefore) : null;

  // UI-only capability check — gate is enforced server-side in the action.
  // NO redirect: shell is app:access; the activity section is reporting:access.
  const canView = session ? hasCapability(session, 'reporting:access') : false;

  // ── Module gate (Slice CLUB-MODE) — panel pattern, no redirect. Only checked
  // once role access is confirmed; fail-soft to enabled on read failure.
  // Activity shares the 'reports' module (same nav grouping as Reports).
  let reportsModuleEnabled = true;
  if (canView) {
    try {
      const orgFeatures = await getOrgFeatures(session);
      reportsModuleEnabled = orgFeatures.features.reports;
    } catch {
      reportsModuleEnabled = true;
    }
  }

  return (
    <div className="space-y-6">
      {/* ── A. Heading row — OUTSIDE Suspense (always instant) ─────────── */}
      <PageHeader
        title="Activity"
        subtitle="Recent actions by your team, in reverse chronological order."
      />

      {/* ── B+C: ONE Suspense boundary ───────────────────────────────────── */}
      {!canView ? (
        <PermissionDeniedPanel />
      ) : !reportsModuleEnabled ? (
        <ModuleDisabledPanel />
      ) : (
        <Suspense fallback={<ActivitySkeleton />}>
          <ActivityContent slug={slug} cursor={cursor} />
        </Suspense>
      )}
    </div>
  );
}
