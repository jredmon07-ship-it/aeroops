/**
 * help/page.tsx — Help / knowledge-base hub (Slice P1.8, RSC).
 *
 * Route: /o/[slug]/help
 * Capability: app:access — the broadest capability; every one of the 8 roles
 *   has it (see packages/core/src/capabilities.ts). This is a self-serve
 *   support surface: the founder supports every operator solo, and this page
 *   is what lets that scale (docs/ROADMAP.md, P1.8).
 *
 * CONTENT: 100% static, generated from what AeroOps actually ships — see
 *   lib/help-articles.ts's header comment for the content rule. No DB call,
 *   no server action beyond auth() for the shell session.
 *
 * Layout (top → bottom):
 *   A. Heading "Help" + one-line intro (always instant — no Suspense needed,
 *      content is synchronous static data).
 *   B. HelpSearch (client component) — a search box + the full categorized
 *      article index, client-filtered as you type.
 *
 * STATES:
 *   Populated         — the categorized index (this page has no true "empty"
 *                        state — HELP_ARTICLES is always non-empty content;
 *                        an empty SEARCH result is handled inside HelpSearch).
 *   Loading            — not applicable; content is synchronous, no fetch.
 *   Error              — not applicable; no server call can fail here.
 *   Permission-denied  — tasteful "not available" panel; NO redirect (mirrors
 *                        the activity/reports pattern). In practice every
 *                        authenticated role has app:access, so this is
 *                        defense-in-depth for a session that somehow lacks it.
 *
 * BOUNDARY: imports ONLY from '@aeroops/api' (hasCapability) and local data —
 *   never '@aeroops/db'.
 */

import { auth } from '@/auth';
import { hasCapability } from '@aeroops/api';
import { HELP_CATEGORIES, HELP_ARTICLES } from '@/lib/help-articles';
import { HelpSearch } from './_components/help-search';

// ─── Permission-denied panel (mirrors activity/reports design) ───────────────

function PermissionDeniedPanel() {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-6 py-10 text-center space-y-2">
      <p className="text-sm font-medium text-slate-700">
        Help isn&apos;t available for your role.
      </p>
      <p className="text-sm text-slate-500">
        Contact your administrator if you need access.
      </p>
    </div>
  );
}

interface HelpPageProps {
  params: Promise<{ slug: string }>;
}

export default async function HelpPage({ params }: HelpPageProps) {
  const { slug } = await params;
  const session = await auth();

  // UI-only capability check — app:access is universal, so this is
  // defense-in-depth rather than a role split (see doc comment above).
  const canView = session ? hasCapability(session, 'app:access') : false;

  return (
    <div className="space-y-6">
      {/* ── A. Heading — always instant (static content) ─────────────── */}
      <div>
        <h1 className="text-2xl font-bold tracking-tightish text-slate-900">
          Help
        </h1>
        <p className="mt-0.5 text-sm text-slate-500">
          How-to articles for the features you use every day, written from how
          AeroOps actually works.
        </p>
      </div>

      {/* ── B. Search + categorized index, or permission-denied ───────── */}
      {canView ? (
        <HelpSearch
          slug={slug}
          categories={HELP_CATEGORIES}
          articles={HELP_ARTICLES}
        />
      ) : (
        <PermissionDeniedPanel />
      )}
    </div>
  );
}
