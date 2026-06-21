/**
 * contexts/AuthContext.tsx — Authentication context for the AeroOps mobile app.
 *
 * Provides:
 *   - token: the stored bearer token (null if not authenticated)
 *   - isLoading: true while the initial keychain read is in progress
 *   - userInfo: org/user fields from the login response (display only)
 *   - signIn(req): POST login → store token → update context
 *   - signOut(): clear token from keychain → clear context
 *
 * SECURITY INVARIANTS (ADR-0010):
 *   - Token is sourced exclusively from expo-secure-store (never from params).
 *   - On sign-out: token deleted from keychain and cleared from state.
 *   - On 401 from any API call: callers invoke signOut() to clear state.
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
import { login as apiLogin, AuthError } from '../lib/api';
import { getToken, saveToken, deleteToken } from '../lib/token-store';
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

  // On mount: load any stored token from the keychain.
  // If present, the app proceeds to the schedule screen.
  // If absent, it shows the login screen.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await getToken();
        if (!cancelled) {
          setToken(stored);
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

    // Store the token in the keychain (ONLY safe store).
    await saveToken(resp.token);

    // Update context.
    setToken(resp.token);
    setUserInfo({
      email: resp.user.email,
      role: resp.user.role,
      orgSlug: resp.org.slug,
      orgName: resp.org.name,
    });
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    await deleteToken();
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
