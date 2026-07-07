/**
 * settings/messages/actions.ts — Server actions for member messaging /
 * announcements (FC-parity "Engage with Messaging by Email").
 *
 * Pattern mirrors billing/actions.ts:
 *   1. await auth() → session.
 *   2. Call @aeroops/api fn (requireCapability('org:manage_settings') inside).
 *   3. Map ForbiddenError/UnauthenticatedError → tagged error result.
 *   4. Map ValidationError → { error: 'validation', message }.
 *   5. Pass through ok:false arms as-is.
 *
 * BOUNDARY: imports ONLY from @aeroops/api — NEVER @aeroops/db.
 * NO money. The message body is plain text; audit records the subject only.
 */
'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/auth';
import {
  sendMemberMessage,
  previewMemberMessageRecipients,
  listMemberMessages,
  ForbiddenError,
  UnauthenticatedError,
} from '@aeroops/api';

// ─── Error shapes ──────────────────────────────────────────────────────────────

export type AuthErrorResult = { error: 'forbidden' } | { error: 'unauthenticated' };
export type ServerErrorResult = { error: 'server'; message?: string };

function mapAuthError(err: unknown): AuthErrorResult | null {
  if (err instanceof ForbiddenError) return { error: 'forbidden' };
  if (err instanceof UnauthenticatedError) return { error: 'unauthenticated' };
  return null;
}

function mapValidationError(err: unknown): { error: 'validation'; message: string } | null {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'VALIDATION' &&
    err instanceof Error
  ) {
    return { error: 'validation', message: err.message };
  }
  return null;
}

// ─── Input shapes ──────────────────────────────────────────────────────────────

export interface MessageAudienceInput {
  audience: 'all_active' | 'role';
  role?: string;
}

// ─── previewMemberMessageRecipientsAction ───────────────────────────────────

export type PreviewRecipientsActionResult =
  | { ok: true; recipientCount: number }
  | { error: 'validation'; message: string }
  | AuthErrorResult
  | ServerErrorResult;

export async function previewMemberMessageRecipientsAction(
  input: MessageAudienceInput,
): Promise<PreviewRecipientsActionResult> {
  const session = await auth();
  try {
    const result = await previewMemberMessageRecipients(session, input);
    return { ok: true, recipientCount: result.recipientCount };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    const valErr = mapValidationError(err);
    if (valErr) return valErr;
    return { error: 'server' };
  }
}

// ─── sendMemberMessageAction ─────────────────────────────────────────────────

export type SendMemberMessageActionResult =
  | { ok: true; recipientCount: number; sentCount: number; skippedCount: number; failedCount: number }
  | { error: 'validation'; message: string }
  | AuthErrorResult
  | ServerErrorResult;

export async function sendMemberMessageAction(
  input: { subject: string; body: string; audience: 'all_active' | 'role'; role?: string },
  slug: string,
): Promise<SendMemberMessageActionResult> {
  const session = await auth();
  try {
    const result = await sendMemberMessage(session, input);
    revalidatePath(`/o/${slug}/settings/messages`);
    return {
      ok: true,
      recipientCount: result.recipientCount,
      sentCount: result.sentCount,
      skippedCount: result.skippedCount,
      failedCount: result.failedCount,
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    const valErr = mapValidationError(err);
    if (valErr) return valErr;
    return { error: 'server' };
  }
}

// ─── listMemberMessagesAction ────────────────────────────────────────────────

export interface SerializedMemberMessage {
  id: string;
  subject: string;
  body: string;
  audience: 'all_active' | 'role';
  role: string | null;
  recipientCount: number;
  createdAt: string;
}

export type ListMemberMessagesActionResult =
  | { ok: true; messages: SerializedMemberMessage[] }
  | AuthErrorResult
  | ServerErrorResult;

export async function listMemberMessagesAction(): Promise<ListMemberMessagesActionResult> {
  const session = await auth();
  try {
    const messages = await listMemberMessages(session);
    return {
      ok: true,
      messages: messages.map((m) => ({
        id: m.id,
        subject: m.subject,
        body: m.body,
        audience: m.audience,
        role: m.role,
        recipientCount: m.recipientCount,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  } catch (err) {
    const authErr = mapAuthError(err);
    if (authErr) return authErr;
    return { error: 'server' };
  }
}
