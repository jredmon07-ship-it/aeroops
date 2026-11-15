/**
 * viewer-time-zone-sync.tsx — Reports the browser's time zone to the server.
 *
 * The schedule pages pick "today" and query a day's reservations in the
 * viewer's zone, which the server reads from the aeroops-tz cookie
 * (lib/viewer-time-zone.ts). This writes that cookie and, when the page was
 * rendered for another zone (a first visit, or the device changed zones),
 * refreshes it once so the day shown matches the times the browser shows.
 * Renders nothing.
 */
'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { VIEWER_TZ_COOKIE } from '@/lib/schedule-day';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

interface ViewerTimeZoneSyncProps {
  /** The zone the server rendered this page for. */
  serverTimeZone: string;
}

export function ViewerTimeZoneSync({ serverTimeZone }: ViewerTimeZoneSyncProps) {
  const router = useRouter();
  // The zone a refresh was last asked for. A blocked cookie, or a zone the
  // server cannot resolve, leaves serverTimeZone unchanged after the refresh:
  // this keeps that from refreshing again.
  const refreshedFor = React.useRef<string | null>(null);

  React.useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz) return;
    const secure = window.location.protocol === 'https:' ? '; secure' : '';
    document.cookie = `${VIEWER_TZ_COOKIE}=${encodeURIComponent(tz)}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax${secure}`;
    if (tz !== serverTimeZone && refreshedFor.current !== serverTimeZone) {
      refreshedFor.current = serverTimeZone;
      router.refresh();
    }
  }, [router, serverTimeZone]);

  return null;
}
