# Slice 4M — Mobile foundation (Expo, iOS first) — build spec

## Conductor decisions (2026-06-19) — RESOLVED. ADR-0010.
- **Mobile auth = a thin token façade over the EXISTING auth core (ADR-0010).** New additive Node-runtime
  Route Handlers under `apps/web/app/api/mobile/v1/*`. The device CANNOT import `@aeroops/api`/`@aeroops/db`
  (Node-only) and CANNOT use cookie sessions — it holds a bearer token in `expo-secure-store`.
- **ONE secret, ONE token format.** Mint/verify the mobile token with `next-auth/jwt` `encode`/`decode`
  using the SAME `AUTH_SECRET` and the SAME claim shape the web JWT carries: `{ userId, orgId, slug, role,
  email }`. No second secret, no parallel JWT lib. 8h `exp` (mirror web `maxAge`); NO refresh token in 4M
  (re-login on expiry — refresh/revocation deferred).
- **Security primitives are single-sourced.** Extract the login orchestration into ONE shared
  `verifyLoginAndIssueClaims(db, {slug,email,password}) → claims | null` in `@aeroops/api` that BOTH the web
  Credentials `authorize` callback AND the mobile login route call (web adopts it, BEHAVIOR-PRESERVING).
  It runs the identical pipeline: `resolveOrgBySlug` → `status==='active'` → `verifyCredential` (argon2 +
  anti-enumeration, org-scoped, RLS). NEVER reimplement a security primitive.
- **org_id is ONLY ever a signed-token claim** — never read from request body/query/header in a trusted
  position. Reads go through the EXISTING gated `listReservations`/`listResources` (requireCapability + RLS
  fire inside, unchanged). Route handlers are TRANSPORT ADAPTERS ONLY: no SQL, no `@aeroops/db`, no
  `withOrgContext` directly.
- **DTOs in `@aeroops/core`** (RN-safe, shared by device + route): `MobileLoginRequest/Response`,
  `MobileScheduleResponse`, `MobileReservationDTO` (Dates → ISO strings; org_id ABSENT from the wire body).
- **Expo app** (`apps/mobile`): managed workflow, TS, Expo Router; depends on `@aeroops/core` ONLY (boundary
  enforced by absence + reviewer). Token lives ONLY in `expo-secure-store`; `AUTH_SECRET` NEVER in the bundle.
- Sub-slice **4M.1 (auth + API skeleton) → 4M.2 (read-only schedule)**. NO write/dispatch/money/schema/
  migration. Additive only; web cookie-session auth + FROZEN engines byte-untouched.
- **VERIFICATION CEILING:** mobile cannot run in CI (no simulator). The route handlers + token + isolation are
  fully CI-testable (the spine). The RN screens get a HUMAN device gate in DoD. **[VERIFY-4M-DEPLOY-1]: an
  end-to-end device demo against a deployed backend is BLOCKED on the open 0.4 deploy gap** (no provisioned
  Postgres / deployed origin) — buildable + CI-testable now regardless.

## Security parity (must hold — identical to web)
argon2 verification, anti-enumeration timing, org resolution, suspended-org gate, org_id-from-signed-JWT,
AUTH_SECRET signing, `withSessionOrgContext`→RLS, `requireCapability`-first, `isMembershipRole` fail-closed —
ALL reused, not forked. A tampered/expired token → 401 (decode fails / exp); garbage role → stripped →
UnauthenticatedError. [VERIFY-4M-SEC-1] 8h non-revocable bearer OK for READ-ONLY; instant-revocation/refresh is
a HARD predecessor before any mobile write/dispatch/payment slice. [VERIFY-4M-SEC-2] rate-limit/WAF on the
login route before distribution.

## 4M.1 — Auth + API skeleton (VERIFIABLE half first)
**`@aeroops/api` (server-side):**
- Extract `verifyLoginAndIssueClaims(db, parsed)` (the shared pipeline); refactor the web Credentials
  `authorize` callback to call it (BEHAVIOR-PRESERVING — existing auth tests stay byte-identical green).
- `signMobileToken(claims) → string` + `verifyMobileToken(token) → claims | null` (thin wrappers over
  `next-auth/jwt` encode/decode, `process.env['AUTH_SECRET']`, 8h exp, same claim shape; refuse the
  build-placeholder secret like `auth.ts`) + `sessionFromMobileClaims(claims) → AppSession` (validate role via
  `isMembershipRole`; missing role → no role → fail-closed). Reuse the existing `loginSchema`.
- Barrel-export what the route needs.
**`apps/web/app/api/mobile/v1/auth/login/route.ts`** (Node runtime): parse body with `loginSchema` (invalid →
generic 401); `verifyLoginAndIssueClaims`; null → generic `401 {error:'invalid_credentials'}` (no which-step
leak); else `signMobileToken` → `200 { token, expiresAt, org:{slug,name}, user:{email,role} }`. Never return
password_hash or cross-org data.
**Expo skeleton (`apps/mobile`, typecheck/build-only — human device gate):** workspace + tsconfig/Metro wiring
(watchFolders=repo root; cannot resolve `@aeroops/api`/`@aeroops/db`); `expo-secure-store` token store (the ONLY
token home; never logged); session context (token/signIn/signOut/isAuthed); login + sign-out screens (generic
error on failure — anti-enumeration UX, `slug` field mirrors `/o/[slug]/login`); API base from
`EXPO_PUBLIC_API_BASE_URL`; define `typecheck`/`lint`/`test` scripts so `pnpm -r` fans out cleanly (NOT a device
launch in default build/test).
**Tests (CI-verifiable spine):** login happy → 200 + decodable claims; failure matrix (wrong password / unknown
email / unknown slug / suspended org / no-membership) ALL return byte-identical generic 401; token round-trip
(sign→verify same claims; tampered→null; expired(past exp)→null; foreign-secret→null); `verifyLoginAndIssueClaims`
PARITY with the web authorize path (same input → same claims — guards drift); RN unit: token-store get/set/delete
(mock secure-store), client injects Bearer + clears token on 401, login form generic-error rendering.

## 4M.2 — Read-only schedule (after 4M.1)
**`GET /api/mobile/v1/schedule?from=ISO&to=ISO`** (Node runtime): Bearer → `verifyMobileToken` (bad/expired →
401); `sessionFromMobileClaims`; validate from/to (zod, cap ≤31d → 400); call EXISTING `listReservations(session,
{from,to})` + `listResources(session)` UNCHANGED (requireCapability('schedule:access') + RLS fire inside); map to
`MobileScheduleResponse` (Dates→ISO, org_id absent); Forbidden→403, Unauthenticated→401, else→500 (no internal
detail). **`MobileReservationDTO`/`MobileResourceDTO` in `@aeroops/core`** (serialized projection; device also
zod-parses defense-in-depth). **`apps/mobile`** `schedule.tsx` day list (read-only). **Tests:** the headline
TENANT-ISOLATION test (Org-A token → ONLY Org-A reservations even with Org-B overlapping-window data; body/query
org_id ignored); authz (no schedule:access → 403; garbage role → 401); DTO serialization (Date→ISO, org_id absent
from wire). Human device gate: see the seeded org's day, confirm only that org's data.

## Edge cases
Expired/tampered token → 401, app clears secure-store → /login. Garbage/absent role → fail-closed 401. Tenant
mismatch impossible (org from token only; a future slug param MUST be checked vs the token slug). No-membership/
suspended/wrong-org → generic 401 at login. Offline → offline state, NO trusted cached tenant data in 4M. Device
clock skew irrelevant (server-signed/verified exp). Window too large → 400. Placeholder AUTH_SECRET → fail-fast.

## Invariants
org_id only ever a signed-token claim; device imports `@aeroops/core` ONLY; one secret/one token format;
security primitives single-sourced (login orchestration shared via `verifyLoginAndIssueClaims`); reads go through
existing gated reads (no SQL in route handlers); no write/money/schema/migration; token only in expo-secure-store,
never logged, AUTH_SECRET never in bundle; anti-enumeration single generic 401 end-to-end; web cookie-session auth
+ FROZEN engines byte-untouched.

## Compliance: LIGHT — 4M touches no records/regs/meters/currency; read-only schedule over a new transport. Confirm
the schedule DTO exposes nothing beyond the already-cleared `listReservations` projection. No money.
