/**
 * serialize-date.ts — the single Date→ISO wire serializer for server actions.
 *
 * Server actions hand RSC → client components plain JSON, so Date fields must
 * become ISO strings at the action boundary. This one helper replaces the
 * ~8 byte-identical local `serializeDate` copies that had drifted across the
 * action files (booking, fleet, training, people, maintenance, dispatch-gate).
 *
 * Accepts a Date OR an already-ISO string (values crossing an RSC boundary can
 * arrive as either) and never throws — a malformed value serializes to null
 * rather than crashing the action.
 */
export function serializeDate(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  try {
    return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
  } catch {
    return null;
  }
}
