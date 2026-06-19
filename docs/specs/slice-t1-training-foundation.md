# Slice T1 — Training Hub Foundation (Phase 3 entry, THIN) — build spec

**Status:** SPEC APPROVED-PENDING — parked 2026-06-19 mid-deploy. Build when the founder
returns to feature work. No builder runs until the §2 capability grants + the §7 [VERIFY]
posture are confirmed by the compliance-officer.
**Migration:** `0012_training.sql` (human-gated, NEVER auto-run).
**ADR to author at build:** ADR-0011 (Training records core — FROZEN, additively-extended-only,
mirrors ADR-0007/0008). *(Note: an ADR-0010 already exists for mobile auth; Training takes 0011.)*
**Sub-slices:** **T1.1** schema + migration 0012 + RLS → **T1.2** backend (`@aeroops/core` ratio +
`packages/api/src/training/*`) → **T1.3** web surface. Each human-gated.

The thinnest valuable Training foundation: an operator defines a course (operator-named content),
adds ordered lessons, enrolls an existing student member, records a lesson completed by a CFI, and
views a completed/total **content ratio**. The software interprets NONE of the content and computes
NO FAA determination of any kind.

## Invariants
1. **Tenant isolation.** Every new table: `org_id` + ENABLE+FORCE RLS + 4 fail-closed named policies +
   `aeroops_app` GRANT (the migration-0008 byte-pattern). `org_id` from `sess.orgId` ONLY. Cross-org id →
   `not_found`, never 500/peek.
2. **Records integrity (mirrors ADR-0007/0008).** A `lesson_record` is a WRITE-ONCE fact
   (enrollment_id/lesson_id/completed_at/instructor_user_id/grade_label/notes set at INSERT, NEVER mutated).
   No updateLessonRecord. A mistake is VOIDED (append-only tombstone via `status`), never edited/hard-deleted.
   Every write emits exactly ONE audit_log row.
3. **NO computed FAA determination of ANY kind.** Course = operator-named content; lesson title = operator
   text; "complete" = operator/instructor record; "progress %" = completed/total content ratio. Any grade =
   FREE-TEXT/operator label, never a computed reg outcome.
4. **No money.** Not billed in this slice. No price/rate/Stripe/balance — not even a stub.
5. **AuthZ first.** Every `*Impl` calls `requireCapability` before validation/queries.
6. **Boundary.** Web imports ONLY `@aeroops/api`. The pure progress ratio lives in `@aeroops/core`.

## Data model (migration 0012; create order load-bearing: course → course_lesson → enrollment → lesson_record)
New enums (core tuples → `enums.ts` pgEnum): `ENROLLMENT_STATUSES=['active','completed','withdrawn']`,
`LESSON_RECORD_STATUSES=['recorded','voided']`.

- **`course`**: id; org_id (FK CASCADE); title (NOT NULL, nonempty CHECK); description?; status text DEFAULT
  'active' (CHECK in active/archived); created_by (composite FK RESTRICT); created_at/updated_at. UNIQUE(id,org_id);
  index(org_id,status). Only title/description/status mutate (operator config).
- **`course_lesson`**: id; org_id (FK CASCADE); course_id (composite FK (course_id,org_id)→course CASCADE);
  title (nonempty); description?; stage_label? (free-text operator grouping, NOT a Part-141 stage — [VERIFY-T1-G]);
  position int (nonneg CHECK); created_by (composite FK RESTRICT); timestamps. UNIQUE(id,org_id);
  UNIQUE(course_id,position); index(org_id,course_id). Removal blocked at API when non-voided records reference it
  (`has_records`); DB RESTRICT on the record→lesson FK backstops.
- **`enrollment`**: id; org_id (FK CASCADE); course_id (composite FK →course RESTRICT); student_user_id
  (composite FK →app_user RESTRICT — ANY member; role NOT enforced, [VERIFY-T1-E]); status enrollment_status
  DEFAULT 'active' (active→completed, active→withdrawn only); enrolled_by (composite FK RESTRICT); enrolled_at
  (write-once); status_changed_at?; timestamps. UNIQUE(id,org_id); UNIQUE(student_user_id,course_id) (no double-
  enroll, [VERIFY-T1-F]); index(org_id,course_id)+(org_id,student_user_id).
- **`lesson_record`** (write-once): id; org_id (FK CASCADE); enrollment_id (composite FK RESTRICT); lesson_id
  (composite FK →course_lesson RESTRICT); instructor_user_id (composite FK RESTRICT, write-once, NOT an
  e-signature — [VERIFY-T1-C]); completed_at (NOT NULL, defaults now, write-once); grade_label? (FREE-TEXT only,
  NOT a computed ACS/Part-61/141 verdict — [VERIFY-T1-A]); notes?; status lesson_record_status DEFAULT 'recorded'
  (only recorded→voided); recorded_by (composite FK RESTRICT); voided_by? (composite FK SET NULL — durable who in
  audit_log); voided_reason?; voided_at?. UNIQUE(id,org_id); void_shape_check (recorded ⇒ void fields NULL; voided ⇒
  voided_at+voided_reason NOT NULL); index(org_id,enrollment_id)+(org_id,lesson_id). NO flat unique on
  (enrollment_id,lesson_id) — progress numerator counts DISTINCT lesson_id among 'recorded' rows (de-dupes; allows
  re-record after void). Refusing a second active record of a lesson = [VERIFY-T1-D] (default: allow).

## API (`packages/api/src/training/*`, `*`+`*WithDb`, refusals returned, auth/validation thrown)
New caps (alphabetical in capabilities.ts): `training:access` (read), `training:manage` (build/enroll/record/void).
**Proposed grants:** access → owner/manager/cfi/dispatcher; manage → owner/manager/cfi. Student gets NEITHER in T1
(self-service portal is Phase 6 — [VERIFY-T1-H]).
- Reads: `listCourses(opts?)`, `getCourseDetail({courseId})`, `listEnrollments(opts?)`, `getEnrollmentDetail({enrollmentId})`.
  Enrollment detail aggregation (`assembleEnrollmentDetail` in internal.ts, ≤4 RLS-scoped queries, no N+1): identity
  (enrollment+course+student) → course lessons (denominator) → this enrollment's records (incl voided, +instructor name)
  → assemble per-lesson completed boolean + completedCount (DISTINCT recorded lesson_id) + progressRatio.
- Writes (ONE audit row each, re-read fresh detail): `createCourse` (training.course_created), `addCourseLesson`
  (position=max+1; not_found), `removeCourseLesson` (not_found | has_records), `enrollMember` (not_found | duplicate
  via 23505), `setEnrollmentStatus` (not_found | invalid_transition), `recordLesson` (not_found | lesson_not_in_course
  | enrollment_not_active; completed_at defaults now, write-once), `voidLessonRecord` (not_found | already_voided).
- People-detail seam: a member "Training" card listing enrollments (course/status/progress) — inline in
  assembleMemberDetail OR a sibling `listEnrollmentsForMember` (decide at build).

## Pure logic (`@aeroops/core`, unit-tested — the ONLY computed number, a content ratio NOT a reg determination)
`progressRatioFromCounts(completed,total) → {completed,total,ratio,percent}`: total===0 → 0% (no div-by-zero);
ratio=completed/total clamped [0,1]; percent=round(ratio*100). Cases: 0/0, 0/5, 1/3→33, 2/3→67, 3/5, 5/5, 6/5→clamp.

## Web (T1.3, match People/Fleet design system) — nav "Training" (after People), requiredCapability training:access
Routes (each: loading/empty/populated/error/permission-denied-redirect): `/training` courses list (+Build course);
`/training/[courseId]` course detail + ordered lessons (+Add/Remove lesson, has_records inline refusal);
`/training/enrollments` list w/ course+status filters + progress bar (+Enroll: pick course+member, duplicate refusal);
`/training/enrollments/[enrollmentId]` the core view — progress summary (completed/total + % bar, labeled operator
progress NOT a regulatory completion), per-lesson checklist (instructor/completed_at/grade/notes), full record log
(voided struck-through), Complete/Withdraw, Record lesson, Void(+reason). People detail: a Training card. Dates → ISO
at the action boundary; manage actions gated by hasCapability(training:manage).

## Edge cases
Cross-org id → not_found on every read+write; multi-course enrollment independent; zero-lesson course → 0/0=0%;
withdraw → recordLesson refused enrollment_not_active; completed/withdrawn→active = invalid_transition; remove lesson
with records → has_records (incl. only-voided: still blocks, audit history); record cross-course lesson →
lesson_not_in_course; addCourseLesson position race → unique backstop + in-tx max+1; double enroll → duplicate; double
void → already_voided; void-then-re-record allowed (distinct-lesson numerator); instructor==student allowed in T1
([VERIFY-T1-E] CFI-of-record deferred); percent rounding 1/3→33, 2/3→67.

## Tests
Schema: per-table RLS isolation (4 policies fail-closed) + composite-FK cross-org rejection + every CHECK/UNIQUE fires;
0012 strictly additive (0008–0011 tests still green). Pure: progressRatio table. Backend: every fn happy+edge both
forms; auth-ordering; **tenant-isolation on every aggregate (top priority)**; progress correctness (distinct/voided/
double); ONE audit row per write; write-once (no UPDATE of completed_at/grade/notes). Capability: exhaustiveness +
can() truth table + per-fn Forbidden. Web: nav visibility; per-page redirect + states.

## [VERIFY] — ALL to compliance-officer (Training = most reg-sensitive slice)
Asserted in T1 (confirm posture): [A] grade_label free-text only; [B] progress ratio + enrollment 'completed' =
operator content/state NOT Part-141 80%/graduation determination; [C] lesson_record = data entry NOT e-signature;
[D] T1 allows repeat active record (progress de-dupes) — confirm; [E] student/instructor = ANY member, no role/CFI-of-
record enforcement — confirm; [F] no re-enroll after withdraw — confirm; [G] stage_label free-text NOT a Part-141 stage;
[H] grants (manage=owner/manager/cfi; student no access in T1).
DEFERRED regulated-records (forward seams ONLY, each its own slice + compliance pass): digitally-signed records
(instructor+student e-sign, encrypted PIN); real `stage` table + Part-141 stage-check enforcement; 80%-completion-rate +
certificates; endorsements + library; qualification-gating (depends on the deferred 2a eligibility follow-up); document/
certificate expiry (medical/photo-ID/insurance/TSA); Part-141 audit-ready records + FSDO reporting; logbook/LogTen.
Forward note ([[dispatch-correction-table-predecessor]] analog): lesson_record's void-tombstone is the Training
correction posture; any Phase-3+ consumer attaching regulatory sign-off meaning must preserve signer identity immutably
(durable who in audit_log, NOT the voided_by SET-NULL column) — mirrors the squawk resolved_by note.

## Open build-time decisions (either choice safe): People-detail facet inline vs separate listEnrollmentsForMember;
addCourseLesson position-race (in-tx max+1 + unique backstop).
