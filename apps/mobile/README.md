# AeroOps Mobile — Expo (iOS first)

Slice 4M — secure login + read-only schedule.

## What is built

- Login screen: org slug + email + password — POST to the mobile auth API.
- Token stored in **expo-secure-store** (OS keychain). Never in AsyncStorage or plaintext.
- Schedule screen: 7-day read-only view of reservations (tail number, time window, status).
- All auth states: loading / empty / list / error / offline.
- Automatic 401 handling: expired/revoked token clears keychain and redirects to login.

## Prerequisites

- Node >= 20, pnpm 9.x
- Expo CLI: `npm install -g expo-cli` (or `npx expo`)
- iOS: Xcode + Simulator, or a physical device with Expo Go
- Android: Android Studio emulator, or a physical device with Expo Go

## Environment

**Required before running:**

```
EXPO_PUBLIC_API_BASE_URL=https://your-deployed-backend.com
```

Create `apps/mobile/.env.local` with the variable above pointing at the deployed
AeroOps backend.

**[VERIFY-4M-DEPLOY-1]**: an end-to-end device demo against a live backend is BLOCKED
until the AeroOps backend is deployed to a reachable origin (Neon Postgres + Vercel /
equivalent). This is the founder's step. See `DEPLOY.md` at the repo root.

Do NOT commit `.env.local`. The `EXPO_PUBLIC_` prefix makes this safe to bundle
(it is a URL, not a secret). The token (signed JWT) lives only in expo-secure-store.

## Running locally (simulator)

```bash
# From the repo root:
pnpm --filter @aeroops/mobile start
# or from apps/mobile:
cd apps/mobile && npx expo start
```

Then press `i` for iOS simulator or `a` for Android emulator.

**[VERIFY-4M-DEPLOY-1]**: the simulator runs on macOS. The API base URL for a local
Next.js dev server is `http://localhost:3000`. For Android emulator, use
`http://10.0.2.2:3000` instead (Android does not map `localhost` to the host machine).

## Typecheck

apps/mobile is excluded from the pnpm workspace, so it installs and typechecks on
its own (this is exactly what the `mobile-typecheck` CI job runs):

```bash
cd apps/mobile
pnpm install --frozen-lockfile --ignore-workspace
pnpm run typecheck
```

The typecheck also covers the `packages/core` source the app imports. Core's `zod`
import resolves to apps/mobile's own copy (see `paths` in `tsconfig.json`), so no
root install is needed.

## Security notes (ADR-0010)

- The bearer token lives ONLY in `expo-secure-store` (keychain-backed).
- `AUTH_SECRET` (the signing key) is NEVER in the bundle or device storage.
- org_id is NEVER sent from the client — it comes from the signed token server-side.
- All auth failures show a generic error (anti-enumeration).
- This slice is READ-ONLY. Write operations (dispatch, booking) require the
  instant-revocation / token-refresh predecessor [VERIFY-4M-SEC-1] before they can
  ship in a future slice.

## Scope — what is NOT here

- Push notifications (future slice)
- Deep links beyond login/schedule (future slice)
- Any write operation (dispatch check-out/in, booking, etc.) — deferred
- Android-specific icon / splash assets

## Device verification (founder step)

The typecheck (`tsc --noEmit`) passes in CI. Running on a device or simulator
requires the deployed backend ([VERIFY-4M-DEPLOY-1]) and is the founder's gate
before treating this slice as fully done.
