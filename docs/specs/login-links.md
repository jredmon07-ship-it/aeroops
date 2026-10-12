# Login links

How a member added on the People page gets a login, and how an owner or manager resets
someone's password. No email is sent; the operator copies the link and sends it themselves.

## Flow

1. An owner or manager opens a member's profile and clicks **Create login link** (or
   **Create reset link** when the member already has a password).
2. `createLoginLink(session, { userId })` returns `/o/<slug>/login-link/<token>` and the
   expiry. The dialog shows the full URL (current origin + path), a Copy button, the expiry,
   and "Send this link to <name> yourself — AeroOps does not send email."
3. The member opens the link. `checkLoginLink({ slug, token })` decides whether to show the
   set-password form or "This link is no longer valid… ask for a new one."
4. They submit a password + confirmation. `acceptLoginLink({ slug, token, password })` sets or
   replaces their `auth_credential` and they are sent to `/o/<slug>/login?notice=password-set`.

Code: `packages/api/src/auth/login-link-token.ts` (token), `packages/api/src/people/login-link.ts`
(create/check/accept), `apps/web/app/o/[slug]/login-link/[token]/` (public page),
`apps/web/app/o/[slug]/(shell)/people/_components/login-link-button.tsx` (profile button).

## Token

Stateless; no table and no migration.

- Same `@auth/core` JWE (A256CBC-HS512) and `AUTH_SECRET` as the web session and mobile token,
  but its own salt (`aeroops.login-link`). The salt is part of the key derivation, so a session
  or mobile token cannot be decrypted as a login link, and a login link cannot be decrypted as
  either of those.
- Claims: `purpose: 'login-link'` (checked explicitly), `userId`, `orgId`, `fp`, plus
  `iat` / `exp` / `jti`. `exp` is 7 days.
- `fp` is a sha256 of the member's current `auth_credential.password_hash`, or of a fixed
  marker when they have none. Accepting a link changes the hash, so the fingerprint in every
  earlier link (including the one just used) stops matching. That is what makes links
  single-use. The token is encrypted and only holds a digest of the hash, never the hash.

## Rules

- `createLoginLink` requires `people:manage` (owner, manager) and audits
  `member.login_link_created` with `{ mode, expiresAt }`. The token is never logged.
- **Privilege rule** (`loginLinkPermission`): an owner may create a link for anyone in the org,
  themselves included. Anyone else with `people:manage` may not create a link for a member who
  also holds `people:manage` (owner or manager). Without this, a manager could reset an
  owner's password and take over the account.
- **Self links:** owners only. There is no change-password screen yet, so this is how an owner
  changes their own password. A manager asks an owner.
- Deactivated members (`app_user.status = 'inactive'`) cannot get a link, and a link made
  before deactivation stops working.
- The shared demo orgs (when `AEROOPS_DEMO_RESET_ENABLED` is on) refuse link creation, since
  every visitor uses the same credentials.
- `acceptLoginLink` is unauthenticated: the token is the credential. It verifies the token,
  resolves the org from the URL slug and requires it to be the token's org and active, then
  inside `withOrgContext` locks the member row, re-checks they are still an active member and
  the fingerprint still matches, and inserts or updates the one credential row. It uses the
  same password policy (`newPasswordSchema`, 10–200 characters) and argon2id hashing as signup.
  It audits `member.login_link_accepted` with `{ mode, mobileSessionsRevoked }`.
- Every failure (bad, tampered, expired, used, wrong org, suspended org, member removed or
  deactivated) returns the same `invalid_link` result. A too-short or too-long password is
  the one specific error, and it does not use up the link.
- The link page is `noindex` and sends no `Referer`.

## Sessions: known limitation

Accepting a link revokes the member's **mobile** refresh sessions (`mobile_session`) in the
same transaction, so a reset signs their phones out within the 15-minute access-token window.

**Web** sessions are stateless JWTs with an 8-hour lifetime and no server-side session list,
so they cannot be revoked. A browser that was already signed in as that member stays signed in
until its session expires. Closing this needs a session-version or revocation check in the JWT
callback, which would need a schema change.

## Not included

- Sending email or SMS.
- A list of outstanding links or a way to cancel one. Using any link, or the member changing
  their password, cancels all of them. Deactivating the member also stops them working.
- Making `status = 'inactive'` block sign-in with an existing password (still a roster flag
  only, `[VERIFY-6-D]`).
