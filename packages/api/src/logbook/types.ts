/**
 * logbook/types.ts — public result/IO types for the pilot logbook (Slice P2).
 *
 * COMPLIANCE HARD LINE: this is a CONVENIENCE VIEW derived from the
 * operator's dispatch history — NOT the pilot's official/certified §61.51
 * logbook of record. It makes NO currency, experience, §61.51, or §61.57
 * determination. See the verbatim disclaimer in the web surfaces
 * (portal/logbook/page.tsx, people/_components/member-logbook-card.tsx).
 *
 * DERIVED, READ-ONLY: every entry is a projection of a CLOSED dispatch_ticket
 * joined to resource (make/model). flightTimeHours is computed via
 * @aeroops/core's deriveFlightTime — never persisted, never recomputed on a
 * FROZEN dispatch write path. Corrections (dispatch_ticket_correction) are
 * deliberately NOT applied here — see [VERIFY-P2-LOG-A].
 */

export interface PilotLogEntry {
  ticketId: string;
  /** dispatch_ticket.closed_at */
  date: Date;
  /** resource.tail_number, falling back to resource.id when unset. */
  tail: string;
  make: string | null;
  model: string | null;
  hobbsOut: number;
  hobbsIn: number;
  /** deriveFlightTime(hobbsOut, hobbsIn) — display-only, never persisted here. */
  flightTimeHours: number;
  /** Cumulative hours oldest→this entry, tenths-accurate (no float drift). */
  runningTotalHours: number;
}

export interface PilotLog {
  entries: PilotLogEntry[];
  totalHours: number;
}

export interface PilotLogCsvResult {
  filename: string;
  csv: string;
}
