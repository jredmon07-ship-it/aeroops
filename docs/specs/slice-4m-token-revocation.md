# Slice 4M-REVOKE — Mobile token revocation ([VERIFY-4M-SEC-1] predecessor) — build spec

**SECURITY-SENSITIVE — human-reviewed by the maintainer.** Replaces the Slice 4M.1 8h non-revocable mobile bearer
token with SHORT-LIVED signed access tokens (~15 min) + a revocable, rotating refresh-token session
(`mobile_session`, migration 0033, staged/human-gated, NOT applied). **Adds NO new write/dispatch/money surface** —
login/refresh/logout only. This is the HARD PREDECESSOR the 4M.1 spec called out ("[VERIFY-4M-SEC-1] instant-
revocation/refresh is a HARD predecessor before any mobile write/dispatch/payment slice") — it exists purely to make
the mobile session instantly revocable so that a FUTURE, SEPARATE, maintainer-gated slice can safely add a mobile write
surface.

## What changed vs. Slice 4M.1

| | 4M.1 (before) | 4M-REVOKE (this slice) |
|---|---|---|
| Access token | 8h JWE, non-revocable | SAME JWE format/claims/AUTH_SECRET, now 15 min (`MOBILE_ACCESS_TOKEN_MAX_AGE_SECONDS`) |
| Session state | none (stateless only) | `mobile_session` table: one row per issued/rotated refresh token |
| Revocation | impossible before 8h expiry | instant — logout, admin revoke-all, or automatic on theft detection |
| Refresh | re-login on expiry | `POST /auth/refresh` rotates to a new access+refresh pair |
| Read routes (`verifyMobileToken`) | unchanged | **UNCHANGED** — still verifies the same JWE claim shape |
| Web NextAuth cookie session | unchanged | **UNCHANGED, byte-identical** (`auth-config.ts` / `verifyLoginAndIssueClaims` untouched) |

## The security model

**Standard short-access + rotating-refresh.** The access token stays a stateless signed JWE (unchanged shape/
verification — `verifyMobileToken` is byte-identical) but now expires in ~15 minutes instead of 8 hours. A stateless
token can never be revoked mid-flight, so keeping it short-lived bounds the blast radius of a stolen access token to
minutes. The ONLY way to get a new access token is a refresh, and refresh IS checked against a database row
(`mobile_session`) — that database row is what is actually revocable.

**Refresh token**: an opaque 256-bit random string (`node:crypto.randomBytes(32)` → base64url), returned to the
client EXACTLY ONCE (at login or at each refresh). The server never stores the raw value — only a **sha256 hash**
of it, in `mobile_session.refresh_token_hash` (globally `UNIQUE`).

### Hashing choice: sha256, not argon2 — deliberate

`packages/api/src/auth/hash.ts` (argon2id) is the *right* tool for **passwords**: low-entropy, human-chosen secrets
need a slow, salted, memory-hard function to resist offline brute force, and verification is a single known-candidate
compare. A refresh token is the *opposite* shape: 256 bits of output from `randomBytes` — an offline brute-force/
dictionary attack against that keyspace is already computationally infeasible regardless of hash speed. What refresh
DOES need is an **O(1) equality lookup by hash** (the `mobile_session_refresh_token_hash_unique` index) — impossible
with argon2's per-call random salt, which would force an O(n) re-hash-and-compare against every stored row. sha256 is
deterministic (enables the index), fast (no artificial per-refresh latency), and loses no real security given the
token's own entropy already defeats brute force. This mirrors how GitHub/Stripe-style opaque API/session tokens are
stored (a fast hash of a high-entropy token) — a different, and correct, precedent from password storage.

### Rotation + reuse detection (fail-closed)

Every successful refresh **consumes** the presented refresh token and issues a brand-new access+refresh pair, in one
transaction: the OLD `mobile_session` row gets `rotated_to_id = <new row id>` and `revoked_at = now()`. A refresh
token can only ever be used once.

If a refresh token is presented whose row **already** has `rotated_to_id` set — i.e. it was already consumed — that
is definitive evidence of **replay** (a bug, or, far more likely, theft of a stored/leaked refresh token).
`refreshMobileSession` responds by walking the rotation chain **forward** from that row (via `rotated_to_id`) and
revoking every not-yet-revoked descendant, then returns `null`. This logs out the **entire chain**, including
whatever device currently holds the newest (otherwise still-valid) token — a deliberate fail-closed, forces-
re-login response to a theft signal, never a convenience-preserving one.

**Anti-enumeration**: `refreshMobileSession` returns `null` (→ the route's generic 401 `invalid_refresh_token`) for
**every** failure case — unknown hash, expired, plainly revoked (logout), reused (theft) — all indistinguishable to
the caller.

**Defensive checks on every refresh** (an improvement over the 4M.1 8h token, which had no way to react mid-flight):
the org must still be `status = 'active'`, and the user must still hold a `membership` row in that org. Either
missing → refresh fails closed (`loadMobileClaims` in `mobile-session.ts`).

## Schema — migration 0033 (STAGED, human-gated, NOT applied)

`mobile_session (id, org_id, user_id, refresh_token_hash UNIQUE, device_label, issued_at, expires_at, last_used_at,
revoked_at, rotated_to_id)`. Tenant-scoped, `ENABLE + FORCE` RLS, standard 4-policy mutable shape **plus** a
platform-admin SELECT admit (mirrors `calendar_feed_select` / `payment_intent_record_select`): the refresh/logout
path must find a row by its hash **before** any org context is known (same justification as `resolveOrgBySlug` /
`resolveFeedByToken`). Every WRITE (insert at login, rotate/revoke at refresh/logout, chain-revoke on reuse) happens
only inside `withOrgContext` using the org_id **that same lookup resolved from our own table** — never from caller
input, never via platform-admin for a write. Composite FKs: `org_id → org(id)` CASCADE; `(user_id, org_id) →
app_user(id, org_id)` CASCADE (a session has no meaning once its user is gone); `(rotated_to_id, org_id) →
mobile_session(id, org_id)` SET NULL (self-referencing rotation-chain pointer; no purge job exists yet — forward
seam).

## Code map

- `packages/api/src/auth/mobile-token.ts` — `MOBILE_ACCESS_TOKEN_MAX_AGE_SECONDS` (15 min, was 8h); `signMobileToken`
  / `verifyMobileToken` / `sessionFromMobileClaims` **unchanged in shape**.
- `packages/api/src/auth/resolve-mobile-session.ts` — `resolveMobileSessionByHash` (the one sanctioned
  platform-admin read, mirrors `resolve-feed.ts` / `resolve-org.ts`).
- `packages/api/src/auth/mobile-session.ts` — `issueMobileSession` (login), `refreshMobileSession` (rotate +
  reuse-detection), `revokeMobileSession` (logout, idempotent), `revokeAllMobileSessionsForUser` (self or
  `people:manage` admin action; NOT wired to a route yet — a tested building block for a future "sign out other
  devices" surface), `generateRefreshToken` / `hashRefreshToken`. Each mutation is audited
  (`mobile.session_issued` / `_refreshed` / `_revoked` / `_revoked_all` / `_reuse_detected`).
- `apps/web/app/api/mobile/v1/auth/login/route.ts` — now calls `issueMobileSession`; response adds
  `accessToken/accessExpiresAt/refreshToken/refreshExpiresAt` (was `token/expiresAt`).
- `apps/web/app/api/mobile/v1/auth/refresh/route.ts` **(new)** — `POST { refreshToken } → 200 pair | 401
  invalid_refresh_token`.
- `apps/web/app/api/mobile/v1/auth/logout/route.ts` **(new)** — `POST { refreshToken } → 200 { ok:true }` always
  (idempotent; no secret to protect on the failure path).
- `apps/mobile/src/lib/token-store.ts` — now stores both tokens (`aeroops_access_token` /
  `aeroops_refresh_token`), both expo-secure-store only.
- `apps/mobile/src/lib/api.ts` — `apiFetch` retries a 401 exactly once via a single-flight-guarded silent refresh
  (`ensureFreshToken`/`performRefresh`); on refresh failure or a second 401, throws `AuthError` (existing screens
  already call `signOut()` on `AuthError` — **zero screen changes needed**). `setAuthTokenListener` bridges a
  silent background refresh back into `AuthContext`'s in-memory token.
- `apps/mobile/src/contexts/AuthContext.tsx` — `signIn` stores both tokens; `signOut` best-effort calls
  `POST /auth/logout` then clears both tokens (never blocks on a network failure).

## What this unblocks (NOT built here — separate, maintainer-gated)

A mobile **write** slice (dispatch check-out/in, squawk reporting, etc.) may now be proposed, because the
instant-revocation predecessor is in place: an operator can kill a lost/stolen device's session and it stops working
within ~15 minutes at the outside (immediately, if the device is offline and never gets to refresh). That write
slice is **explicitly out of scope here** and requires its own spec + maintainer go-ahead.

## Maintainer device-test step (before treating this as production-ready)

This slice is fully CI-testable (pglite) but the end-to-end mobile flow needs a human device pass once a backend is
deployed ([VERIFY-4M-DEPLOY-1], pre-existing):
1. Log in on-device → confirm the schedule loads.
2. Use the app normally past the 15-minute access-token window → confirm a silent refresh (no re-login prompt).
3. Sign Out → confirm the app returns to login AND the revoked refresh token is rejected by `/auth/refresh`
   (e.g. via a direct API call) — proves server-side revocation actually took effect, not just local state clearing.
4. (Optional, harder to stage on one device) Simulate token theft: capture a refresh token, use it once
   successfully, then replay the SAME (now-rotated) token — confirm BOTH the replay and the legitimate device's
   next refresh are rejected (the fail-closed chain-revoke).

## [VERIFY] flags

- **[VERIFY-4M-SEC-1] — this slice.** Predecessor complete for READ-ONLY mobile. A mobile WRITE/dispatch/payment
  slice still needs its own review before it ships — this only removes the "8h non-revocable" blocker.
- **[VERIFY-4M-SEC-2]** (pre-existing, unchanged) — rate-limit/WAF on `/auth/login`, and now also `/auth/refresh`
  (a refresh-token brute-force target, though the 256-bit keyspace makes brute force infeasible; rate-limiting is
  still prudent operational hygiene before wide distribution).
- **[VERIFY-4M-DEPLOY-1]** (pre-existing, unchanged) — an end-to-end device demo is blocked on a deployed backend.
- No new regulatory/records/billing surface — compliance posture is unchanged from 4M.1 (read-only schedule/fleet/
  squawks/alerts over a now-revocable transport).

## Deviations from the task brief

- `revokeAllMobileSessionsForUser` is built and tested but **not wired to any route/UI** in this slice (no consumer
  exists yet) — kept as a tested building block, consistent with "adds NO write surface" (there is no new mutation
  a client can trigger through it today).
- The Expo `AuthContext`'s public field name `token` was kept (now holding the *access* token) rather than renamed
  to `accessToken`, so the five existing screens that already read `useAuth().token` needed zero changes — a
  smaller, more reviewable diff for a security-sensitive slice.
