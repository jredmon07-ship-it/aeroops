/**
 * serialize-pilot-log.ts — the single pilot-log wire serializer.
 *
 * The staff (people) and self (portal) logbook actions both hand a PilotLog to
 * client components as plain JSON, so Dates become ISO strings. This replaces
 * the byte-identical serializePilotLog / serializePilotLogEntry copies that
 * lived in both people/actions.ts and portal/actions.ts.
 */
import type { PilotLogEntry, PilotLog } from '@aeroops/api';

export interface SerializedPilotLogEntry {
  ticketId: string;
  date: string; // ISO string
  tail: string;
  make: string | null;
  model: string | null;
  /** FREE TEXT operator-entered (e.g. 'Airplane') — not a certification determination. */
  category: string | null;
  /** FREE TEXT operator-entered (e.g. 'ASEL') — not a certification determination. */
  aircraftClass: string | null;
  hobbsOut: number;
  hobbsIn: number;
  flightTimeHours: number;
  runningTotalHours: number;
  // Effective (latest) annotation — pilot/operator-entered; not a certified
  // §61.51 entry; no §61.57 currency determination (Slice P2-LOG2).
  nightHours: number | null;
  instrumentHours: number | null;
  crossCountryHours: number | null;
  remarks: string | null;
}

export interface SerializedPilotLog {
  entries: SerializedPilotLogEntry[];
  totalHours: number;
}

export function serializePilotLogEntry(e: PilotLogEntry): SerializedPilotLogEntry {
  return {
    ticketId: e.ticketId,
    date: e.date instanceof Date ? e.date.toISOString() : String(e.date),
    tail: e.tail,
    make: e.make,
    model: e.model,
    category: e.category,
    aircraftClass: e.aircraftClass,
    hobbsOut: e.hobbsOut,
    hobbsIn: e.hobbsIn,
    flightTimeHours: e.flightTimeHours,
    runningTotalHours: e.runningTotalHours,
    nightHours: e.nightHours,
    instrumentHours: e.instrumentHours,
    crossCountryHours: e.crossCountryHours,
    remarks: e.remarks,
  };
}

export function serializePilotLog(log: PilotLog): SerializedPilotLog {
  return {
    entries: log.entries.map(serializePilotLogEntry),
    totalHours: log.totalHours,
  };
}
