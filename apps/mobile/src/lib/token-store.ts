/**
 * lib/token-store.ts — Secure token storage facade.
 *
 * Slice 4M-REVOKE ([VERIFY-4M-SEC-1]): stores TWO tokens now — a short-lived
 * ACCESS token (~15 min) and a longer-lived, revocable, rotating REFRESH
 * token. Both live ONLY in expo-secure-store (OS keychain backed).
 *
 * SECURITY INVARIANTS:
 *   - Both tokens are stored ONLY in expo-secure-store.
 *   - NEVER stored in AsyncStorage, MMKV, or any plaintext store.
 *   - NEVER logged (both are opaque to the device).
 *   - NEVER committed to source or included in crash reports.
 *   - On delete: clears the keychain entry; a missing entry is treated as
 *     "logged out" (fail-closed).
 *
 * The *_KEY constants are keychain item identifiers — not secrets themselves.
 */

import * as SecureStore from 'expo-secure-store';

/** Keychain key under which the short-lived access token is stored. */
const ACCESS_TOKEN_KEY = 'aeroops_access_token';

/** Keychain key under which the rotating refresh token is stored. */
const REFRESH_TOKEN_KEY = 'aeroops_refresh_token';

// ─── Access token ───────────────────────────────────────────────────────────

/**
 * getAccessToken — reads the stored access token.
 *
 * Returns null if absent, unavailable, or on any unexpected read error
 * (fail-closed — callers treat null as "not authenticated" for this token).
 */
export async function getAccessToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
  } catch {
    return null;
  }
}

/** saveAccessToken — writes the access token, overwriting any previous value. */
export async function saveAccessToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, token);
}

/** deleteAccessToken — removes the access token. Idempotent (no-op if absent). */
export async function deleteAccessToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY);
  } catch {
    // Ignore — the token is considered gone either way.
  }
}

// ─── Refresh token ──────────────────────────────────────────────────────────

/**
 * getRefreshToken — reads the stored refresh token.
 *
 * Returns null if absent, unavailable, or on any unexpected read error.
 */
export async function getRefreshToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
  } catch {
    return null;
  }
}

/** saveRefreshToken — writes the refresh token, overwriting any previous value. */
export async function saveRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token);
}

/** deleteRefreshToken — removes the refresh token. Idempotent (no-op if absent). */
export async function deleteRefreshToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
  } catch {
    // Ignore — the token is considered gone either way.
  }
}

// ─── Combined helpers ───────────────────────────────────────────────────────

export interface StoredTokens {
  accessToken: string | null;
  refreshToken: string | null;
}

/** getTokens — reads both tokens (used on app launch). */
export async function getTokens(): Promise<StoredTokens> {
  const [accessToken, refreshToken] = await Promise.all([
    getAccessToken(),
    getRefreshToken(),
  ]);
  return { accessToken, refreshToken };
}

/** saveTokens — writes both tokens (used after login/refresh). */
export async function saveTokens(tokens: { accessToken: string; refreshToken: string }): Promise<void> {
  await Promise.all([
    saveAccessToken(tokens.accessToken),
    saveRefreshToken(tokens.refreshToken),
  ]);
}

/** clearTokens — removes both tokens. Idempotent. Used on sign-out / hard 401. */
export async function clearTokens(): Promise<void> {
  await Promise.all([deleteAccessToken(), deleteRefreshToken()]);
}
