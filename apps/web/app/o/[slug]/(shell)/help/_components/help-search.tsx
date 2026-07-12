/**
 * help/_components/help-search.tsx — client-side filter box over the static
 * Help article list (Slice P1.8).
 *
 * PROGRESSIVE ENHANCEMENT: all content is server-rendered by help/page.tsx
 * (every article is in the initial HTML); this component only narrows what's
 * VISIBLE client-side as the operator types. With JS disabled the full,
 * categorized article index still renders (this component itself would not
 * mount, but Next.js still ships the server-rendered markup underneath the
 * "use client" boundary's initial paint) — there is no server round-trip and
 * nothing to fail closed on.
 *
 * STATES:
 *   no query    — every category + every article shown (identical to page load)
 *   has matches — only categories with ≥1 matching article are shown
 *   no matches  — a single "No articles match" empty-state message
 *
 * A11Y:
 *   - <label> associated with the search input (visually present, not sr-only —
 *     this is the primary control on the page).
 *   - aria-live="polite" region announces the result count as you type.
 *   - Each category is its own <section aria-labelledby> with a real <h2>.
 */
'use client';

import * as React from 'react';
import Link from 'next/link';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import {
  searchHelpArticles,
  type HelpArticle,
  type HelpCategory,
} from '@/lib/help-articles';

interface HelpSearchProps {
  slug: string;
  categories: readonly HelpCategory[];
  articles: readonly HelpArticle[];
}

export function HelpSearch({ slug, categories, articles }: HelpSearchProps) {
  const [query, setQuery] = React.useState('');

  const filtered = React.useMemo(
    () => searchHelpArticles(query, articles),
    [query, articles],
  );

  const groups = React.useMemo(
    () =>
      categories
        .map((category) => ({
          category,
          articles: filtered.filter((a) => a.category === category.id),
        }))
        .filter((g) => g.articles.length > 0),
    [categories, filtered],
  );

  const resultCount = filtered.length;
  const hasQuery = query.trim() !== '';

  return (
    <div className="space-y-8">
      {/* ── Search box ─────────────────────────────────────────────────── */}
      <div className="max-w-md">
        <label
          htmlFor="help-search-input"
          className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300"
        >
          Search help articles
        </label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 dark:text-slate-500"
            aria-hidden="true"
          />
          <Input
            id="help-search-input"
            type="search"
            placeholder="e.g. dispatch, invoice, QuickBooks…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
          />
        </div>
        {/* Live-announced result count for screen readers */}
        <p aria-live="polite" className="sr-only">
          {hasQuery
            ? `${resultCount} ${resultCount === 1 ? 'article' : 'articles'} match your search`
            : ''}
        </p>
      </div>

      {/* ── Empty state — search matched nothing ──────────────────────── */}
      {hasQuery && resultCount === 0 && (
        <div className="rounded-md border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800 px-6 py-10 text-center space-y-1">
          <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
            No articles match &ldquo;{query.trim()}&rdquo;.
          </p>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Try a different word, or browse the categories below by clearing the search.
          </p>
        </div>
      )}

      {/* ── Categorized article index ─────────────────────────────────── */}
      {groups.map(({ category, articles: categoryArticles }) => (
        <section key={category.id} aria-labelledby={`help-cat-${category.id}`}>
          <h2
            id={`help-cat-${category.id}`}
            className="text-lg font-semibold tracking-tightish text-slate-900 dark:text-slate-100"
          >
            {category.label}
          </h2>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{category.description}</p>

          <ul className="mt-3 grid gap-3 sm:grid-cols-2" role="list">
            {categoryArticles.map((article) => (
              <li key={article.slug}>
                <Card className="h-full transition-colors hover:border-brand/40">
                  <Link
                    href={`/o/${slug}/help/${article.slug}`}
                    className={[
                      'block h-full rounded-md p-4',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1',
                    ].join(' ')}
                  >
                    <p className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {article.title}
                    </p>
                    <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                      {article.summary}
                    </p>
                  </Link>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
