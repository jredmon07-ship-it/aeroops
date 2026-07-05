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
  hobbsOut: number;
  hobbsIn: number;
  flightTimeHours: number;
  runningTotalHours: number;
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
    hobbsOut: e.hobbsOut,
    hobbsIn: e.hobbsIn,
    flightTimeHours: e.flightTimeHours,
    runningTotalHours: e.runningTotalHours,
  };
}

export function serializePilotLog(log: PilotLog): SerializedPilotLog {
  return {
    entries: log.entries.map(serializePilotLogEntry),
    totalHours: log.totalHours,
  };
}
