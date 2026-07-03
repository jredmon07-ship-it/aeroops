/**
 * training/lesson-record-snapshot.ts — canonical, deterministic serialization
 * of a lesson_record row for e-signature tamper-evidence (Slice P2-ESIGN).
 *
 * `canonicalLessonRecordSnapshot` is PURE (no I/O, no node:crypto — this file
 * is imported by mobile/RN too). The API layer hashes the returned string
 * with sha256 to produce `lesson_signature.content_hash`.
 *
 * COMPLIANCE [VERIFY-P2-A]: the resulting hash is a TAMPER-EVIDENCE digest
 * ONLY — it proves a later lesson_record snapshot differs from what was
 * signed. It is NOT a cryptographic/PKI signature, NOT an FAA-recognized
 * digital/electronic signature, and confers no §61/§141 endorsement meaning.
 *
 * DETERMINISM CONTRACT (property-tested):
 *   - The output depends ONLY on the seven input field VALUES, never on the
 *     order in which the caller happened to build the input object — every
 *     field is read by name into a FIXED key order below, never spread/
 *     iterated. Building the same values into a differently-ordered object
 *     literal yields a byte-identical canonical string.
 *   - Any single-field change (including null ↔ '' , which are NOT treated
 *     as equivalent) yields a different canonical string.
 *
 * FIXED KEY ORDER: id, enrollmentId, lessonId, instructorUserId, completedAt,
 * gradeLabel, notes, status.
 */

export interface LessonRecordSnapshotInput {
  id: string;
  enrollmentId: string;
  lessonId: string;
  instructorUserId: string;
  /** ISO 8601 string — the caller normalizes Date -> ISO before calling. */
  completedAt: string;
  gradeLabel: string | null;
  notes: string | null;
  status: string;
}

/**
 * Encode a nullable string field as canonical JSON: `null` (the literal) when
 * absent, otherwise a properly quote/escape JSON string. null and '' are
 * DELIBERATELY distinct encodings — a later edit from null to '' (or vice
 * versa) must change the hash.
 */
function encodeNullableString(value: string | null): string {
  return value === null ? 'null' : JSON.stringify(value);
}

/**
 * canonicalLessonRecordSnapshot — deterministic canonical-JSON serialization
 * of a lesson_record snapshot, built with a FIXED key order regardless of the
 * input object's own property insertion order.
 *
 * Pure: no I/O, no Date construction, no node:crypto (safe for mobile/RN).
 */
export function canonicalLessonRecordSnapshot(
  input: LessonRecordSnapshotInput,
): string {
  const entries: Array<[string, string]> = [
    ['id', JSON.stringify(input.id)],
    ['enrollmentId', JSON.stringify(input.enrollmentId)],
    ['lessonId', JSON.stringify(input.lessonId)],
    ['instructorUserId', JSON.stringify(input.instructorUserId)],
    ['completedAt', JSON.stringify(input.completedAt)],
    ['gradeLabel', encodeNullableString(input.gradeLabel)],
    ['notes', encodeNullableString(input.notes)],
    ['status', JSON.stringify(input.status)],
  ];

  const body = entries.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(',');
  return `{${body}}`;
}
