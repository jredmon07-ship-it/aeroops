/**
 * help-articles.test.ts — Pure sanity tests for lib/help-articles.ts
 * (Slice P1.8 — Help / knowledge base).
 *
 * These guard the CONTENT DATA's structural integrity (unique slugs, every
 * article's category exists, non-empty content) and the three pure helpers.
 * They intentionally do NOT re-litigate the prose itself — content accuracy
 * against docs/specs/*.md was verified by hand when each article was written.
 *
 * PURE unit tests — no DOM, no Next.js, no DB.
 */
import { describe, it, expect } from 'vitest';
import {
  HELP_CATEGORIES,
  HELP_ARTICLES,
  getArticleBySlug,
  articlesInCategory,
  searchHelpArticles,
} from '../help-articles';

describe('1. HELP_CATEGORIES — registry sanity', () => {
  it('has at least one category', () => {
    expect(HELP_CATEGORIES.length).toBeGreaterThan(0);
  });

  it('every category id is unique', () => {
    const ids = HELP_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every category has a non-empty label and description', () => {
    for (const c of HELP_CATEGORIES) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });
});

describe('2. HELP_ARTICLES — registry sanity', () => {
  it('has at least one article', () => {
    expect(HELP_ARTICLES.length).toBeGreaterThan(0);
  });

  it('every article slug is unique', () => {
    const slugs = HELP_ARTICLES.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('every article slug is URL-safe (lowercase, digits, hyphens only)', () => {
    for (const a of HELP_ARTICLES) {
      expect(a.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('every article references a category that exists in HELP_CATEGORIES', () => {
    const categoryIds = new Set(HELP_CATEGORIES.map((c) => c.id));
    for (const a of HELP_ARTICLES) {
      expect(categoryIds.has(a.category), `article ${a.slug} has unknown category ${a.category}`).toBe(true);
    }
  });

  it('every article has a non-empty title, summary, and at least one body block', () => {
    for (const a of HELP_ARTICLES) {
      expect(a.title.length).toBeGreaterThan(0);
      expect(a.summary.length).toBeGreaterThan(0);
      expect(a.body.length).toBeGreaterThan(0);
    }
  });

  it('every "p" and "note" block has non-empty text; every "ul" block has at least one item', () => {
    for (const a of HELP_ARTICLES) {
      for (const block of a.body) {
        if (block.kind === 'p' || block.kind === 'note') {
          expect(block.text.length).toBeGreaterThan(0);
        } else if (block.kind === 'ul') {
          expect(block.items.length).toBeGreaterThan(0);
          for (const item of block.items) {
            expect(item.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('every category has at least one article', () => {
    for (const c of HELP_CATEGORIES) {
      const articles = HELP_ARTICLES.filter((a) => a.category === c.id);
      expect(articles.length, `category ${c.id} has zero articles`).toBeGreaterThan(0);
    }
  });
});

describe('3. getArticleBySlug', () => {
  it('finds an existing article by slug', () => {
    const first = HELP_ARTICLES[0]!;
    expect(getArticleBySlug(first.slug)?.slug).toBe(first.slug);
  });

  it('returns undefined for an unknown slug', () => {
    expect(getArticleBySlug('this-slug-does-not-exist')).toBeUndefined();
  });

  it('works against a custom articles list (not the default HELP_ARTICLES)', () => {
    const custom = [HELP_ARTICLES[0]!, HELP_ARTICLES[1]!];
    expect(getArticleBySlug(custom[1]!.slug, custom)?.slug).toBe(custom[1]!.slug);
    expect(getArticleBySlug(HELP_ARTICLES[2]?.slug ?? 'zzz', custom)).toBeUndefined();
  });
});

describe('4. articlesInCategory', () => {
  it('returns only articles matching the given category', () => {
    const categoryId = HELP_CATEGORIES[0]!.id;
    const result = articlesInCategory(categoryId);
    expect(result.length).toBeGreaterThan(0);
    for (const a of result) {
      expect(a.category).toBe(categoryId);
    }
  });

  it('every article appears in exactly one category’s result set', () => {
    const counts = new Map<string, number>();
    for (const c of HELP_CATEGORIES) {
      for (const a of articlesInCategory(c.id)) {
        counts.set(a.slug, (counts.get(a.slug) ?? 0) + 1);
      }
    }
    for (const a of HELP_ARTICLES) {
      expect(counts.get(a.slug)).toBe(1);
    }
  });
});

describe('5. searchHelpArticles', () => {
  it('empty query returns every article (no filter applied)', () => {
    expect(searchHelpArticles('').length).toBe(HELP_ARTICLES.length);
  });

  it('whitespace-only query returns every article', () => {
    expect(searchHelpArticles('   ').length).toBe(HELP_ARTICLES.length);
  });

  it('matches case-insensitively against the title', () => {
    const target = HELP_ARTICLES.find((a) => a.title.includes('logbook'));
    expect(target).toBeDefined();
    const result = searchHelpArticles('LOGBOOK');
    expect(result.some((a) => a.slug === target!.slug)).toBe(true);
  });

  it('matches against the summary even when not in the title', () => {
    const result = searchHelpArticles('hobbs');
    expect(result.length).toBeGreaterThan(0);
  });

  it('a query matching nothing returns an empty array', () => {
    expect(searchHelpArticles('xyzzy-no-such-term-anywhere')).toEqual([]);
  });

  it('works against a custom articles list', () => {
    const custom = [HELP_ARTICLES[0]!];
    const result = searchHelpArticles(custom[0]!.title.toLowerCase(), custom);
    expect(result).toEqual(custom);
  });
});
