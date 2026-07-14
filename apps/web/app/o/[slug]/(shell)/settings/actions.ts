/**
 * settings/actions.ts — Server actions for the org settings page's
 * QuickBooks Online integration card (Slice QB1).
 *
 * Pattern mirrors booking/actions.ts (retention settings) and
 * people/actions.ts: auth() → call @aeroops/api fn (requireCapability
 * inside) → map ForbiddenError/UnauthenticatedError → tagged error result.
 *
 * The page itself already gates on org:manage_settings (only owner/manager
 * ever reach /o/[slug]/settings), so every action here inherits that gate;
 * the @aeroops/api functions independently re-check the specific capability
 * they need (billing:access for reads, org:manage_settings for writes,
 * billing:manage for the export action) — defense in depth, never trust
 * the page-level gate alone.
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 *
 * NO money, NO Stripe, NO card/bank data — this is a bookkeeping EXPORT
 * integration only.
 */
'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import {
  getQboStatus,
  setQboAccountMapping,
  deleteQboAccountMapping,
  disconnectQbo,
  getQboAutoExport,
  setQboAutoExport,
  backfillQboExports,
  getFeePassing,
  setFeePassing,
} from '@aeroops/api';
import type { QboLineKind, FeePassingView } from '@aeroops/api';

// ─── Error shapes ──────────────────────────────────────────────────────────────

import { mapAuthError, isValidationError } from '@/lib/action-errors-result';
import type { AuthErrorResult, ValidationErrorResult, ServerErrorResult } from '@/lib/action-errors-result';

export type { AuthErrorResult, ValidationErrorResult, ServerErrorResult };

// ─── Serialized types (Dates → string) ────────────────────────────────────────

export interface SerializedQboConnection {
  status: 'connected' | 'disconnected' | 'error';
  realmId: string | null;
  accessTokenExpiresAt: string | null;
  updatedAt: string;
}

export interface SerializedQboExportLog {
  id: string;
  entityType: 'invoice' | 'customer' | 'payment';
  entityId: string;
  qboId: string | null;
  status: 'pending' | 'exported' | 'error';
  errorDetail: string | null;
  exportedAt: string | null;
  createdAt: string;
}

export interface SerializedQboAccountMapping {
  lineKind: QboLineKind;
  qboItemId: string;
  qboItemName: string;
  updatedAt: string;
}

export interface SerializedQboStatus {
  providerConfigured: boolean;
  connection: SerializedQboConnection | null;
  recentExports: SerializedQboExportLog[];
  accountMapping: SerializedQboAccountMapping[];
}

// ─── getQboStatusAction ─────────────────────────────────────────────────────

export type GetQboStatusActionResult = ({ ok: true } & SerializedQboStatus) | AuthErrorResult | ServerErrorResult;

export async function getQboStatusAction(): Promise<GetQboStatusActionResult> {
  const session = await auth();
  try {
    const result = await getQboStatus(session);
    return {
      ok: true,
      providerConfigured: result.providerConfigured,
      connection: result.connection
        ? {
            status: result.connection.status,
            realmId: result.connection.realmId,
            accessTokenExpiresAt: result.connection.accessTokenExpiresAt?.toISOString() ?? null,
            updatedAt: result.connection.updatedAt.toISOString(),
          }
        : null,
      recentExports: result.recentExports.map((e) => ({
        id: e.id,
        entityType: e.entityType,
        entityId: e.entityId,
        qboId: e.qboId,
        status: e.status,
        errorDetail: e.errorDetail,
        exportedAt: e.exportedAt?.toISOString() ?? null,
        createdAt: e.createdAt.toISOString(),
      })),
      accountMapping: result.accountMapping.map((m) => ({
        lineKind: m.lineKind,
        qboItemId: m.qboItemId,
        qboItemName: m.qboItemName,
        updatedAt: m.updatedAt.toISOString(),
      })),
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── setQboAccountMappingAction ─────────────────────────────────────────────

export type SetQboAccountMappingActionResult =
  | { ok: true; mapping: SerializedQboAccountMapping }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function setQboAccountMappingAction(
  input: { lineKind: QboLineKind; qboItemId: string; qboItemName: string },
  slug: string,
): Promise<SetQboAccountMappingActionResult> {
  const session = await auth();
  try {
    const result = await setQboAccountMapping(session, input);
    revalidatePath(`/o/${slug}/settings`);
    return {
      ok: true,
      mapping: {
        lineKind: result.mapping.lineKind,
        qboItemId: result.mapping.qboItemId,
        qboItemName: result.mapping.qboItemName,
        updatedAt: result.mapping.updatedAt.toISOString(),
      },
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

// ─── deleteQboAccountMappingAction ──────────────────────────────────────────

export type DeleteQboAccountMappingActionResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' }
  | AuthErrorResult
  | ServerErrorResult;

export async function deleteQboAccountMappingAction(
  lineKind: QboLineKind,
  slug: string,
): Promise<DeleteQboAccountMappingActionResult> {
  const session = await auth();
  try {
    const result = await deleteQboAccountMapping(session, { lineKind });
    revalidatePath(`/o/${slug}/settings`);
    return result;
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── disconnectQboAction ────────────────────────────────────────────────────

export type DisconnectQboActionResult =
  | { ok: true }
  | { ok: false; reason: 'not_connected' }
  | AuthErrorResult
  | ServerErrorResult;

export async function disconnectQboAction(slug: string): Promise<DisconnectQboActionResult> {
  const session = await auth();
  try {
    const result = await disconnectQbo(session);
    revalidatePath(`/o/${slug}/settings`);
    return result;
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── QBO auto-sync toggle + backfill (Slice QBO-SYNC, migration 0046) ─────────
//
// getQboAutoExport: billing:access. setQboAutoExport: org:manage_settings.
// backfillQboExports: billing:manage. All enforced inside @aeroops/api. When
// migration 0046 is unapplied the read returns available:false and the setter
// returns not_available — the card renders a disabled "upcoming update" state.
// This is a bookkeeping EXPORT toggle — NO money moves.

export interface SerializedQboAutoExport {
  autoExportInvoices: boolean;
  available: boolean;
}

export type GetQboAutoExportActionResult =
  | { ok: true; setting: SerializedQboAutoExport }
  | AuthErrorResult
  | ServerErrorResult;

export async function getQboAutoExportAction(): Promise<GetQboAutoExportActionResult> {
  const session = await auth();
  try {
    const setting = await getQboAutoExport(session);
    return { ok: true, setting };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

export type SetQboAutoExportActionResult =
  | { ok: true; autoExportInvoices: boolean }
  | { ok: false; reason: 'not_available' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function setQboAutoExportAction(
  slug: string,
  autoExportInvoices: boolean,
): Promise<SetQboAutoExportActionResult> {
  const session = await auth();
  try {
    const result = await setQboAutoExport(session, { autoExportInvoices });
    revalidatePath(`/o/${slug}/settings`);
    return result;
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}

export type BackfillQboExportsActionResult =
  | {
      ok: true;
      exported: number;
      failed: number;
      remaining: number;
      paymentsExported: number;
      paymentsFailed: number;
      paymentsRemaining: number;
    }
  | AuthErrorResult
  | ServerErrorResult;

export async function backfillQboExportsAction(slug: string): Promise<BackfillQboExportsActionResult> {
  const session = await auth();
  try {
    const result = await backfillQboExports(session);
    revalidatePath(`/o/${slug}/settings`);
    return { ok: true, ...result };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

// ─── Fee-passing (pass the ACH fee to the member) — migration 0045 ────────────
//
// org:manage_settings (enforced inside getFeePassing / setFeePassing). When
// migration 0045 is unapplied the read returns available:false and the setter
// returns not_available — the settings card renders a disabled "available in an
// upcoming update" state rather than crashing. NO card/bank data; the fee is a
// pure boolean toggle (the amount is computed at checkout).

export type GetFeePassingActionResult =
  | { ok: true; setting: FeePassingView }
  | AuthErrorResult
  | ServerErrorResult;

export async function getFeePassingAction(): Promise<GetFeePassingActionResult> {
  const session = await auth();
  try {
    const setting = await getFeePassing(session);
    return { ok: true, setting };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}

export type SetFeePassingActionResult =
  | { ok: true; passAchFeeToMember: boolean }
  | { ok: false; reason: 'not_available' }
  | AuthErrorResult
  | ValidationErrorResult
  | ServerErrorResult;

export async function setFeePassingAction(
  slug: string,
  passAchFeeToMember: boolean,
): Promise<SetFeePassingActionResult> {
  const session = await auth();
  try {
    const result = await setFeePassing(session, { passAchFeeToMember });
    revalidatePath(`/o/${slug}/settings`);
    return result;
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    if (isValidationError(err)) return { error: 'validation', message: err.message };
    return { error: 'server' };
  }
}
