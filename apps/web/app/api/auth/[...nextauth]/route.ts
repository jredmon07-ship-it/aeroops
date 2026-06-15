/**
 * app/api/auth/[...nextauth]/route.ts
 *
 * Auth.js v5 catch-all route handler.
 * Destructures GET and POST from the handlers object returned by NextAuth.
 *
 * Auth.js handles all auth-related requests through this route:
 *   GET  /api/auth/session      — returns the current session
 *   POST /api/auth/signin       — initiates sign-in
 *   POST /api/auth/signout      — invalidates the session
 *   GET  /api/auth/csrf         — returns the CSRF token
 *   GET  /api/auth/providers    — lists configured providers
 *   GET  /api/auth/callback/:p  — OAuth callback (unused — credentials only)
 */
import { handlers } from '@/auth';

export const { GET, POST } = handlers;
