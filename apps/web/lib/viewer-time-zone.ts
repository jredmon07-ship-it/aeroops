/**
 * lib/viewer-time-zone.ts — The viewer's IANA time zone, read on the server.
 *
 * "Today", day windows (lib/schedule-day.ts) and clock times (lib/zoned-format.ts)
 * are in the zone the browser books and shows reservation times in. The server
 * cannot see that zone, so the browser reports it in the aeroops-tz cookie
 * (app/o/[slug]/(shell)/viewer-time-zone-sync.tsx, mounted once by the shell
 * layout). Until it has — a first visit, blocked cookies, a zone this server's
 * Intl does not know — the server's own zone stands in, and the sync component
 * refreshes the page once the cookie is set.
 *
 * Resolve it once per request (a page, or a server action) and pass it down:
 * every date and time on the page then reads in the same zone.
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
