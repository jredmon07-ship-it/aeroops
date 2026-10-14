/**
 * lib/session-ended.ts — where a server action sends a visitor whose session
 * the server has ended (see lib/action-auth.ts).
 *
 * PURE: no DOM, no Next.js imports, no I/O — unit-testable under vitest's
 * node env. The login page imports SESSION_ENDED_NOTICE to show the banner.
 */

/** ?notice= value the login page answers with "Your session has ended". */
export const SESSION_ENDED_NOTICE = 'session-ended';

/** One URL path segment of unreserved characters: no '/', '%', '?' or '#'. */
const SLUG_SEGMENT_RE = /^[A-Za-z0-9._~-]{1,200}$/;

/**
 * signInPathFromReferer — `/o/<slug>/login?notice=session-ended` for the org
 * page in `referer`, or '/' when there is none.
 *
 * A server action is POSTed by the page that calls it, so the Referer is that
 * page's URL (same-origin: browsers send it in full by default). The slug
 * only picks which org's sign-in page to show — it authorizes nothing — and
 * it must be a plain path segment, so the result is always a path on this
 * site.
 */
export function signInPathFromReferer(referer: string | null | undefined): string {
  if (!referer) return '/';
  let pathname: string;
  try {
    pathname = new URL(referer).pathname;
  } catch {
    return '/';
  }
  const slug = /^\/o\/([^/]+)(?:\/|$)/.exec(pathname)?.[1];
  if (!slug || !SLUG_SEGMENT_RE.test(slug)) return '/';
  return `/o/${slug}/login?notice=${SESSION_ENDED_NOTICE}`;
}
