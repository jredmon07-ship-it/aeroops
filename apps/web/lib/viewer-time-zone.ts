/**
 * lib/viewer-time-zone.ts — The viewer's IANA time zone, read on the server.
 *
 * The schedule's "today" and its day window (lib/schedule-day.ts) are in the
 * zone the browser books and shows reservation times in. The server cannot see
 * that zone, so the browser reports it in the aeroops-tz cookie
 * (schedule/_components/viewer-time-zone-sync.tsx). Until it has — a first
 * visit, blocked cookies, a zone this server's Intl does not know — the
 * server's own zone stands in (what the schedule used before), and the sync
 * component refreshes the page once the cookie is set.
 *
 * Server-only (next/headers). The pure parts live in lib/schedule-day.ts.
 */
import { cookies } from 'next/headers';
import { VIEWER_TZ_COOKIE, resolveTimeZone } from './schedule-day';

/** getViewerTimeZone — the aeroops-tz cookie's zone, else the server's own (UTC on Vercel). */
export async function getViewerTimeZone(): Promise<string> {
  const store = await cookies();
  const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return resolveTimeZone(store.get(VIEWER_TZ_COOKIE)?.value, serverZone);
}
