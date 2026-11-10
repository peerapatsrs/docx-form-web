# Central OIDC SSO (Keycloak) — only login

This app is a standard **OIDC Relying Party** of the TPS18 central Keycloak SSO.
**Keycloak is the only login method.** There is no Google OAuth chooser, password
form, app-hosted passkey/WebAuthn, or DEV test-login panel. Passkeys are managed
in Keycloak’s account console (see `OIDC_PASSKEY_MANAGE_URL`).

Issuer hosts realms under `https://auth.tps18.space` named `tps18-dev` /
`tps18-sit` / `tps18-uat` / `tps18-prod`. **Never hardcode** the issuer or realm —
configure per environment via `OIDC_ISSUER`.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `OIDC_ISSUER` | **yes** | e.g. `https://auth.tps18.space/realms/tps18-dev` |
| `OIDC_CLIENT_ID` | **yes** | Confidential client id |
| `OIDC_CLIENT_SECRET` | **yes** | Client secret |
| `OIDC_PASSKEY_MANAGE_URL` | no | Override Keycloak passkey management URL. Default: `${OIDC_ISSUER}/account/#/account-security/signing-in` |
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
   optionally links by `email_verified`, creates Better Auth session.
3. API calls without a session return **401** with `code: "AUTH_REQUIRED"`;
   the FE navigates to `/login?next=<current path>` (open redirects rejected by
   `safeOidcReturnTo`).
4. Logout → `GET|POST /api/auth/oidc/logout` clears the app session, then
   RP-initiated logout at `end_session_endpoint` with `id_token_hint` and
   `post_logout_redirect_uri={APP_BASE_URL}/logged-out`.

## App routes

| Method | Path | Notes |
|---|---|---|
| GET | `/login` | Immediate OIDC redirect (or SSO-not-configured page) |
| GET | `/logged-out` | Post-logout landing (no auto-loop) |
| GET | `/api/auth/oidc/login` | Same authorize start (API/FE helper) |
| GET | `/api/auth/oidc/callback` | Code callback |
| GET/POST | `/api/auth/oidc/logout` | RP logout |
| GET | `/api/auth-config` | `{ oidc, ssoLoginPath, ssoLogoutPath, passkeyManageUrl }` |
| — | Account → **จัดการ passkey** | Top-level redirect to Keycloak passkey management (hidden when SSO unset) |

Removed (404): `/api/dev/test-accounts`, `/api/dev/test-login`, `/api/auth/dev/*`,
`/api/auth/passkey` (+ `/*`), social OAuth callbacks. App-hosted passkey tables are
left in place but unused (no migrations that drop them).

## Roles

App DB roles (`user` / `admin` / `superadmin`) stay local. On user create / boot,
`SUPERADMIN_EMAILS` matching an OIDC-verified email still promotes to
`superadmin` via `ensureSuperAdmins` (no destructive user-table migrations).

## Keycloak client settings

- Confidential client, Standard flow on, Direct access grants off
- Valid redirect URIs: `{APP_BASE_URL}/api/auth/oidc/callback`
- Valid post logout redirect URIs: `{APP_BASE_URL}/logged-out`
- PKCE S256 required
- Scopes: `openid email profile`
