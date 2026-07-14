/**
 * integrations/qbo/token.ts — ensureFreshAccessToken, shared by the QBO push
 * commands (export-invoice.ts + sync-payment.ts).
 *
 * Refreshes the connection's access token if it is expired (or within a 60s
 * safety margin), persisting the new tokens. Throws QboNotConfiguredError
 * (propagated from the stub client) or the underlying provider error — callers
 * catch both and convert them to typed refusals (never a crash).
 *
 * Runs on the passed tx (org context already set by the caller — RLS-scoped).
 */

import { eq } from 'drizzle-orm';
import { qboConnection } from '@aeroops/db';
import type { AnyDb } from '@aeroops/db';
import type { QboClient, QboRequestContext } from './client.js';

export async function ensureFreshAccessToken(
  tx: AnyDb,
  orgId: string,
  connection: {
    accessToken: string | null;
    refreshToken: string | null;
    accessTokenExpiresAt: Date | string | null;
    realmId: string | null;
  },
  client: QboClient,
): Promise<QboRequestContext> {
  const realmId = connection.realmId as string;
  const expiresAt = connection.accessTokenExpiresAt
    ? connection.accessTokenExpiresAt instanceof Date
      ? connection.accessTokenExpiresAt
      : new Date(connection.accessTokenExpiresAt)
    : null;

  const isFresh = expiresAt !== null && expiresAt.getTime() - Date.now() > 60_000;
  if (isFresh && connection.accessToken) {
    return { realmId, accessToken: connection.accessToken };
  }

  if (!connection.refreshToken) {
    throw new Error('[qbo] ensureFreshAccessToken: no refresh_token on file — reconnect required');
  }

  const refreshed = await client.refreshTokens(connection.refreshToken);

  await tx
    .update(qboConnection)
    .set({
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      accessTokenExpiresAt: refreshed.expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(qboConnection.orgId, orgId));

  return { realmId, accessToken: refreshed.accessToken };
}
