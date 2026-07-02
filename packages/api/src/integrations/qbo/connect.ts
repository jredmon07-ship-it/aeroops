/**
 * integrations/qbo/connect.ts — OAuth2 connect / callback / disconnect
 * commands (Slice QB1).
 *
 * buildQboAuthorizeUrl — org:manage_settings → the Intuit authorize URL to
 *   redirect the browser to. Mints a short-lived signed state token bound
 *   to (session.orgId, session.userId) — see state.ts.
 *
 * completeQboOAuth — org:manage_settings → exchanges the OAuth2 `code` for
 *   tokens and upserts qbo_connection. Called from the CALLBACK route,
 *   which is reached via an unauthenticated browser redirect from Intuit —
 *   org_id is taken ONLY from the verified session (requireCapability) AND
 *   cross-checked against the signed `state` value minted by
 *   buildQboAuthorizeUrl; a state that fails to verify OR does not match
 *   the current session is refused before any DB write.
 *
 * disconnectQbo — org:manage_settings → sets status='disconnected' and
 *   NULLs both token columns (never hard-deletes the connection row).
 *
 * GUARANTEES:
 *   - requireCapability(session, 'org:manage_settings') FIRST on every command.
 *   - org_id from session only (withSessionOrgContextWithDb + RLS backstop) —
 *     NEVER from the OAuth callback's query string.
 *   - Every transition is audited. NO card/bank data. NO Stripe. NO money.
 *
 * TWO CALLING FORMS per command:
 *   fn(session, input)          — app code.
 *   fnWithDb(db, session, input) — tests (client is always injectable — see
 *   the optional `client` param — so tests never make a real HTTP call).
 */

import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { qboConnection, auditLog } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import { requireCapability } from '../../auth/require-capability.js';
import { withSessionOrgContextWithDb } from '../../auth/session.js';
import { getDb } from '../../db.js';
import type { AppSession } from '../../auth/types.js';
import { ValidationError } from '../../scheduling/internal.js';
import { getQboClient, QBO_AUTHORIZE_URL, QBO_ACCOUNTING_SCOPE, QboNotConfiguredError } from './client.js';
import type { QboClient } from './client.js';
import { signQboState, verifyQboState } from './state.js';

// ─── buildQboAuthorizeUrl ─────────────────────────────────────────────────────

export type BuildQboAuthorizeUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'not_configured' };

function getRedirectUri(): string | undefined {
  return process.env['QBO_REDIRECT_URI'];
}

export async function buildQboAuthorizeUrl(
  session: AppSession | null | undefined,
): Promise<BuildQboAuthorizeUrlResult> {
  const sess = requireCapability(session, 'org:manage_settings');

  const clientId = process.env['QBO_CLIENT_ID'];
  const redirectUri = getRedirectUri();
  if (!clientId || !redirectUri) {
    return { ok: false, reason: 'not_configured' };
  }

  const state = await signQboState({ orgId: sess.orgId, userId: sess.userId });

  const url = new URL(QBO_AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', QBO_ACCOUNTING_SCOPE);
  url.searchParams.set('state', state);

  return { ok: true, url: url.toString() };
}

// ─── completeQboOAuth ─────────────────────────────────────────────────────────

const completeQboOAuthInputSchema = z.object({
  code: z.string().min(1, { message: 'code is required' }),
  realmId: z.string().min(1, { message: 'realmId is required' }),
  state: z.string().min(1, { message: 'state is required' }),
});

export type CompleteQboOAuthInput = z.infer<typeof completeQboOAuthInputSchema>;

export type CompleteQboOAuthResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_state' }
  | { ok: false; reason: 'not_configured' }
  | { ok: false; reason: 'provider_error'; message: string };

async function _completeQboOAuthImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
  rawInput: unknown,
  client: QboClient = getQboClient(),
): Promise<CompleteQboOAuthResult> {
  // AUTHZ FIRST — even though state also carries orgId/userId, the session
  // itself must independently hold org:manage_settings.
  const sess = requireCapability(session, 'org:manage_settings');

  const parsed = completeQboOAuthInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ValidationError(`[qbo] invalid completeQboOAuth input: ${first?.message ?? 'unknown'}`);
  }
  const { code, realmId, state } = parsed.data;

  // Verify the signed state AND cross-check it against the CURRENT session.
  // org_id is NEVER taken from the callback query string — only from the
  // session (via requireCapability above) after this state check passes.
  const decoded = await verifyQboState(state);
  if (!decoded || decoded.orgId !== sess.orgId || decoded.userId !== sess.userId) {
    return { ok: false, reason: 'invalid_state' };
  }

  const redirectUri = getRedirectUri();
  if (!redirectUri) {
    return { ok: false, reason: 'not_configured' };
  }

  let tokens;
  try {
    tokens = await client.exchangeAuthCode(code, redirectUri);
  } catch (err) {
    if (err instanceof QboNotConfiguredError) {
      return { ok: false, reason: 'not_configured' };
    }
    const message = err instanceof Error ? err.message : 'Unknown QuickBooks error';
    return { ok: false, reason: 'provider_error', message };
  }

  return withSessionOrgContextWithDb(db, session, async (innerSess, tx) => {
    const now = new Date();
    const [row] = await tx
      .insert(qboConnection)
      .values({
        orgId: innerSess.orgId,
        realmId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        accessTokenExpiresAt: tokens.expiresAt,
        status: 'connected',
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: qboConnection.orgId,
        set: {
          realmId,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          accessTokenExpiresAt: tokens.expiresAt,
          status: 'connected',
          updatedAt: now,
        },
      })
      .returning();

    if (!row) throw new Error('[qbo] completeQboOAuth: UPSERT returned no row');

    // NO tokens in audit metadata — realmId + status only.
    await tx.insert(auditLog).values({
      orgId: innerSess.orgId,
      actorUserId: innerSess.userId,
      action: 'qbo.connected',
      entityType: 'qbo_connection',
      entityId: row.id,
      metadata: { realmId },
    });

    return { ok: true } as const;
  });
}

export async function completeQboOAuth(
  session: AppSession | null | undefined,
  input: unknown,
  client?: QboClient,
): Promise<CompleteQboOAuthResult> {
  const db = await getDb();
  return _completeQboOAuthImpl(db, session, input, client);
}

export async function completeQboOAuthWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
  input: unknown,
  client?: QboClient,
): Promise<CompleteQboOAuthResult> {
  return _completeQboOAuthImpl(db, session, input, client);
}

// ─── disconnectQbo ────────────────────────────────────────────────────────────

export type DisconnectQboResult = { ok: true } | { ok: false; reason: 'not_connected' };

async function _disconnectQboImpl(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<DisconnectQboResult> {
  requireCapability(session, 'org:manage_settings');

  return withSessionOrgContextWithDb(db, session, async (sess, tx) => {
    const updated = await tx
      .update(qboConnection)
      .set({
        status: 'disconnected',
        accessToken: null,
        refreshToken: null,
        accessTokenExpiresAt: null,
        updatedAt: new Date(),
      })
      .where(eq(qboConnection.orgId, sess.orgId))
      .returning({ id: qboConnection.id });

    if (!updated[0]) {
      return { ok: false, reason: 'not_connected' } as const;
    }

    await tx.insert(auditLog).values({
      orgId: sess.orgId,
      actorUserId: sess.userId,
      action: 'qbo.disconnected',
      entityType: 'qbo_connection',
      entityId: updated[0].id,
      metadata: {},
    });

    return { ok: true } as const;
  });
}

export async function disconnectQbo(
  session: AppSession | null | undefined,
): Promise<DisconnectQboResult> {
  const db = await getDb();
  return _disconnectQboImpl(db, session);
}

export async function disconnectQboWithDb(
  db: AnyDb,
  session: AppSession | null | undefined,
): Promise<DisconnectQboResult> {
  return _disconnectQboImpl(db, session);
}
