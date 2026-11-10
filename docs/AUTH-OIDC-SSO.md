# Central OIDC SSO (Keycloak) — only login

This app is a standard **OIDC Relying Party** of the TPS18 central Keycloak SSO.
**Keycloak is the only login method.** There is no Google OAuth chooser, password
form, app-hosted passkey/WebAuthn, or DEV test-login panel.

Passkeys are registered/removed via **Keycloak application-initiated actions (AIA)**
on the normal authorize endpoint (`kc_action`), not the Keycloak account console
(blocked for end users).

Issuer hosts realms under `https://auth.tps18.space` named `tps18-dev` /
`tps18-sit` / `tps18-uat` / `tps18-prod`. **Never hardcode** the issuer or realm —
configure per environment via `OIDC_ISSUER`.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `OIDC_ISSUER` | **yes** | e.g. `https://auth.tps18.space/realms/tps18-dev` |
| `OIDC_CLIENT_ID` | **yes** | Confidential client id |
| `OIDC_CLIENT_SECRET` | **yes** | Client secret |
| `OIDC_TRUST_IDP_EMAIL` | no | Default `true`. Link existing users by email without requiring app `emailVerified`. When `false`, require IdP `email_verified`; if unverified and an account already exists → clear error (no duplicate). |
| `OIDC_PASSKEY_ADD_ACTION` | no | AIA for add passkey (default `webauthn-register-passwordless`) |
| `OIDC_ADMIN_CLIENT_ID` | no | Service-account client to **list** own passkeys via Admin API |
| `OIDC_ADMIN_CLIENT_SECRET` | no | Service-account secret (with admin client) |
| `OIDC_PASSKEY_MANAGE_URL` | no | Optional external help URL only (no account-console default) |
| `APP_BASE_URL` (or `NEXT_PUBLIC_APP_URL` / `BETTER_AUTH_URL` / `RENDER_EXTERNAL_URL`) | yes for redirects | Public base URL |
| `SUPERADMIN_EMAILS` | recommended | Comma-separated emails promoted to `superadmin` when they match an OIDC-verified email |
| `BETTER_AUTH_SECRET` | yes | Session signing |

When any of `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` is missing,
**SSO is not configured**: `/login` shows a clear error page, the failure is
logged, and there is **no** fallback login.

## Redirect URIs (register in Keycloak)

| Env | Example issuer | Redirect URI | Post-logout URI |
|---|---|---|---|
| local | `…/realms/tps18-dev` | `{APP_BASE_URL}/api/auth/oidc/callback` | `{APP_BASE_URL}/logged-out` |
| DEV/SIT/UAT/PROD | `…/realms/tps18-{env}` | same pattern | same pattern |

Pattern: `https://auth.tps18.space/realms/tps18-{env}` where `{env}` is
`dev` | `sit` | `uat` | `prod`.

### Why `/logged-out` (not `/login`) for post-logout

`/login` immediately starts the OIDC authorize redirect. Using it as
`post_logout_redirect_uri` would auto-loop users back into Keycloak after logout.
`/logged-out` is a static confirmation page with a **manual** “sign in again” link.

## Login / logout behaviour

1. Visit `/login` (or any gated page/API that sends the user to login) → **302**
   straight to Keycloak `authorization_endpoint` with PKCE S256, `state`, `nonce`.
2. Callback validates ID token (JWKS), maps `(issuer, sub)` in `identities`,
   else links by case-insensitive email (see `OIDC_TRUST_IDP_EMAIL`), else
   creates a user — all in one transaction with `ON CONFLICT` (no duplicate-key
   loops). Sets `user.emailVerified=true` on link; keeps role/plan/superadmin.
3. API calls without a session return **401** with `code: "AUTH_REQUIRED"`;
   the FE navigates to `/login?next=<current path>` (open redirects rejected by
   `safeOidcReturnTo`).
4. Logout → `GET|POST /api/auth/oidc/logout` clears the app session, then
   RP-initiated logout at `end_session_endpoint` with `id_token_hint` and
   `post_logout_redirect_uri={APP_BASE_URL}/logged-out`.
5. `/login?error=…` shows a Thai error page with retry + Keycloak logout links
   and **never** auto-redirects. A `docx_oidc_fail` cookie stops auto-redirect
   after 2+ failures within 60s (loop breaker).

## Passkeys (Keycloak AIA)

1. **Add** — `GET /api/auth/oidc/passkey/add` (session required) starts authorize with
   PKCE S256, `state`, `nonce`, `scope=openid`, same `redirect_uri` as login, and
   `kc_action` from `OIDC_PASSKEY_ADD_ACTION` (default `webauthn-register-passwordless`).
   Return path defaults to `/account`.
2. **Remove** — `GET /api/auth/oidc/passkey/remove?credentialId=…` (session required;
   `credentialId` validated) uses `kc_action=delete_credential:<id>`.
3. **List** — `GET /api/auth/oidc/passkey` calls Keycloak Admin API
   `{issuerOrigin}/admin/realms/{realm}/users/{sub}/credentials` with a
   **service-account** `client_credentials` token (`OIDC_ADMIN_CLIENT_ID` /
   `OIDC_ADMIN_CLIENT_SECRET`). Filters `type=webauthn-passwordless`. Uses the
   signed-in user's own `sub` from `identities` — never from request input.
   Tokens never reach the browser. If admin env is unset → hide list; keep Add.
4. **Callback** — accepts `kc_action_status=success|cancelled|error`, completes
   login normally when a code is present, then redirects to `/account?passkey=…`
   (Thai status message in the account UI).

## App routes

| Method | Path | Notes |
|---|---|---|
| GET | `/login` | Immediate OIDC redirect (or SSO-not-configured page) |
| GET | `/logged-out` | Post-logout landing (no auto-loop) |
| GET | `/api/auth/oidc/login` | Same authorize start (API/FE helper) |
| GET | `/api/auth/oidc/callback` | Code callback (+ optional `kc_action_status`) |
| GET/POST | `/api/auth/oidc/logout` | RP logout |
| GET | `/api/auth/oidc/passkey/add` | AIA register passkey (session) |
| GET | `/api/auth/oidc/passkey/remove` | AIA delete passkey (session) |
| GET | `/api/auth/oidc/passkey` | List own passkeys (Admin API; optional) |
| GET | `/api/auth-config` | Paths + `passkeyListEnabled` |

Removed (404): `/api/dev/test-accounts`, `/api/dev/test-login`, `/api/auth/dev/*`,
`/api/auth/passkey` (+ `/*` — legacy Better Auth), social OAuth callbacks.
App-hosted passkey tables are left in place but unused (no drop migrations).

## Roles

App DB roles (`user` / `admin` / `superadmin`) stay local. On user create / boot,
`SUPERADMIN_EMAILS` matching an OIDC-verified email still promotes to
`superadmin` via `ensureSuperAdmins` (no destructive user-table migrations).

## Keycloak client settings

- Confidential client, Standard flow on, Direct access grants off
- Valid redirect URIs: `{APP_BASE_URL}/api/auth/oidc/callback`
- Valid post logout redirect URIs: `{APP_BASE_URL}/logged-out`
- PKCE S256 required
- Scopes: `openid email profile` (login); AIA uses `openid`
- Enable AIA actions: `webauthn-register-passwordless`, `delete_credential`
- Admin service-account client (optional list): realm-management roles to read
  user credentials for the realm derived from `OIDC_ISSUER`
