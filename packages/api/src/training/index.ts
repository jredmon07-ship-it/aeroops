/**
 * training/index.ts — Training API module barrel (Slice T1.2, ADR-0011).
 *
 * NOT directly exported from @aeroops/api barrel yet; imported from there.
 * All functions follow the fn(session,input) + fnWithDb(db,session,input) pattern.
 */

export { listCourses, listCoursesWithDb } from './list-courses.js';
export type { ListCoursesOptions } from './list-courses.js';

export { getCourseDetail, getCourseDetailWithDb } from './get-course-detail.js';
export type { GetCourseDetailInput } from './get-course-detail.js';

export { listEnrollments, listEnrollmentsWithDb } from './list-enrollments.js';
export type { ListEnrollmentsOptions } from './list-enrollments.js';

export { getEnrollmentDetail, getEnrollmentDetailWithDb } from './get-enrollment-detail.js';
export type { GetEnrollmentDetailInput } from './get-enrollment-detail.js';

export { listEnrollmentsForMember, listEnrollmentsForMemberWithDb } from './list-enrollments-for-member.js';
export type { ListEnrollmentsForMemberInput } from './list-enrollments-for-member.js';

export { createCourse, createCourseWithDb } from './create-course.js';
export type { CreateCourseInput } from './create-course.js';

export { addCourseLesson, addCourseLessonWithDb } from './add-course-lesson.js';
export type { AddCourseLessonInput } from './add-course-lesson.js';

export { removeCourseLesson, removeCourseLessonWithDb } from './remove-course-lesson.js';
export type { RemoveCourseLessonInput } from './remove-course-lesson.js';

export { enrollMember, enrollMemberWithDb } from './enroll-member.js';
export type { EnrollMemberInput } from './enroll-member.js';

export { setEnrollmentStatus, setEnrollmentStatusWithDb } from './set-enrollment-status.js';
export type { SetEnrollmentStatusInput } from './set-enrollment-status.js';

export { recordLesson, recordLessonWithDb } from './record-lesson.js';
export type { RecordLessonInput } from './record-lesson.js';

export { voidLessonRecord, voidLessonRecordWithDb } from './void-lesson-record.js';
export type { VoidLessonRecordInput } from './void-lesson-record.js';

// Types
export type {
  CourseListRow,
  CourseDetail,
  EnrollmentListRow,
  EnrollmentDetail,
  LessonProgressRow,
  LessonRecordView,
  MemberEnrollmentRow,
  ListCoursesResult,
  GetCourseDetailResult,
  ListEnrollmentsResult,
  GetEnrollmentDetailResult,
  ListEnrollmentsForMemberResult,
  CreateCourseResult,
  AddCourseLessonResult,
  RemoveCourseLessonResult,
  EnrollMemberResult,
  SetEnrollmentStatusResult,
  RecordLessonResult,
  VoidLessonRecordResult,
} from './types.js';
