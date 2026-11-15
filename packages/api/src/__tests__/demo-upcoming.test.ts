/**
 * demo-upcoming.test.ts — the demo's forward schedule and announcements
 * (demo/seed-upcoming.ts), seeded on a fresh PGlite through seedDemo.
 *
 * seedDemo THROWS if any forward-schedule reservation is refused, so a clean
 * seed already proves the pattern never collides with the baseline seed. It
 * runs on process-local time (the local demo, CI), on the America/Chicago wall
 * clock the hosted demo's daily refresh uses, and on Pacific/Auckland.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestClient, applyMigrationSql } from '@aeroops/db';
import type { PgliteTestClient } from '@aeroops/db';
import type { PGlite } from '@electric-sql/pglite';

import { seedDemo, DEMO_SLUG, DEMO_SLUG_BRAVO } from '../demo/seed.js';
import { UPCOMING_DAYS } from '../demo/seed-upcoming.js';
import { extractRows } from '../db-rows.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../../../db/migrations');
const DAY_MS = 24 * 60 * 60 * 1000;

function readAllMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && !f.endsWith('.down.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
}

async function reservationsBetween(db: PgliteTestClient, slug: string, from: Date, to: Date): Promise<number> {
  const rows = extractRows<{ n: number }>(
    await db.execute(sql`
      select count(*)::int as n
        from reservation r
        join org o on o.id = r.org_id
       where o.slug = ${slug}
         and r.start_at >= ${from.toISOString()}::timestamptz
         and r.start_at <  ${to.toISOString()}::timestamptz
    `),
  );
  return rows[0]?.n ?? 0;
}

async function announcements(db: PgliteTestClient, slug: string) {
  return extractRows<{ subject: string; audience: string; role: string | null; recipient_count: number; in_past: boolean }>(
    await db.execute(sql`
      select m.subject, m.audience, m.role, m.recipient_count, m.created_at < now() as in_past
        from member_message m
        join org o on o.id = m.org_id
       where o.slug = ${slug}
       order by m.created_at
    `),
  );
}

// Auckland: far from the US clocks, where a row pinned to another zone used to
// collide with the forward schedule.
for (const tz of [undefined, 'America/Chicago', 'Pacific/Auckland'] as const) {
  describe(`demo forward schedule + announcements (${tz ?? 'process-local time'})`, () => {
    let db: PgliteTestClient;
    const prevTz = process.env['AEROOPS_DEMO_TZ'];

    beforeAll(async () => {
      if (tz) process.env['AEROOPS_DEMO_TZ'] = tz;
      else delete process.env['AEROOPS_DEMO_TZ'];
      const client = await createTestClient();
      db = client.db;
      await applyMigrationSql({ pglite: client.pglite as PGlite }, readAllMigrations());
      await seedDemo(db); // throws on any refused forward-schedule booking
    }, 180_000);

    afterAll(() => {
      if (prevTz === undefined) delete process.env['AEROOPS_DEMO_TZ'];
      else process.env['AEROOPS_DEMO_TZ'] = prevTz;
    });

    it('books every week of the coming six for both orgs', async () => {
      const now = Date.now();
      // Whole weeks inside the pattern's range (days 7..UPCOMING_DAYS).
      for (let w = 1; (w + 1) * 7 <= UPCOMING_DAYS; w++) {
        const from = new Date(now + w * 7 * DAY_MS);
        const to = new Date(now + (w + 1) * 7 * DAY_MS);
        expect(await reservationsBetween(db, DEMO_SLUG, from, to)).toBeGreaterThanOrEqual(12);
        // Bravo: ten weekly slots, at least one on every day of the week.
        expect(await reservationsBetween(db, DEMO_SLUG_BRAVO, from, to)).toBeGreaterThanOrEqual(9);
      }
    });

    it('stops at the horizon', async () => {
      const beyond = new Date(Date.now() + (UPCOMING_DAYS + 2) * DAY_MS);
      const farOut = new Date(Date.now() + 400 * DAY_MS);
      expect(await reservationsBetween(db, DEMO_SLUG, beyond, farOut)).toBe(0);
      expect(await reservationsBetween(db, DEMO_SLUG_BRAVO, beyond, farOut)).toBe(0);
    });

    it('puts recent announcements on both orgs\' Messages pages', async () => {
      const alpha = await announcements(db, DEMO_SLUG);
      expect(alpha).toHaveLength(4);
      expect(alpha.every((m) => m.in_past)).toBe(true);
      for (const m of alpha) {
        // 5 active Alpha users; 1 student.
        expect(m.recipient_count).toBe(m.audience === 'role' ? 1 : 5);
      }
      expect(alpha.filter((m) => m.audience === 'role').map((m) => m.role)).toEqual(['student']);

      // 15 active Bravo members (17 on the roster, 2 inactive).
      const bravo = await announcements(db, DEMO_SLUG_BRAVO);
      expect(bravo).toHaveLength(6);
      expect(bravo.every((m) => m.in_past && m.audience === 'all_active' && m.recipient_count === 15)).toBe(true);
    });
  });
}
