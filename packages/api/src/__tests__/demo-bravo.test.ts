/**
 * demo-bravo.test.ts — the Bravo Flying Club demo org (demo/seed.ts,
 * seedBravoClub), seeded on a fresh PGlite through seedDemo.
 *
 * seedDemo THROWS on any refused booking, dispatch or record, so a clean seed
 * already proves the club's history, today's flights and the forward schedule
 * pass every gate. These tests pin what a visitor sees: a real roster, both
 * aircraft flown with meters that only climb, flying every day of the next
 * six weeks, maintenance coming due but nothing overdue, and nothing written
 * to the leftover money tables or the e-mail log. They run on process-local
 * time, on the hosted demo's America/Chicago wall clock, and on
 * Pacific/Auckland, like demo-upcoming.test.ts.
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
import { atLocal } from '../demo/demo-clock.js';
import { listMaintenanceDueWithDb } from '../maintenance/list-maintenance-due.js';
import type { AppSession } from '../auth/types.js';
import { extractRows } from '../db-rows.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../../../db/migrations');

function readAllMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && !f.endsWith('.down.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
}

/**
 * The leftover billing tables (out of scope: AeroOps has no billing). A fresh
 * database holds only the two demo orgs, so any row in them is the seed's.
 */
const MONEY_TABLES = [
  'autopay_setting', 'balance_payment', 'billing_account', 'block_package', 'block_purchase',
  'dues_run', 'dues_schedule', 'invoice', 'invoice_line_item', 'ledger_entry',
  'payment_intent_record', 'product_catalog', 'qbo_account_mapping', 'qbo_connection',
  'qbo_export_log', 'rate_schedule', 'stripe_customer', 'stripe_event', 'stripe_payment_method',
];

type TicketRow = {
  tail_number: string;
  status: string;
  hobbs_out: string;
  tach_out: string;
  hobbs_in: string | null;
  tach_in: string | null;
  closed_at: Date | string | null;
};

for (const tz of [undefined, 'America/Chicago', 'Pacific/Auckland'] as const) {
  describe(`Bravo Flying Club demo org (${tz ?? 'process-local time'})`, () => {
    let db: PgliteTestClient;
    let bravoId: string;
    // The seed's "today": day offsets below are read against it, so a run that
    // crosses midnight still checks the days the seed booked.
    let seededAt: Date;
    const dayStart = (day: number) => atLocal(day, 0, 0, seededAt);
    const prevTz = process.env['AEROOPS_DEMO_TZ'];

    beforeAll(async () => {
      if (tz) process.env['AEROOPS_DEMO_TZ'] = tz;
      else delete process.env['AEROOPS_DEMO_TZ'];
      const client = await createTestClient();
      db = client.db;
      await applyMigrationSql({ pglite: client.pglite as PGlite }, readAllMigrations());
      seededAt = new Date();
      await seedDemo(db); // throws on any refused booking, dispatch or record
      bravoId = extractRows<{ id: string }>(
        await db.execute(sql`select id from org where slug = ${DEMO_SLUG_BRAVO}`),
      )[0]!.id;
    }, 180_000);

    afterAll(() => {
      if (prevTz === undefined) delete process.env['AEROOPS_DEMO_TZ'];
      else process.env['AEROOPS_DEMO_TZ'] = prevTz;
    });

    it('lists the club on People: 15 active and 2 inactive members, tagged, joined over the years', async () => {
      const byStatus = extractRows<{ status: string; n: number }>(
        await db.execute(sql`
          select u.status, count(*)::int as n
            from app_user u
            join membership m on m.user_id = u.id and m.org_id = u.org_id
           where u.org_id = ${bravoId}::uuid
           group by u.status order by u.status
        `),
      );
      expect(byStatus).toEqual([
        { status: 'active', n: 15 },
        { status: 'inactive', n: 2 },
      ]);

      const untagged = extractRows<{ n: number }>(
        await db.execute(sql`
          select count(*)::int as n from app_user u
           where u.org_id = ${bravoId}::uuid
             and not exists (select 1 from member_tag t where t.user_id = u.id and t.org_id = u.org_id)
        `),
      );
      expect(untagged[0]?.n).toBe(0);

      const joined = extractRows<{ days: number; earliest: number; latest_before_today: boolean }>(
        await db.execute(sql`
          select count(distinct (created_at at time zone 'UTC')::date)::int as days,
                 min(extract(year from created_at))::int as earliest,
                 bool_and(created_at < ${dayStart(0).toISOString()}::timestamptz) as latest_before_today
            from membership where org_id = ${bravoId}::uuid
        `),
      )[0]!;
      expect(joined.days).toBeGreaterThanOrEqual(15);
      expect(joined.earliest).toBe(2009);
      expect(joined.latest_before_today).toBe(true);
    });

    it('flies both aircraft: each tail has a closed history before today, by several pilots', async () => {
      const rows = extractRows<{ tail_number: string; flights: number; pilots: number }>(
        await db.execute(sql`
          select r.tail_number, count(*)::int as flights, count(distinct dt.pilot_user_id)::int as pilots
            from dispatch_ticket dt
            join resource r on r.id = dt.resource_id and r.org_id = dt.org_id
           where dt.org_id = ${bravoId}::uuid
             and dt.status = 'closed'
             and dt.closed_at < ${dayStart(0).toISOString()}::timestamptz
           group by r.tail_number order by r.tail_number
        `),
      );
      expect(rows.map((r) => r.tail_number)).toEqual(['N2189K', 'N735BW']);
      for (const r of rows) {
        expect(r.flights, r.tail_number).toBeGreaterThanOrEqual(15);
        expect(r.pilots, r.tail_number).toBeGreaterThanOrEqual(5);
      }
    });

    it('keeps Hobbs and tach climbing on each tail, so the newest reading is the highest', async () => {
      const tickets = extractRows<TicketRow>(
        await db.execute(sql`
          select r.tail_number, dt.status, dt.hobbs_out, dt.tach_out, dt.hobbs_in, dt.tach_in, dt.closed_at
            from dispatch_ticket dt
            join resource r on r.id = dt.resource_id and r.org_id = dt.org_id
           where dt.org_id = ${bravoId}::uuid
           order by r.tail_number, dt.opened_at, dt.created_at
        `),
      );
      for (const tail of ['N735BW', 'N2189K']) {
        const mine = tickets.filter((t) => t.tail_number === tail);
        expect(mine.length, tail).toBeGreaterThan(0);
        let prev: TicketRow | undefined;
        for (const t of mine) {
          if (t.hobbs_in !== null) expect(Number(t.hobbs_in)).toBeGreaterThanOrEqual(Number(t.hobbs_out));
          if (t.tach_in !== null) expect(Number(t.tach_in)).toBeGreaterThanOrEqual(Number(t.tach_out));
          if (prev?.hobbs_in != null && prev.tach_in != null) {
            expect(Number(t.hobbs_out), `${tail} Hobbs`).toBeGreaterThanOrEqual(Number(prev.hobbs_in));
            expect(Number(t.tach_out), `${tail} tach`).toBeGreaterThanOrEqual(Number(prev.tach_in));
          }
          prev = t;
        }
        // Fleet → last recorded meters reads the latest closed ticket (by closed_at).
        const closed = mine.filter((t) => t.status === 'closed');
        const latest = [...closed].sort(
          (a, b) => new Date(b.closed_at!).getTime() - new Date(a.closed_at!).getTime(),
        )[0]!;
        expect(Number(latest.hobbs_in)).toBe(Math.max(...closed.map((t) => Number(t.hobbs_in))));
        expect(Number(latest.tach_in)).toBe(Math.max(...closed.map((t) => Number(t.tach_in))));
      }
    });

    it('has flying booked on every day from today to the end of the forward schedule', async () => {
      const starts = extractRows<{ start_at: Date | string }>(
        await db.execute(sql`
          select start_at from reservation
           where org_id = ${bravoId}::uuid and status <> 'cancelled'
             and start_at >= ${dayStart(0).toISOString()}::timestamptz
             and start_at < ${dayStart(UPCOMING_DAYS + 1).toISOString()}::timestamptz
        `),
      ).map((r) => new Date(r.start_at).getTime());
      const emptyDays: number[] = [];
      for (let day = 0; day <= UPCOMING_DAYS; day++) {
        const from = dayStart(day).getTime();
        const to = dayStart(day + 1).getTime();
        if (!starts.some((t) => t >= from && t < to)) emptyDays.push(day);
      }
      expect(emptyDays).toEqual([]);
    });

    it('dates every booking before it starts, with no seed-day spike on the activity chart', async () => {
      const rows = extractRows<{ after_start: number; just_now: number }>(
        await db.execute(sql`
          select count(*) filter (where created_at >= start_at)::int as after_start,
                 count(*) filter (where created_at > now() - interval '1 hour')::int as just_now
            from reservation where org_id = ${bravoId}::uuid
        `),
      );
      expect(rows[0]).toEqual({ after_start: 0, just_now: 0 });
    });

    it('never dispatches a pilot after one of their own reminder dates has lapsed', async () => {
      // Expirations are warn-only operator reminders, but the seeded history must
      // not show a member flying past one (Marcus's lapsed flight review is
      // flown with the CFI tomorrow; his last solo was two weeks ago).
      const lapsed = extractRows<{ full_name: string; label: string }>(
        await db.execute(sql`
          select u.full_name, e.label
            from dispatch_ticket dt
            join member_expiration e on e.member_user_id = dt.pilot_user_id and e.org_id = dt.org_id
            join app_user u on u.id = dt.pilot_user_id
           where dt.org_id = ${bravoId}::uuid
             and e.expires_on < (dt.opened_at at time zone 'UTC')::date
        `),
      );
      expect(lapsed).toEqual([]);
    });

    it('shows maintenance coming due on both aircraft, none of it overdue', async () => {
      const owner = extractRows<{ id: string }>(
        await db.execute(sql`select id from app_user where org_id = ${bravoId}::uuid and email = 'owner@bravo.aero'`),
      )[0]!;
      const session: AppSession = {
        user: { email: 'owner@bravo.aero' },
        userId: owner.id,
        orgId: bravoId,
        slug: DEMO_SLUG_BRAVO,
        role: 'owner',
      };
      const aircraft = extractRows<{ id: string }>(
        await db.execute(sql`select id from resource where org_id = ${bravoId}::uuid and kind = 'aircraft'`),
      );
      const statuses: string[] = [];
      for (const a of aircraft) {
        const items = await listMaintenanceDueWithDb(db, session, { resourceId: a.id });
        expect(items.length).toBeGreaterThan(0);
        statuses.push(...items.map((i) => i.status));
      }
      expect(statuses).not.toContain('overdue');
      expect(statuses).not.toContain('unknown');
      expect(statuses).toContain('due_soon');
    });

    it('writes nothing to the money tables and sends no notifications, for either demo org', async () => {
      for (const table of MONEY_TABLES) {
        const rows = extractRows<{ n: number }>(
          await db.execute(sql.raw(`select count(*)::int as n from "${table}"`)),
        );
        expect(rows[0]?.n, table).toBe(0);
      }
      const sent = extractRows<{ n: number }>(
        await db.execute(sql`
          select count(*)::int as n from notification_log l join org o on o.id = l.org_id
           where o.slug in (${DEMO_SLUG}, ${DEMO_SLUG_BRAVO})
        `),
      );
      expect(sent[0]?.n).toBe(0);
    });
  });
}
