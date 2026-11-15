/**
 * activity-paths.test.ts — the Activity feed's links and labels stay in step
 * with the rest of the repo. No database.
 *
 * ROUTES: every path activityPath (core) can return must be a real page in
 *   apps/web, under app/o/[slug] (the feed prefixes /o/{slug}). The test walks
 *   that directory for page files, so a renamed or removed route fails here
 *   instead of shipping as a 404 (it once linked to /board, which never existed).
 *
 * LABELS: every entity type the API writes audit rows with must have its own
 *   label in core's activityEntityLabel, so the feed never falls back to the
 *   generic "record" for a live feature. The test scans packages/api/src for
 *   `entityType: '…'` in audit writes.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { activityPath, activityEntityLabel, ACTIVITY_ENTITY_TYPES } from '@aeroops/core';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const API_SRC_DIR = join(__dirname, '..');
const ORG_APP_DIR = join(__dirname, '..', '..', '..', '..', 'apps', 'web', 'app', 'o', '[slug]');

// ─── Route tree ───────────────────────────────────────────────────────────────

const PAGE_FILE_RE = /^page\.(tsx|ts|jsx|js|mdx)$/;

/** Every directory under `dir` (inclusive) that holds a Next.js page file. */
function pageDirs(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const here = entries.some((e) => e.isFile() && PAGE_FILE_RE.test(e.name)) ? [dir] : [];
  const below = entries
    .filter((e) => e.isDirectory() && e.name !== 'node_modules')
    .flatMap((e) => pageDirs(join(dir, e.name)));
  return [...here, ...below];
}

/**
 * The URL segments of each page under app/o/[slug]: route groups like
 * "(shell)" are dropped (they are not part of the URL); "[param]" segments
 * stay as written and match any one path segment.
 */
const ROUTES: string[][] = pageDirs(ORG_APP_DIR).map((dir) =>
  relative(ORG_APP_DIR, dir)
    .split(sep)
    .filter((segment) => segment !== '' && !/^\(.*\)$/.test(segment)),
);

function segmentMatches(routeSegment: string, pathSegment: string): boolean {
  if (/^\[[^.\]]+\]$/.test(routeSegment)) return pathSegment.length > 0;
  return routeSegment === pathSegment;
}

/** True when the slug-less `path` (query string allowed) is a page in apps/web. */
function isWebRoute(path: string): boolean {
  const segments = path.split(/[?#]/)[0]!.split('/').filter(Boolean);
  return ROUTES.some(
    (route) =>
      route.length === segments.length &&
      route.every((routeSegment, i) => segmentMatches(routeSegment, segments[i]!)),
  );
}

// ─── Audit entity types written by the API ────────────────────────────────────

/** Every .ts file under `dir`, skipping test folders and test files. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(full);
    return e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [full] : [];
  });
}

function auditedEntityTypes(): Set<string> {
  const types = new Set<string>();
  for (const file of sourceFiles(API_SRC_DIR)) {
    for (const match of readFileSync(file, 'utf8').matchAll(/entityType:\s*'([a-z_]+)'/g)) {
      types.add(match[1]!);
    }
  }
  return types;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('activity links resolve to web routes', () => {
  it('finds the web app routes (sanity)', () => {
    expect(ROUTES.length).toBeGreaterThan(20);
    expect(isWebRoute('/schedule/board')).toBe(true);
    expect(isWebRoute('/fleet/0b0c5c6e-0000-4000-8000-000000000001')).toBe(true);
    // The old target, which 404s: the matcher must be able to say no.
    expect(isWebRoute('/board')).toBe(false);
    expect(isWebRoute('/maintenance')).toBe(false);
  });

  it('every path activityPath can return is a page under /o/[slug]', () => {
    const ids = ['0b0c5c6e-0000-4000-8000-000000000001', null];
    const metadatas = [
      {},
      { resourceId: '0b0c5c6e-0000-4000-8000-000000000002', courseId: '0b0c5c6e-0000-4000-8000-000000000003' },
      // reservation.created / reservation.rescheduled carry the start: the
      // link opens the board on that day (?date=…).
      { startAt: '2026-11-17T01:00:00.000Z' },
      { newWindow: { startAt: '2026-11-20T04:30:00.000Z', endAt: '2026-11-20T05:30:00.000Z' } },
    ];
    const paths = new Set<string>();
    for (const entityType of [...ACTIVITY_ENTITY_TYPES, 'unlabelled_entity']) {
      for (const entityId of ids) {
        for (const metadata of metadatas) {
          for (const timeZone of [undefined, 'America/Chicago']) {
            const path = activityPath({ entityType, entityId, metadata, timeZone });
            if (path !== null) paths.add(path);
          }
        }
      }
    }
    expect(paths).toContain('/schedule/board?date=2026-11-16');

    expect(paths.size).toBeGreaterThan(5);
    const broken = [...paths].filter((path) => !isWebRoute(path));
    expect(broken).toEqual([]);
  });
});

describe('audited entity types have labels', () => {
  it('every entityType the API writes to audit_log has its own label', () => {
    const types = auditedEntityTypes();
    // Sanity: the scan found the audit writes (dozens of files use this form).
    expect(types.size).toBeGreaterThan(20);
    const unlabelled = [...types].filter((type) => !ACTIVITY_ENTITY_TYPES.includes(type));
    expect(unlabelled).toEqual([]);
    for (const type of types) {
      expect(activityEntityLabel(type)).not.toBe('record');
    }
  });
});
