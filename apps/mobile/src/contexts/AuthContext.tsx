/**
 * contexts/AuthContext.tsx — Authentication context for the AeroOps mobile app.
 *
 * Slice 4M-REVOKE ([VERIFY-4M-SEC-1]): the app now holds an access token
 * (short-lived, ~15 min) AND a refresh token (revocable, rotating). `token`
 * (the field name existing screens already read) is the ACCESS token — no
 * screen changes were needed for this slice.
 *
 * Provides:
 *   - token: the stored access token (null if not authenticated)
 *   - isLoading: true while the initial keychain read is in progress
 *   - userInfo: org/user fields from the login response (display only)
 *   - signIn(req): POST login → store BOTH tokens → update context
 *   - signOut(): best-effort server-side revoke (POST /auth/logout) → clear
 *     BOTH tokens from keychain → clear context
 *
 * SECURITY INVARIANTS (ADR-0010 + Slice 4M-REVOKE):
 *   - Tokens are sourced exclusively from expo-secure-store (never from params).
 *   - On sign-out: the refresh token is revoked server-side (best-effort) and
 *     both tokens are deleted from keychain and cleared from state.
 *   - On 401 from any API call (after api.ts's silent refresh-and-retry
 *     fails): callers invoke signOut() to clear state — unchanged contract.
 *   - A SILENT background refresh (triggered inside lib/api.ts, not here)
 *     updates this context's in-memory token via setAuthTokenListener, so
 *     the next screen read doesn't present a stale access token.
 *   - AUTH_SECRET never touches the device (it's the server's private key).
 *   - org_id never stored in context (comes from the signed token server-side).
 *
 * Navigation:
 *   When token is null and isLoading is false, the app renders the login screen.
 *   This is enforced in the root layout (src/app/_layout.tsx).
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { login as apiLogin, logout as apiLogout, AuthError, setAuthTokenListener } from '../lib/api';
import { getTokens, saveTokens, getRefreshToken, clearTokens } from '../lib/token-store';
import type { LoginRequest, LoginResponse } from '../lib/api';

// ─── Context shape ─────────────────────────────────────────────────────────────

export interface UserInfo {
  email: string;
  role: string;
  orgSlug: string;
  orgName: string;
}

export interface AuthContextValue {
  /** The stored bearer token, or null if not authenticated. */
  token: string | null;
  /** True while the initial keychain read is in progress on app launch. */
  isLoading: boolean;
  /** Display-only user/org info from the last successful login. */
  userInfo: UserInfo | null;
  /**
   * signIn — POSTs login credentials, stores the returned token in the
   * keychain, and updates the context.
   *
   * Throws AuthError on invalid credentials (callers show generic error copy).
   * Throws NetworkError if the device is offline.
   */
  signIn: (req: LoginRequest) => Promise<void>;
  /**
   * signOut — clears the token from the keychain and resets context.
   * Also called by the API client on 401 responses.
   */
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

interface AuthProviderProps {
  children: React.ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps): React.ReactElement {
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);

  // On mount: load any stored tokens from the keychain.
  // If an access token is present, the app proceeds to the schedule screen
  // (even if it has since expired — the first authenticated read will
  // silently refresh it via lib/api.ts's apiFetch).
  // If absent, it shows the login screen.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await getTokens();
        if (!cancelled) {
          setToken(stored.accessToken);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Register the token-update listener: a SILENT background refresh
  // (triggered inside lib/api.ts on a 401) calls this with the new access
  // token (or null on a hard failure) so this context's in-memory state
  // never presents a stale token to the next screen read.
  useEffect(() => {
    setAuthTokenListener((accessToken) => {
      setToken(accessToken);
      if (accessToken === null) {
        setUserInfo(null);
      }
    });
    return () => setAuthTokenListener(null);
  }, []);

  const signIn = useCallback(async (req: LoginRequest): Promise<void> => {
    // apiLogin throws AuthError on 401 or NetworkError on failure.
    let resp: LoginResponse;
    try {
      resp = await apiLogin(req);
    } catch (err) {
      if (err instanceof AuthError) {
        throw err; // Re-throw so the login screen shows a generic error.
      }
      throw err;
    }

    // Store BOTH tokens in the keychain (ONLY safe store). The refresh token
    // is never logged and is only ever sent to /auth/refresh or /auth/logout.
    await saveTokens({ accessToken: resp.accessToken, refreshToken: resp.refreshToken });

    // Update context.
    setToken(resp.accessToken);
    setUserInfo({
      email: resp.user.email,
      role: resp.user.role,
      orgSlug: resp.org.slug,
      orgName: resp.org.name,
    });
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    // Best-effort server-side revoke — a network failure here must never
    // block sign-out (the local tokens are cleared regardless).
    const refreshToken = await getRefreshToken();
    if (refreshToken) {
      await apiLogout(refreshToken);
    }

    await clearTokens();
    setToken(null);
    setUserInfo(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ token, isLoading, userInfo, signIn, signOut }),
    [token, isLoading, userInfo, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ─── Hook ──────────────────────────────────────────────────────────────────────

/**
 * useAuth — returns the AuthContext value.
 * Must be called inside an AuthProvider; throws if used outside.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
