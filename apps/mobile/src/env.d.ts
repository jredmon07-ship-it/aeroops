/**
 * env.d.ts — Type declarations for Expo public environment variables.
 *
 * Expo's Metro transform inlines EXPO_PUBLIC_* variables at bundle time.
 * This declaration makes `process.env.EXPO_PUBLIC_API_BASE_URL` type-safe
 * without importing Node's full `process` global (which is not available
 * at runtime in React Native).
 *
 * SECURITY: Only EXPO_PUBLIC_* variables (non-secret) belong here.
 *           Never add AUTH_SECRET or any server-side secret.
 *
 * Reference: https://docs.expo.dev/guides/environment-variables/
 */

declare const process: {
  env: {
    /**
     * Base URL of the deployed AeroOps backend.
     * Set in apps/mobile/.env.local (NOT committed to source).
     * Example: https://aeroops.example.com
     *
     * [VERIFY-4M-DEPLOY-1]: requires a deployed backend origin.
     * For local dev: http://localhost:3000 (iOS sim) or http://10.0.2.2:3000 (Android emu).
     */
    EXPO_PUBLIC_API_BASE_URL?: string;
    NODE_ENV: 'development' | 'test' | 'production';
    [key: string]: string | undefined;
  };
};
