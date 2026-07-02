/**
 * integrations/qbo/state.ts — signed OAuth2 state token (Slice QB1).
 *
 * The QBO OAuth2 callback (apps/web/app/api/integrations/qbo/callback/route.ts)
 * receives `state` + `code` + `realmId` on an UNAUTHENTICATED redirect from
 * Intuit's servers. org_id must NEVER come from that callback's query string —
 * it is bound into a signed `state` value minted by buildQboAuthorizeUrl
 * (integrations/qbo/connect.ts) at the START of the flow, from the caller's
 * OWN verified session. completeQboOAuth verifies the state signature AND
 * cross-checks it against the (still-authenticated) session's orgId/userId
 * before ever writing a qbo_connection row.
 *
 * Reuses the app's ONE JWT format (@auth/core's encode/decode via
 * next-auth/jwt, AUTH_SECRET) — mirrors auth/mobile-token.ts exactly, with
 * its own salt + a short 10-minute maxAge (an OAuth round-trip is seconds,
 * not hours; a stale state token must not remain valid for long).
 */

import { encode, decode } from 'next-auth/jwt';

const QBO_STATE_SALT = 'aeroops-qbo-oauth-state';
const QBO_STATE_MAX_AGE = 60 * 10; // 10 minutes

/** Mirrors auth/mobile-token.ts's build-phase placeholder guard. */
const BUILD_PHASE_PLACEHOLDER = 'build-time-placeholder-not-a-real-secret-replace-me';

function getSecret(): string {
  const secret = process.env['AUTH_SECRET'];
  if (!secret) {
    throw new Error(
      '[signQboState] AUTH_SECRET is not set. Set it in .env (see .env.example) — never hardcode the secret.',
    );
  }
  if (secret === BUILD_PHASE_PLACEHOLDER) {
    throw new Error(
      '[signQboState] AUTH_SECRET is the build-time placeholder. This value must not be used at runtime.',
    );
  }
  return secret;
}

export interface QboOAuthState {
  orgId: string;
  userId: string;
}

/** signQboState — mint a short-lived signed+encrypted state token. */
export async function signQboState(state: QboOAuthState): Promise<string> {
  const secret = getSecret();
  return encode({
    token: { orgId: state.orgId, userId: state.userId },
    secret,
    salt: QBO_STATE_SALT,
    maxAge: QBO_STATE_MAX_AGE,
  });
}

/**
 * verifyQboState — decode + verify a state token.
 * Returns null on bad signature / expired / malformed — never throws for
 * auth failures (mirrors verifyMobileToken).
 */
export async function verifyQboState(token: string): Promise<QboOAuthState | null> {
  const secret = getSecret();
  try {
    const payload = await decode({ token, secret, salt: QBO_STATE_SALT });
    if (!payload) return null;
    const orgId = payload['orgId'];
    const userId = payload['userId'];
    if (typeof orgId !== 'string' || !orgId || typeof userId !== 'string' || !userId) {
      return null;
    }
    return { orgId, userId };
  } catch {
    return null;
  }
}
