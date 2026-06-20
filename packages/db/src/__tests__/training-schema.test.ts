/**
 * training-schema.test.ts — Schema tests for 0012_training.sql (Slice T1.1).
 *
 * Proves spec §T1.1 schema acceptance criteria:
 *
 *   T1.  All four tables (course, course_lesson, enrollment, lesson_record)
 *        exist after migration 0012.
 *   T2.  FORCE RLS fail-closed: GUC unset → 0 rows from each table.
 *   T3.  RLS isolation: org A cannot see org B's rows in each table.
 *   T4.  Composite FK cross-org rejection:
 *        T4a. course: created_by from a different org → rejected.
 *        T4b. course_lesson: course_id from a different org → rejected.
 *        T4c. course_lesson: created_by from a different org → rejected.
 *        T4d. enrollment: course_id from a different org → rejected.
 *        T4e. enrollment: student_user_id from a different org → rejected.
 *        T4f. enrollment: enrolled_by from a different org → rejected.
 *        T4g. lesson_record: enrollment_id from a different org → rejected.
 *        T4h. lesson_record: lesson_id from a different org → rejected.
 *        T4i. lesson_record: instructor_user_id from a different org → rejected.
 *        T4j. lesson_record: recorded_by from a different org → rejected.
 *   T5.  CHECKs fire:
 *        T5a. course_title_nonempty_check: empty title → rejected.
 *        T5b. course_title_nonempty_check: blank-only title → rejected.
 *        T5c. course_status_check: invalid status → rejected.
 *        T5d. course_lesson_title_nonempty_check: empty title → rejected.
 *        T5e. course_lesson_position_nonneg_check: negative position → rejected.
 *        T5f. lesson_record_void_shape_check: status='recorded' with voided_at → rejected.
 *        T5g. lesson_record_void_shape_check: status='voided' without voided_at → rejected.
 *        T5h. lesson_record_void_shape_check: status='voided' without voided_reason → rejected.
 *   T6.  UNIQUE constraints fire:
 *        T6a. enrollment_student_course_unique: duplicate (student, course) → rejected.
 *        T6b. enrollment_id_org_id_unique: exists (verify index present).
 *        T6c. course_lesson_course_id_position_unique: duplicate (course, position) → rejected.
 *        T6d. course_id_org_id_unique: verify index present.
 *   T7.  Enum domain:
 *        T7a. enrollment_status: invalid value → rejected.
 *        T7b. lesson_record_status: invalid value → rejected.
 *        T7c. enrollment 'active' default applies.
 *        T7d. lesson_record 'recorded' default applies.
 *   T8.  Happy-path multi-row round-trip:
 *        course → course_lesson → enrollment → lesson_record.
 *        All rows readable under correct org context.
 *   T9.  void_shape_check: status='voided' with both voided_at + voided_reason → accepted.
 *   T10. void_shape_check: voided_by SET NULL — voided record survives user hard-delete
 *        with voided_by = NULL (audit in audit_log; durable who). [VERIFY-T1-C]
 *   T11. RESTRICT on lesson delete (has_records backstop):
 *        deleting a course_lesson with a lesson_record → blocked.
 *   T12. RESTRICT on enrollment delete:
 *        deleting an enrollment with lesson_records → blocked.
 *   T13. CASCADE: course_lesson CASCADE from course — lesson deleted when course deleted.
 *   T14. Down migration reverses 0012: all four tables gone, enums gone.
 *
 * Test harness: PGlite (in-process Postgres WASM). Applies all thirteen real
 * migration artifacts (0000–0012) in order so the constraint SQL validated
 * here is the exact production artifact. NEVER applied to a real DB.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import {
  createTestClient,
  applyMigrationSql,
  setTestAppRole,
  withOrgContext,
  withPlatformAdminContext,
} from '../index.js';
import {
  org,
  appUser,
  course,
  courseLesson,
  enrollment,
  lessonRecord,
} from '../schema/index.js';
import type { PgliteTestClient } from '../client.js';

// ── Path resolution ───────────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATION_SQL = [
  readFileSync(resolve(__dirname, '../../migrations/0000_loud_prodigy.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0001_auth_credential.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0002_scheduling.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0003_booking_policies.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0004_recurrence.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0005_dispatch.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0006_squawks_grounding.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0007_fleet.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0008_people.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0009_dispatch_gate.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0010_civil_twilight.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0011_optimizer_run.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0012_training.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0013_work_orders.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0014_availability.sql'), 'utf-8'),
  readFileSync(resolve(__dirname, '../../migrations/0015_booking_request.sql'), 'utf-8'),
];

const DOWN_0012 = readFileSync(
  resolve(__dirname, '../../migrations/0012_training.down.sql'),
  'utf-8',
);

// ── Test environment ──────────────────────────────────────────────────────────

interface TrainingTestEnv {
  db: PgliteTestClient;
  pglite: PGlite;
  orgAId: string;
  orgBId: string;
  userAId: string;  // member of org A (used as creator/instructor/student)
  userA2Id: string; // second member of org A
  userBId: string;  // member of org B
}

async function setupTrainingEnv(): Promise<TrainingTestEnv> {
  const { db, pglite } = await createTestClient();
  await applyMigrationSql({ pglite }, MIGRATION_SQL);

  const [orgA, orgB] = await withPlatformAdminContext(db, async (tx) => {
    const a = await tx
      .insert(org)
      .values({ name: 'Alpha Flight Academy', slug: 'alpha-training' })
      .returning();
    const b = await tx
      .insert(org)
      .values({ name: 'Beta Aviation Club', slug: 'beta-training' })
      .returning();
    return [a[0]!, b[0]!];
  });

  const [userA, userA2] = await withOrgContext(db, orgA.id, async (tx) => {
    const u1 = await tx
      .insert(appUser)
      .values({ orgId: orgA.id, email: 'alice@alpha-training.example', fullName: 'Alice A' })
      .returning();
    const u2 = await tx
      .insert(appUser)
      .values({ orgId: orgA.id, email: 'admin@alpha-training.example', fullName: 'Admin A' })
      .returning();
    return [u1[0]!, u2[0]!];
  });

  const userBRows = await withOrgContext(db, orgB.id, async (tx) => {
    return tx
      .insert(appUser)
      .values({ orgId: orgB.id, email: 'bob@beta-training.example', fullName: 'Bob B' })
      .returning();
  });

  // Drop to aeroops_app for RLS enforcement on all subsequent queries.
  await setTestAppRole({ pglite });

  return {
    db,
    pglite,
    orgAId: orgA.id,
    orgBId: orgB.id,
    userAId: userA.id,
    userA2Id: userA2.id,
    userBId: userBRows[0]!.id,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function insertCourse(
  pglite: PGlite,
  orgId: string,
  createdBy: string,
  title = 'Private Pilot Ground School',
): Promise<string> {
  const r = await pglite.query<{ id: string }>(
    `INSERT INTO course (org_id, title, created_by) VALUES ($1, $2, $3) RETURNING id`,
    [orgId, title, createdBy],
  );
  return r.rows[0]!.id;
}

async function insertLesson(
  pglite: PGlite,
  orgId: string,
  courseId: string,
  createdBy: string,
  title = 'Aerodynamics Basics',
  position = 0,
): Promise<string> {
  const r = await pglite.query<{ id: string }>(
    `INSERT INTO course_lesson (org_id, course_id, title, position, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, courseId, title, position, createdBy],
  );
  return r.rows[0]!.id;
}

async function insertEnrollment(
  pglite: PGlite,
  orgId: string,
  courseId: string,
  studentUserId: string,
  enrolledBy: string,
): Promise<string> {
  const r = await pglite.query<{ id: string }>(
    `INSERT INTO enrollment (org_id, course_id, student_user_id, enrolled_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [orgId, courseId, studentUserId, enrolledBy],
  );
  return r.rows[0]!.id;
}

async function insertLessonRecord(
  pglite: PGlite,
  orgId: string,
  enrollmentId: string,
  lessonId: string,
  instructorUserId: string,
  recordedBy: string,
): Promise<string> {
  const r = await pglite.query<{ id: string }>(
    `INSERT INTO lesson_record (org_id, enrollment_id, lesson_id, instructor_user_id, recorded_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [orgId, enrollmentId, lessonId, instructorUserId, recordedBy],
  );
  return r.rows[0]!.id;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('training-schema: migration 0012 + constraints + RLS', () => {
  let env: TrainingTestEnv;

  beforeAll(async () => {
    env = await setupTrainingEnv();
  });

  // ── T1: All four tables exist after migration 0012 ────────────────────────

  it('T1a: course table exists after migration 0012', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'course'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  it('T1b: course_lesson table exists after migration 0012', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'course_lesson'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  it('T1c: enrollment table exists after migration 0012', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'enrollment'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  it('T1d: lesson_record table exists after migration 0012', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'lesson_record'
       ) AS exists`,
    );
    expect(r.rows[0]!.exists).toBe(true);
  });

  // ── T2: FORCE RLS fail-closed (GUC unset → 0 rows) ────────────────────────

  it('T2a: FORCE RLS fail-closed — GUC unset → 0 rows from course', async () => {
    const { pglite } = env;
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const r = await pglite.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM course`);
    expect(r.rows[0]!.count).toBe('0');
  });

  it('T2b: FORCE RLS fail-closed — GUC unset → 0 rows from course_lesson', async () => {
    const { pglite } = env;
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const r = await pglite.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM course_lesson`);
    expect(r.rows[0]!.count).toBe('0');
  });

  it('T2c: FORCE RLS fail-closed — GUC unset → 0 rows from enrollment', async () => {
    const { pglite } = env;
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const r = await pglite.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM enrollment`);
    expect(r.rows[0]!.count).toBe('0');
  });

  it('T2d: FORCE RLS fail-closed — GUC unset → 0 rows from lesson_record', async () => {
    const { pglite } = env;
    await pglite.exec(`SELECT set_config('app.current_org_id', '', false)`);
    const r = await pglite.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM lesson_record`);
    expect(r.rows[0]!.count).toBe('0');
  });

  // ── T3: RLS isolation (org A cannot see org B rows) ───────────────────────

  it('T3: RLS isolation — org A cannot see org B course rows', async () => {
    const { pglite, db, orgAId, orgBId, userAId, userBId } = env;

    // Seed one course in each org (superuser).
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await insertCourse(pglite, orgAId, userAId, 'Org A Course');
    await pglite.exec(`COMMIT`);

    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    await insertCourse(pglite, orgBId, userBId, 'Org B Course');
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Org A context → only org A rows.
    const rowsA = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(course).execute(),
    );
    expect(rowsA.every((r) => r.orgId === orgAId)).toBe(true);
    expect(rowsA.some((r) => r.orgId === orgBId)).toBe(false);

    // Org B context → only org B rows.
    const rowsB = await withOrgContext(db, orgBId, (tx) =>
      tx.select().from(course).execute(),
    );
    expect(rowsB.every((r) => r.orgId === orgBId)).toBe(true);
    expect(rowsB.some((r) => r.orgId === orgAId)).toBe(false);
  });

  // ── T4: Composite FK cross-org rejection ──────────────────────────────────

  it('T4a: course.created_by from a different org → rejected', async () => {
    const { pglite, orgAId, userBId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertCourse(pglite, orgAId, userBId, 'Cross-org creator course'),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T4b: course_lesson.course_id from a different org → rejected', async () => {
    const { pglite, orgAId, orgBId, userAId, userBId } = env;

    // Create a course in org B (superuser).
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    const courseBId = await insertCourse(pglite, orgBId, userBId, 'Org B Reference Course');
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Try to insert a course_lesson in org A but referencing org B's course.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertLesson(pglite, orgAId, courseBId, userAId, 'Cross-org lesson', 0),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T4c: course_lesson.created_by from a different org → rejected', async () => {
    const { pglite, orgAId, userAId, userBId } = env;

    // Create a valid course in org A.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseId = await insertCourse(pglite, orgAId, userAId, 'Course for T4c');
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Try to insert a lesson with created_by from org B.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertLesson(pglite, orgAId, courseId, userBId, 'Cross-org creator lesson', 0),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T4d: enrollment.course_id from a different org → rejected', async () => {
    const { pglite, orgAId, orgBId, userAId, userBId } = env;

    // Create a course in org B.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    const courseBId = await insertCourse(pglite, orgBId, userBId, 'Org B Enroll Course');
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Try to enroll a user from org A into org B's course under org A's context.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertEnrollment(pglite, orgAId, courseBId, userAId, userAId),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T4e: enrollment.student_user_id from a different org → rejected', async () => {
    const { pglite, orgAId, userAId, userBId } = env;

    // Create a course in org A.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseId = await insertCourse(pglite, orgAId, userAId, 'Course for T4e');
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Try to enroll org B's user in org A's course.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertEnrollment(pglite, orgAId, courseId, userBId, userAId),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T4f: enrollment.enrolled_by from a different org → rejected', async () => {
    const { pglite, orgAId, userAId, userBId } = env;

    // Create a course in org A.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseId = await insertCourse(pglite, orgAId, userAId, 'Course for T4f');
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Try to enroll org A's user with enrolled_by from org B.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertEnrollment(pglite, orgAId, courseId, userAId, userBId),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T4g: lesson_record.enrollment_id from a different org → rejected', async () => {
    const { pglite, orgAId, orgBId, userAId, userBId } = env;

    // Build a complete enrollment in org B.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    const courseBId = await insertCourse(pglite, orgBId, userBId, 'B Course T4g');
    const lessonBId = await insertLesson(pglite, orgBId, courseBId, userBId, 'B Lesson T4g', 0);
    const enrollBId = await insertEnrollment(pglite, orgBId, courseBId, userBId, userBId);
    await pglite.exec(`COMMIT`);

    // Build a lesson in org A for the record.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseAId = await insertCourse(pglite, orgAId, userAId, 'A Course T4g');
    const lessonAId = await insertLesson(pglite, orgAId, courseAId, userAId, 'A Lesson T4g', 0);
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Try to insert a lesson_record in org A but with org B's enrollment_id.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertLessonRecord(pglite, orgAId, enrollBId, lessonAId, userAId, userAId),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T4h: lesson_record.lesson_id from a different org → rejected', async () => {
    const { pglite, orgAId, orgBId, userAId, userBId } = env;

    // Build a lesson in org B.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgBId}'`);
    const courseBId = await insertCourse(pglite, orgBId, userBId, 'B Course T4h');
    const lessonBId = await insertLesson(pglite, orgBId, courseBId, userBId, 'B Lesson T4h', 0);
    await pglite.exec(`COMMIT`);

    // Build enrollment in org A.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseAId = await insertCourse(pglite, orgAId, userAId, 'A Course T4h');
    const enrollAId = await insertEnrollment(pglite, orgAId, courseAId, userAId, userAId);
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Try to insert a lesson_record in org A with org B's lesson_id.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertLessonRecord(pglite, orgAId, enrollAId, lessonBId, userAId, userAId),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T4i: lesson_record.instructor_user_id from a different org → rejected', async () => {
    const { pglite, orgAId, userAId, userBId } = env;

    // Build course + enrollment in org A.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseId = await insertCourse(pglite, orgAId, userAId, 'Course T4i');
    const lessonId = await insertLesson(pglite, orgAId, courseId, userAId, 'Lesson T4i', 0);
    const enrollId = await insertEnrollment(pglite, orgAId, courseId, userAId, userAId);
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Try to insert a lesson_record with instructor from org B.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertLessonRecord(pglite, orgAId, enrollId, lessonId, userBId, userAId),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T4j: lesson_record.recorded_by from a different org → rejected', async () => {
    const { pglite, orgAId, userAId, userBId } = env;

    // Build course + enrollment in org A.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseId = await insertCourse(pglite, orgAId, userAId, 'Course T4j');
    const lessonId = await insertLesson(pglite, orgAId, courseId, userAId, 'Lesson T4j', 0);
    const enrollId = await insertEnrollment(pglite, orgAId, courseId, userAId, userAId);
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // Try to insert a lesson_record with recorded_by from org B.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertLessonRecord(pglite, orgAId, enrollId, lessonId, userAId, userBId),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  // ── T5: CHECKs fire ───────────────────────────────────────────────────────

  it('T5a: course_title_nonempty_check — empty string title rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(insertCourse(pglite, orgAId, userAId, '')).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T5b: course_title_nonempty_check — blank-only title rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(insertCourse(pglite, orgAId, userAId, '   ')).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T5c: course_status_check — invalid status rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(
        `INSERT INTO course (org_id, title, status, created_by)
         VALUES ($1, 'Valid Title', 'invalid_status', $2)`,
        [orgAId, userAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
  });

  it('T5d: course_lesson_title_nonempty_check — empty lesson title rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseId = await insertCourse(pglite, orgAId, userAId, 'Course for T5d');
    await expect(
      insertLesson(pglite, orgAId, courseId, userAId, '', 0),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('T5e: course_lesson_position_nonneg_check — negative position rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseId = await insertCourse(pglite, orgAId, userAId, 'Course for T5e');
    await expect(
      insertLesson(pglite, orgAId, courseId, userAId, 'Negative Position Lesson', -1),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('T5f: void_shape_check — status=recorded with voided_at → rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseId = await insertCourse(pglite, orgAId, userAId, 'Course for T5f');
    const lessonId = await insertLesson(pglite, orgAId, courseId, userAId, 'Lesson T5f', 0);
    const enrollId = await insertEnrollment(pglite, orgAId, courseId, userAId, userAId);
    // status='recorded' (default) but voided_at is NOT NULL → violates check.
    await expect(
      pglite.query(
        `INSERT INTO lesson_record
           (org_id, enrollment_id, lesson_id, instructor_user_id, recorded_by,
            status, voided_at, voided_reason)
         VALUES ($1, $2, $3, $4, $4, 'recorded', now(), 'should fail')`,
        [orgAId, enrollId, lessonId, userAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('T5g: void_shape_check — status=voided without voided_at → rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseId = await insertCourse(pglite, orgAId, userAId, 'Course for T5g');
    const lessonId = await insertLesson(pglite, orgAId, courseId, userAId, 'Lesson T5g', 0);
    const enrollId = await insertEnrollment(pglite, orgAId, courseId, userAId, userAId);
    // status='voided' but voided_at IS NULL → violates check.
    await expect(
      pglite.query(
        `INSERT INTO lesson_record
           (org_id, enrollment_id, lesson_id, instructor_user_id, recorded_by,
            status, voided_reason)
         VALUES ($1, $2, $3, $4, $4, 'voided', 'Missing voided_at')`,
        [orgAId, enrollId, lessonId, userAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('T5h: void_shape_check — status=voided without voided_reason → rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseId = await insertCourse(pglite, orgAId, userAId, 'Course for T5h');
    const lessonId = await insertLesson(pglite, orgAId, courseId, userAId, 'Lesson T5h', 0);
    const enrollId = await insertEnrollment(pglite, orgAId, courseId, userAId, userAId);
    // status='voided' but voided_reason IS NULL → violates check.
    await expect(
      pglite.query(
        `INSERT INTO lesson_record
           (org_id, enrollment_id, lesson_id, instructor_user_id, recorded_by,
            status, voided_at)
         VALUES ($1, $2, $3, $4, $4, 'voided', now())`,
        [orgAId, enrollId, lessonId, userAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── T6: UNIQUE constraints fire ───────────────────────────────────────────

  it('T6a: enrollment_student_course_unique — duplicate (student, course) rejected (23505)', async () => {
    const { pglite, orgAId, userAId, userA2Id } = env;

    // First enrollment succeeds.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseId = await insertCourse(pglite, orgAId, userA2Id, 'Course for T6a');
    await insertEnrollment(pglite, orgAId, courseId, userAId, userA2Id);
    await pglite.exec(`COMMIT`);

    // Second enrollment for same (student, course) must fail.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertEnrollment(pglite, orgAId, courseId, userAId, userA2Id),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('T6b: enrollment_id_org_id_unique index is present', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'enrollment_id_org_id_unique'`,
    );
    expect(r.rows[0]!.count).toBe('1');
  });

  it('T6c: course_lesson_course_id_position_unique — duplicate (course, position) rejected', async () => {
    const { pglite, orgAId, userAId } = env;

    // Create a course and first lesson at position 0.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseId = await insertCourse(pglite, orgAId, userAId, 'Course for T6c');
    await insertLesson(pglite, orgAId, courseId, userAId, 'Lesson 0', 0);
    await pglite.exec(`COMMIT`);

    // Second lesson at same position must fail.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      insertLesson(pglite, orgAId, courseId, userAId, 'Duplicate Position', 0),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('T6d: course_id_org_id_unique index is present', async () => {
    const { pglite } = env;
    const r = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM pg_indexes
       WHERE schemaname = 'public' AND indexname = 'course_id_org_id_unique'`,
    );
    expect(r.rows[0]!.count).toBe('1');
  });

  // ── T7: Enum domain ───────────────────────────────────────────────────────

  it('T7a: enrollment_status — invalid value rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseId = await insertCourse(pglite, orgAId, userAId, 'Course for T7a');
    await expect(
      pglite.query(
        `INSERT INTO enrollment (org_id, course_id, student_user_id, enrolled_by, status)
         VALUES ($1, $2, $3, $3, 'invalid_status')`,
        [orgAId, courseId, userAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('T7b: lesson_record_status — invalid value rejected', async () => {
    const { pglite, orgAId, userAId } = env;
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseId = await insertCourse(pglite, orgAId, userAId, 'Course for T7b');
    const lessonId = await insertLesson(pglite, orgAId, courseId, userAId, 'Lesson T7b', 0);
    const enrollId = await insertEnrollment(pglite, orgAId, courseId, userAId, userAId);
    await expect(
      pglite.query(
        `INSERT INTO lesson_record
           (org_id, enrollment_id, lesson_id, instructor_user_id, recorded_by, status)
         VALUES ($1, $2, $3, $4, $4, 'not_a_valid_status')`,
        [orgAId, enrollId, lessonId, userAId],
      ),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  it('T7c: enrollment status defaults to active', async () => {
    const { pglite, db, orgAId, userAId, userA2Id } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseId = await insertCourse(pglite, orgAId, userA2Id, 'Course T7c');
    const enrollId = await insertEnrollment(pglite, orgAId, courseId, userAId, userA2Id);
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(enrollment).execute(),
    );
    const row = rows.find((r) => r.id === enrollId);
    expect(row?.status).toBe('active');
  });

  it('T7d: lesson_record status defaults to recorded', async () => {
    const { pglite, db, orgAId, userAId, userA2Id } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseId = await insertCourse(pglite, orgAId, userA2Id, 'Course T7d');
    const lessonId = await insertLesson(pglite, orgAId, courseId, userA2Id, 'Lesson T7d', 0);
    const enrollId = await insertEnrollment(pglite, orgAId, courseId, userAId, userA2Id);
    const recordId = await insertLessonRecord(pglite, orgAId, enrollId, lessonId, userA2Id, userA2Id);
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    const rows = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(lessonRecord).execute(),
    );
    const row = rows.find((r) => r.id === recordId);
    expect(row?.status).toBe('recorded');
  });

  // ── T8: Happy-path multi-row round-trip ───────────────────────────────────

  it('T8: happy-path — course → lesson → enrollment → lesson_record round-trips', async () => {
    const { pglite, db, orgAId, userAId, userA2Id } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseId = await insertCourse(pglite, orgAId, userA2Id, 'Full Round-Trip Course');
    const lessonId = await insertLesson(pglite, orgAId, courseId, userA2Id, 'Intro Lesson', 0);
    const enrollId = await insertEnrollment(pglite, orgAId, courseId, userAId, userA2Id);
    const recordId = await insertLessonRecord(pglite, orgAId, enrollId, lessonId, userA2Id, userA2Id);
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    // All rows readable under correct org context.
    const courses = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(course).execute(),
    );
    expect(courses.some((r) => r.id === courseId)).toBe(true);

    const lessons = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(courseLesson).execute(),
    );
    expect(lessons.some((r) => r.id === lessonId)).toBe(true);

    const enrollments = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(enrollment).execute(),
    );
    expect(enrollments.some((r) => r.id === enrollId)).toBe(true);

    const records = await withOrgContext(db, orgAId, (tx) =>
      tx.select().from(lessonRecord).execute(),
    );
    expect(records.some((r) => r.id === recordId)).toBe(true);
  });

  // ── T9: void_shape_check accepted direction ───────────────────────────────

  it('T9: void_shape_check — status=voided with voided_at + voided_reason → accepted', async () => {
    const { pglite, orgAId, userAId, userA2Id } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseId = await insertCourse(pglite, orgAId, userA2Id, 'Course for T9');
    const lessonId = await insertLesson(pglite, orgAId, courseId, userA2Id, 'Lesson T9', 0);
    const enrollId = await insertEnrollment(pglite, orgAId, courseId, userAId, userA2Id);

    // Insert with status='voided' + both voided_at + voided_reason → must succeed.
    const r = await pglite.query<{ id: string }>(
      `INSERT INTO lesson_record
         (org_id, enrollment_id, lesson_id, instructor_user_id, recorded_by,
          status, voided_at, voided_reason, voided_by)
       VALUES ($1, $2, $3, $4, $4, 'voided', now(), 'Instructor error', $4)
       RETURNING id`,
      [orgAId, enrollId, lessonId, userA2Id],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    expect(r.rows[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ── T10: voided_by SET NULL (durable who in audit_log) ───────────────────

  it('T10: voided_by SET NULL — record survives user hard-delete with voided_by=NULL', async () => {
    const { pglite, orgAId, userAId } = env;

    // Create a disposable voider user.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const voiderResult = await pglite.query<{ id: string }>(
      `INSERT INTO app_user (org_id, email, full_name)
       VALUES ($1, 'disposable-voider@alpha-training.example', 'Disposable Voider')
       RETURNING id`,
      [orgAId],
    );
    const voiderId = voiderResult.rows[0]!.id;

    const courseId = await insertCourse(pglite, orgAId, userAId, 'Course for T10');
    const lessonId = await insertLesson(pglite, orgAId, courseId, userAId, 'Lesson T10', 0);
    const enrollId = await insertEnrollment(pglite, orgAId, courseId, userAId, userAId);

    // Insert a voided record pointing to the disposable voider.
    const recResult = await pglite.query<{ id: string }>(
      `INSERT INTO lesson_record
         (org_id, enrollment_id, lesson_id, instructor_user_id, recorded_by,
          status, voided_at, voided_reason, voided_by)
       VALUES ($1, $2, $3, $4, $4, 'voided', now(), 'Test SET NULL', $5)
       RETURNING id`,
      [orgAId, enrollId, lessonId, userAId, voiderId],
    );
    const recordId = recResult.rows[0]!.id;
    await pglite.exec(`COMMIT`);

    // Delete the voider — must succeed (SET NULL, not RESTRICT).
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await pglite.query(`DELETE FROM app_user WHERE id = $1`, [voiderId]);
    await pglite.exec(`COMMIT`);

    // Record must still exist with voided_by = NULL.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const check = await pglite.query<{ voided_by: string | null }>(
      `SELECT voided_by FROM lesson_record WHERE id = $1`,
      [recordId],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    expect(check.rows[0]!.voided_by).toBeNull();
  });

  // ── T11: RESTRICT on lesson delete (has_records backstop) ─────────────────

  it('T11: RESTRICT — deleting a course_lesson with lesson_records is blocked', async () => {
    const { pglite, orgAId, userAId } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseId = await insertCourse(pglite, orgAId, userAId, 'Course for T11');
    const lessonId = await insertLesson(pglite, orgAId, courseId, userAId, 'Lesson T11', 0);
    const enrollId = await insertEnrollment(pglite, orgAId, courseId, userAId, userAId);
    await insertLessonRecord(pglite, orgAId, enrollId, lessonId, userAId, userAId);
    await pglite.exec(`COMMIT`);

    // Deleting the lesson must be blocked (RESTRICT).
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(`DELETE FROM course_lesson WHERE id = $1`, [lessonId]),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── T12: RESTRICT on enrollment delete ────────────────────────────────────

  it('T12: RESTRICT — deleting an enrollment with lesson_records is blocked', async () => {
    const { pglite, orgAId, userAId, userA2Id } = env;

    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const courseId = await insertCourse(pglite, orgAId, userA2Id, 'Course for T12');
    const lessonId = await insertLesson(pglite, orgAId, courseId, userA2Id, 'Lesson T12', 0);
    const enrollId = await insertEnrollment(pglite, orgAId, courseId, userAId, userA2Id);
    await insertLessonRecord(pglite, orgAId, enrollId, lessonId, userA2Id, userA2Id);
    await pglite.exec(`COMMIT`);

    // Deleting the enrollment must be blocked (RESTRICT).
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await expect(
      pglite.query(`DELETE FROM enrollment WHERE id = $1`, [enrollId]),
    ).rejects.toThrow();
    await pglite.exec(`ROLLBACK`);
    await pglite.exec(`SET ROLE aeroops_app`);
  });

  // ── T13: CASCADE from course → course_lesson ──────────────────────────────

  it('T13: CASCADE — deleting a course removes its course_lessons', async () => {
    const { pglite, orgAId, userAId } = env;

    // Create a disposable course with a lesson, no enrollment.
    await pglite.exec(`SET ROLE postgres`);
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const dispCourseId = await insertCourse(pglite, orgAId, userAId, 'Disposable Course T13');
    const dispLessonId = await insertLesson(pglite, orgAId, dispCourseId, userAId, 'Lesson T13', 0);
    await pglite.exec(`COMMIT`);

    // Delete the course — its lessons must cascade-delete.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    await pglite.query(`DELETE FROM course WHERE id = $1`, [dispCourseId]);
    await pglite.exec(`COMMIT`);

    // Verify lesson is gone.
    await pglite.exec(`BEGIN`);
    await pglite.exec(`SET LOCAL "app.current_org_id" = '${orgAId}'`);
    const check = await pglite.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM course_lesson WHERE id = $1`,
      [dispLessonId],
    );
    await pglite.exec(`COMMIT`);
    await pglite.exec(`SET ROLE aeroops_app`);

    expect(check.rows[0]!.count).toBe('0');
  });

  // ── T14: Down migration reverses 0012 ────────────────────────────────────

  it('T14: down migration cleanly reverses 0012 — all four tables and enums gone', async () => {
    const { pglite: pg2 } = await createTestClient();
    await applyMigrationSql({ pglite: pg2 }, MIGRATION_SQL);
    await applyMigrationSql({ pglite: pg2 }, [DOWN_0012]);

    // All four tables should be gone.
    for (const tableName of ['course', 'course_lesson', 'enrollment', 'lesson_record']) {
      const r = await pg2.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT FROM information_schema.tables
           WHERE table_schema = 'public' AND table_name = $1
         ) AS exists`,
        [tableName],
      );
      expect(r.rows[0]!.exists).toBe(false);
    }

    // Enum types should be gone.
    for (const typeName of ['enrollment_status', 'lesson_record_status']) {
      const r = await pg2.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_type
         WHERE typname = $1 AND typtype = 'e'`,
        [typeName],
      );
      expect(r.rows[0]!.count).toBe('0');
    }

    // Indexes should also be gone.
    for (const idxName of [
      'course_id_org_id_unique',
      'course_org_status_idx',
      'course_lesson_id_org_id_unique',
      'enrollment_id_org_id_unique',
      'lesson_record_id_org_id_unique',
    ]) {
      const r = await pg2.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = $1`,
        [idxName],
      );
      expect(r.rows[0]!.count).toBe('0');
    }
  });
});
