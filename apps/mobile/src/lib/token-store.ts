/**
 * lib/token-store.ts — Secure token storage facade.
 *
 * SECURITY INVARIANTS (ADR-0010):
 *   - The bearer token is stored ONLY in expo-secure-store (OS keychain backed).
 *   - NEVER stored in AsyncStorage, MMKV, or any plaintext store.
 *   - NEVER logged (token is opaque to the device; it is a signed server JWT).
 *   - NEVER committed to source or included in crash reports.
 *   - On delete: clears the keychain entry; a missing entry is treated as
 *     "logged out" (fail-closed).
 *
 * The TOKEN_KEY constant is the keychain item identifier — not a secret itself.
 */

import * as SecureStore from 'expo-secure-store';

/** Keychain key under which the bearer token is stored. */
const TOKEN_KEY = 'aeroops_bearer_token';

/**
 * getToken — reads the stored bearer token.
 *
 * Returns null if:
 *   - No token has been stored yet (first launch / after sign-out).
 *   - SecureStore is unavailable on this device (rare; older Android).
 *   - Any unexpected read error.
 *
 * Callers should treat null as "unauthenticated" and redirect to login.
 */
export async function getToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    // Any keychain read error → treat as no token (fail-closed).
    return null;
  }
}

/**
 * saveToken — writes the bearer token to the OS keychain.
 *
 * Overwrites any previously stored token.
 * NEVER call this with AUTH_SECRET or any server-side secret.
 */
export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

/**
 * deleteToken — removes the bearer token from the OS keychain.
 *
 * Called on sign-out and on 401 responses.
 * Idempotent: deleting a non-existent item is a no-op (no error thrown).
 */
export async function deleteToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  } catch {
    // Ignore deletion errors — the token is considered gone either way.
  }
}
