/**
 * demo-seed-clock.test.ts — the demo seed never records anything after its
 * own clock (demo/seed.ts: seedDemo's `now`, flyAsOf).
 *
 * The hosted demo re-seeds at 03:00 Chicago, hours before the day's first
 * flight, and a local `pnpm demo` seeds whenever it starts. Each case pins the
 * seed clock to one of those moments and checks both demo orgs: no timestamp
 * after it in any table the seed writes (bar the schedule's own future dates),
 * no ticket on a flight that has not started, today's flights checked out and
 * in only as far as the clock has got, meters that only climb, and the counts
 * the demo depends on.
 *
 * Each pinned time is the next one at least an hour away, so the rows the
 * write paths stamp with the real clock (created_at defaults, audit rows) fall
 * before it too, as they do in production, where the two clocks are one.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestClient, applyMigrationSql } from '@aeroops/db';
import type { AnyDb, PgliteTestClient } from '@aeroops/db';
import type { PGlite } from '@electric-sql/pglite';

import { seedDemo, DEMO_SLUG, DEMO_SLUG_BRAVO } from '../demo/seed.js';
import { UPCOMING_DAYS } from '../demo/seed-upcoming.js';
import { atLocal, localDateAt } from '../demo/demo-clock.js';
import { extractRows } from '../db-rows.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, '../../../db/migrations');

function readAllMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && !f.endsWith('.down.sql'))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf-8'));
}

/** Columns that hold the schedule's own future dates, not something that happened. */
const SCHEDULE_COLUMNS = new Set([
  'booking_request.requested_end',
  'booking_request.requested_start',
  'maintenance_item.due_date',
  'member_expiration.expires_on',
  'reservation.end_at',
  'reservation.start_at',
  'reservation_series.until_date',
]);

/** Tables the demo's timeline lives in: the sweep below must reach every one. */
const TIMELINE_TABLES = [
  'audit_log', 'dispatch_service_log', 'dispatch_ticket', 'lesson_record', 'logbook_annotation',
  'member_message', 'membership', 'reservation', 'squawk', 'work_order',
];

interface ClockCase {
  name: string;
  hour: number;
  minute: number;
  /** The process zone (TZ) and AEROOPS_DEMO_TZ the seed runs under. */
  processTz: string;
  demoTz?: string;
  /** Seed inside one transaction, as the reset does (demo/reset.ts). */
  oneTransaction?: boolean;
  /** Today's tickets per org: the tails still out, and how many flights are checked in. */
  alpha: { out: string[]; checkedIn: number };
  bravo: { out: string[]; checkedIn: number };
}

const CASES: ClockCase[] = [
  {
    name: '03:00 Chicago, the nightly reset (TZ=UTC, AEROOPS_DEMO_TZ=America/Chicago)',
    hour: 3,
    minute: 0,
    processTz: 'UTC',
    demoTz: 'America/Chicago',
    oneTransaction: true,
    // Nothing of today has started; only Bravo's overnight trip is out.
    alpha: { out: [], checkedIn: 0 },
    bravo: { out: ['N735BW'], checkedIn: 0 },
  },
  {
    name: '15:00 Chicago, a `pnpm demo` on a Chicago machine (process-local time)',
    hour: 15,
    minute: 0,
    processTz: 'America/Chicago',
    // The morning's flights checked in and one aircraft out in each org.
    alpha: { out: ['N28K'], checkedIn: 2 },
    bravo: { out: ['N735BW'], checkedIn: 3 },
  },
  {
    name: '23:30 Chicago, already tomorrow in UTC (TZ=UTC, AEROOPS_DEMO_TZ=America/Chicago)',
    hour: 23,
    minute: 30,
    processTz: 'UTC',
    demoTz: 'America/Chicago',
    // The day is over: every flight checked in.
    alpha: { out: [], checkedIn: 3 },
    bravo: { out: [], checkedIn: 5 },
  },
];

/** `hour:minute` on the case's wall clock, as Chicago reads it. */
function chicagoTime(d: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}

for (const c of CASES) {
  describe(`demo seed clock — ${c.name}`, () => {
    let db: PgliteTestClient;
    let now: Date;
    let orgIds: Record<string, string>;
    const saved = { TZ: process.env['TZ'], AEROOPS_DEMO_TZ: process.env['AEROOPS_DEMO_TZ'] };
    const iso = () => now.toISOString();

    beforeAll(async () => {
      process.env['TZ'] = c.processTz;
      if (c.demoTz) process.env['AEROOPS_DEMO_TZ'] = c.demoTz;
      else delete process.env['AEROOPS_DEMO_TZ'];
      // The next hour:minute on that wall clock, at least an hour from now.
      for (let day = 0; ; day++) {
        now = atLocal(day, c.hour, c.minute);
        if (now.getTime() >= Date.now() + 60 * 60_000) break;
      }
      const client = await createTestClient();
      db = client.db;
      await applyMigrationSql({ pglite: client.pglite as PGlite }, readAllMigrations());
      if (c.oneTransaction) await db.transaction((tx) => seedDemo(tx as unknown as AnyDb, now));
      else await seedDemo(db, now); // throws on any refused booking, dispatch or record
      const orgs = extractRows<{ slug: string; id: string }>(
        await db.execute(sql`select slug, id from org where slug in (${DEMO_SLUG}, ${DEMO_SLUG_BRAVO})`),
      );
      orgIds = Object.fromEntries(orgs.map((o) => [o.slug, o.id]));
    }, 180_000);

    afterAll(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it('seeds on the wall clock and in the process zone the case names', () => {
      expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(c.processTz);
      expect(chicagoTime(now)).toBe(`${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}`);
    });

    it('dates nothing after the seed clock, in any table the seed writes', async () => {
      const columns = extractRows<{ table_name: string; column_name: string; data_type: string }>(
        await db.execute(sql`
          select c.table_name, c.column_name, c.data_type
            from information_schema.columns c
            join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
           where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
             and c.data_type in ('timestamp with time zone', 'timestamp without time zone', 'date')
             and (c.table_name = 'org' or exists (
                   select 1 from information_schema.columns k
                    where k.table_schema = 'public' and k.table_name = c.table_name and k.column_name = 'org_id'))
           order by c.table_name, c.column_name
        `),
      );
      const demoOrgs = sql.join([orgIds[DEMO_SLUG], orgIds[DEMO_SLUG_BRAVO]].map((id) => sql`${id}::uuid`), sql`, `);
      const today = localDateAt(0, now);
      const written = new Set<string>();
      const late: string[] = [];
      for (const col of columns) {
        const table = sql.raw(`"${col.table_name}"`);
        const column = sql.raw(`x."${col.column_name}"`);
        const scope = col.table_name === 'org' ? sql`x.id in (${demoOrgs})` : sql`x.org_id in (${demoOrgs})`;
        const after = col.data_type === 'date' ? sql`${column} > ${today}::date` : sql`${column} > ${iso()}::timestamptz`;
        const [row] = extractRows<{ n: number; dated: number; latest: string | null }>(
          await db.execute(sql`
            select count(*)::int as n, (count(*) filter (where ${after}))::int as dated,
                   (max(${column}) filter (where ${after}))::text as latest
              from ${table} x where ${scope}
          `),
        );
        if (row!.n > 0) written.add(col.table_name);
        if (row!.dated > 0 && !SCHEDULE_COLUMNS.has(`${col.table_name}.${col.column_name}`)) {
          late.push(`${col.table_name}.${col.column_name}: ${row!.dated} row(s), latest ${row!.latest}`);
        }
      }
      expect(late).toEqual([]);
      expect([...written]).toEqual(expect.arrayContaining(['org', ...TIMELINE_TABLES]));
    });

    it('checks a flight out only once it has started, and in only once it is over', async () => {
      const wrong = extractRows<{ slug: string; notes: string; status: string }>(
        await db.execute(sql`
          select o.slug, r.notes, dt.status
            from dispatch_ticket dt
            join reservation r on r.id = dt.reservation_id and r.org_id = dt.org_id
            join org o on o.id = dt.org_id
           where o.slug in (${DEMO_SLUG}, ${DEMO_SLUG_BRAVO})
             and (r.start_at > ${iso()}::timestamptz
                  or dt.opened_at < r.start_at
                  or (dt.status = 'closed' and r.end_at > ${iso()}::timestamptz)
                  or (dt.status = 'open' and r.end_at <= ${iso()}::timestamptz))
        `),
      );
      expect(wrong).toEqual([]);
    });

    it("shows today's flights as far as the clock has got", async () => {
      for (const slug of [DEMO_SLUG, DEMO_SLUG_BRAVO] as const) {
        const tickets = extractRows<{ tail_number: string; status: string }>(
          await db.execute(sql`
            select res.tail_number, dt.status
              from dispatch_ticket dt
              join reservation r on r.id = dt.reservation_id and r.org_id = dt.org_id
              join resource res on res.id = dt.resource_id and res.org_id = dt.org_id
             where dt.org_id = ${orgIds[slug]}::uuid
               and r.end_at > ${atLocal(0, 0, 0, now).toISOString()}::timestamptz
          `),
        );
        expect({
          out: tickets.filter((t) => t.status === 'open').map((t) => t.tail_number).sort(),
          checkedIn: tickets.filter((t) => t.status === 'closed').length,
        }, slug).toEqual(slug === DEMO_SLUG ? c.alpha : c.bravo);
      }
    });

    it('keeps Hobbs and tach climbing on every aircraft', async () => {
      const backwards = extractRows<{ tail_number: string; opened_at: string }>(
        await db.execute(sql`
          select tail_number, opened_at::text from (
            select res.tail_number, dt.opened_at, dt.hobbs_out, dt.tach_out, dt.hobbs_in, dt.tach_in,
                   lag(dt.hobbs_in) over w as prev_hobbs_in, lag(dt.tach_in) over w as prev_tach_in
              from dispatch_ticket dt
              join resource res on res.id = dt.resource_id and res.org_id = dt.org_id
             where dt.org_id in (${orgIds[DEMO_SLUG]}::uuid, ${orgIds[DEMO_SLUG_BRAVO]}::uuid)
            window w as (partition by dt.resource_id order by dt.opened_at, dt.created_at)
          ) t
           where hobbs_out < prev_hobbs_in or tach_out < prev_tach_in
              or hobbs_in < hobbs_out or tach_in < tach_out
        `),
      );
      expect(backwards).toEqual([]);
    });

    it('keeps the counts the demo depends on', async () => {
      const todayStart = atLocal(0, 0, 0, now).toISOString();
      const counts = async (orgId: string) =>
        extractRows<Record<string, number>>(
          await db.execute(sql`
            select
              (select count(*)::int from app_user where org_id = ${orgId}::uuid) as users,
              (select count(*)::int from app_user where org_id = ${orgId}::uuid and status = 'active') as active,
              (select count(*)::int from resource where org_id = ${orgId}::uuid and kind = 'aircraft') as aircraft,
              (select count(*)::int from dispatch_ticket dt
                 join reservation r on r.id = dt.reservation_id and r.org_id = dt.org_id
                where dt.org_id = ${orgId}::uuid and dt.status = 'closed'
                  and r.end_at <= ${todayStart}::timestamptz) as history,
              (select count(*)::int from reservation where org_id = ${orgId}::uuid and status = 'cancelled') as cancellations,
              (select count(*)::int from member_message where org_id = ${orgId}::uuid) as messages,
              (select count(*)::int from squawk where org_id = ${orgId}::uuid) as squawks,
              (select count(*)::int from work_order where org_id = ${orgId}::uuid) as work_orders,
              (select count(*)::int from maintenance_item where org_id = ${orgId}::uuid) as maintenance_items,
              (select count(*)::int from member_expiration where org_id = ${orgId}::uuid) as expirations,
              (select count(*)::int from dispatch_service_log where org_id = ${orgId}::uuid) as fuel_uplifts,
              (select count(*)::int from logbook_annotation where org_id = ${orgId}::uuid) as logbook_notes,
              (select count(*)::int from booking_request where org_id = ${orgId}::uuid) as booking_requests,
              -- lessons recorded at the check-in of a dual flight that was flown
              (select count(*)::int from lesson_record lr
                where lr.org_id = ${orgId}::uuid and lr.status = 'recorded'
                  and exists (
                    select 1 from reservation r
                      join dispatch_ticket dt on dt.reservation_id = r.id and dt.status = 'closed'
                      join reservation_resource rr on rr.reservation_id = r.id
                      join resource i on i.id = rr.resource_id and i.kind = 'instructor'
                     where r.org_id = lr.org_id and r.end_at = lr.completed_at)) as lessons_on_flights
          `),
        )[0]!;
      expect(await counts(orgIds[DEMO_SLUG]!)).toEqual({
        users: 5, active: 5, aircraft: 4, history: 56, cancellations: 0, messages: 4, squawks: 2,
        work_orders: 1, maintenance_items: 0, expirations: 0, fuel_uplifts: 0, logbook_notes: 0,
        booking_requests: 2, lessons_on_flights: 2,
      });
      expect(await counts(orgIds[DEMO_SLUG_BRAVO]!)).toEqual({
        users: 17, active: 15, aircraft: 2, history: 37, cancellations: 4, messages: 6, squawks: 4,
        work_orders: 2, maintenance_items: 6, expirations: 13, fuel_uplifts: 19, logbook_notes: 11,
        booking_requests: 0, lessons_on_flights: 0,
      });

      // Flying on every day from today to the end of the forward schedule, in both orgs.
      for (const slug of [DEMO_SLUG, DEMO_SLUG_BRAVO] as const) {
        const starts = extractRows<{ start_at: Date | string }>(
          await db.execute(sql`
            select start_at from reservation
             where org_id = ${orgIds[slug]}::uuid and status <> 'cancelled'
               and start_at >= ${todayStart}::timestamptz
          `),
        ).map((r) => new Date(r.start_at).getTime());
        const emptyDays: number[] = [];
        for (let day = 0; day <= UPCOMING_DAYS; day++) {
          const from = atLocal(day, 0, 0, now).getTime();
          const to = atLocal(day + 1, 0, 0, now).getTime();
          if (!starts.some((t) => t >= from && t < to)) emptyDays.push(day);
        }
        expect(emptyDays, slug).toEqual([]);
      }

      // The oil changes come due off each aircraft's last recorded tach, however
      // far today's flights have got: the Skyhawk's soon (inside its 10 h
      // warning), the Warrior's not yet, neither overdue.
      const oilChanges = extractRows<{ tail_number: string; remaining: string }>(
        await db.execute(sql`
          select res.tail_number,
                 (mi.due_value_hours - (select dt.tach_in from dispatch_ticket dt
                                         where dt.resource_id = mi.resource_id and dt.status = 'closed'
                                         order by dt.closed_at desc limit 1))::text as remaining
            from maintenance_item mi
            join resource res on res.id = mi.resource_id and res.org_id = mi.org_id
           where mi.org_id = ${orgIds[DEMO_SLUG_BRAVO]}::uuid and mi.track_by = 'hours'
           order by res.tail_number
        `),
      );
      expect(oilChanges.map((r) => [r.tail_number, Number(r.remaining)])).toEqual([
        ['N2189K', 30],
        ['N735BW', 3.8],
      ]);
    });
  });
}
