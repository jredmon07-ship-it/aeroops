/**
 * help/[article]/page.tsx — a single Help article (Slice P1.8, RSC).
 *
 * Route: /o/[slug]/help/[article]
 * Capability: app:access (same as the hub — see help/page.tsx doc comment).
 *
 * CONTENT: 100% static — the article is looked up from lib/help-articles.ts
 *   by slug. No DB call, no server action beyond auth() for the shell session.
 *
 * STATES:
 *   Populated         — the article's title + body blocks, breadcrumb back
 *                        to the hub.
 *   Empty             — unknown/removed slug → a "article not found" panel
 *                        with a link back to Help (this page's equivalent of
 *                        the "empty" state; there is nothing to load).
 *   Loading           — not applicable; content is synchronous, no fetch.
 *   Error             — not applicable; no server call can fail here.
 *   Permission-denied — tasteful "not available" panel; NO redirect.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { auth } from '@/auth';
import { hasCapability } from '@aeroops/api';
import { getArticleBySlug, type HelpBlock } from '@/lib/help-articles';
import { PageHeader } from '@/components/ui/page-header';

// ─── Permission-denied panel (mirrors the hub) ───────────────────────────────

function PermissionDeniedPanel() {
  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-6 py-10 text-center space-y-2">
      <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
        Help isn&apos;t available for your role.
      </p>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Contact your administrator if you need access.
      </p>
    </div>
  );
}

// ─── "Article not found" panel (this page's empty state) ────────────────────

function ArticleNotFoundPanel({ slug }: { slug: string }) {
  return (
    <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-6 py-10 text-center space-y-2">
      <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
        We couldn&apos;t find that help article.
      </p>
      <p className="text-sm text-slate-500 dark:text-slate-400">
        It may have been renamed or removed.
      </p>
      <Link
        href={`/o/${slug}/help`}
        className="inline-block text-sm font-medium text-brand underline underline-offset-2 hover:text-brand-ink"
      >
        Back to Help
      </Link>
    </div>
  );
}

// ─── Body block renderer ─────────────────────────────────────────────────────

function BlockRenderer({ block, index }: { block: HelpBlock; index: number }) {
  if (block.kind === 'p') {
    return (
      <p key={index} className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
        {block.text}
      </p>
    );
  }
  if (block.kind === 'ul') {
    return (
      <ul key={index} className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
        {block.items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    );
  }
  // 'note' — a light callout, not a wall of legal text.
  return (
    <div
      key={index}
      className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-4 py-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300"
    >
      {block.text}
    </div>
  );
}

interface HelpArticlePageProps {
  params: Promise<{ slug: string; article: string }>;
}

export default async function HelpArticlePage({ params }: HelpArticlePageProps) {
  const { slug, article: articleSlug } = await params;
  const session = await auth();
  // A null session here is one the server has ended (the middleware only
  // checks the cookie's signature, and the (shell) layout does not re-run on
  // a sidebar click): send it to sign in, not to the role-denied panel.
  if (!session) {
    redirect(`/o/${slug}/login`);
  }

  const canView = hasCapability(session, 'app:access');

  if (!canView) {
    return (
      <div className="space-y-6">
        <PermissionDeniedPanel />
      </div>
    );
  }

  const article = getArticleBySlug(articleSlug);

  return (
    <div className="max-w-2xl space-y-6">
      {/* ── Breadcrumb back to the hub ──────────────────────────────────── */}
      <Link
        href={`/o/${slug}/help`}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 rounded-sm"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Help
      </Link>

      {!article ? (
        <ArticleNotFoundPanel slug={slug} />
      ) : (
        <article className="space-y-4">
          <PageHeader title={article.title} />
          <div className="space-y-4">
            {article.body.map((block, i) => (
              <BlockRenderer key={i} block={block} index={i} />
            ))}
          </div>
        </article>
      )}
    </div>
  );
}
