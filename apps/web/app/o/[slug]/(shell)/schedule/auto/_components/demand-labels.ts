/**
 * demand-labels.ts — What the auto-scheduler calls each demand on screen.
 *
 * Demand ids are internal row keys ("demand-7", from a counter that keeps
 * counting across added and removed rows). The "could not be placed" lists
 * printed them as-is; the builder itself names rows "Session 1", "Session 2"
 * by position. demandLabels maps each submitted id to that same name.
 *
 * Pure: no React, no I/O. Unit-tested in __tests__/demand-labels.test.ts.
 */

/** id → "Session N", by position in the submitted demand list (1-based). */
export function demandLabels(demands: ReadonlyArray<{ id: string }>): Record<string, string> {
  const labels: Record<string, string> = {};
  demands.forEach((d, i) => {
    labels[d.id] = `Session ${i + 1}`;
  });
  return labels;
}

/** The label for one demand id; 'A session' if the id is not in the map. */
export function demandLabel(labels: Readonly<Record<string, string>>, demandId: string): string {
  return Object.prototype.hasOwnProperty.call(labels, demandId) ? labels[demandId]! : 'A session';
}
