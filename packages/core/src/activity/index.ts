/**
 * activity/index.ts — Barrel for core activity summarizer + path helpers.
 * These are the SAFETY BOUNDARY: pure, no-I/O, whitelist-only.
 */
export { summarizeAuditEntry, activityPath } from './summarize.js';
export type { SummarizeAuditEntryInput, ActivityPathInput } from './summarize.js';
