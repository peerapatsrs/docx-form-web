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
| `OIDC_SSO_COOLDOWN_SEC` | no | Seconds to suppress silent re-check after `login_required` (default `60`). Cookie `docx_sso_checked` stores a timestamp. |
| `OIDC_SSO_HUB_ORIGINS` | no | Comma-separated absolute origins (e.g. `https://dev.tps18.space`) — Referer match bypasses cooldown so a hub login can silent-SSO immediately. No hardcoded hosts. |
| `OIDC_PASSKEY_ADD_ACTION` | no | AIA for add passkey (default `webauthn-register-passwordless`) |
| `OIDC_ADMIN_CLIENT_ID` | no | Service-account client to **list** own passkeys via Admin API |
| `OIDC_ADMIN_CLIENT_SECRET` | no | Service-account secret (with admin client) |
| `OIDC_PASSKEY_MANAGE_URL` | no | Optional external help URL only (no account-console default) |
| `APP_BASE_URL` (or `NEXT_PUBLIC_APP_URL` / `BETTER_AUTH_URL` / `RENDER_EXTERNAL_URL`) | yes for redirects | Public base URL |
| `SUPERADMIN_EMAILS` | recommended | Comma-separated emails promoted to `superadmin` when they match an OIDC-verified email |
| `BETTER_AUTH_SECRET` | yes | Session signing (checked at startup; `/api/health` → `not-ready` when missing in production) |

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

1. **Public pages** (home `/`, `/logged-out`, …) render logged-out with an
   **เข้าสู่ระบบ** button. Opening the app does **not** bounce to Keycloak’s
   interactive login.
2. **Silent SSO** (top-level redirect only — no iframes / third-party cookies;
   Safari/ITP safe): middleware sends **document** navigations without an app
   session to `/api/auth/oidc/silent` → authorize with `prompt=none` (same
   `redirect_uri` / `client_id` / scopes / PKCE S256 as interactive). Requires
   `Sec-Fetch-Dest: document` or `Sec-Fetch-Mode: navigate`; skips RSC /
   prefetch / non-HTML `Accept`.    Marks `docx_sso_checked=<attemptedAt>.pending` (`.b` suffix when the start
   was a hub/`?sso=1` bypass) before leaving for Keycloak. Any silent error →
   quiet land via `/api/auth/oidc/silent/land` (`Referrer-Policy: no-referrer`)
   then the original page (sso=1 stripped) — **never** `/login?error=`.
   Cooldown blocks normal re-checks for `OIDC_SSO_COOLDOWN_SEC` (default 60).
   Hub Referer / `OIDC_SSO_HUB_ORIGINS` or `?sso=1` may bypass after a
   **normal** fail so a later hub login can silent-SSO; a second bypass in the
   same window (`.b`) is refused (stops Referer-sticky loops) and `?sso=1` is
   stripped from the URL once. On real page loads, forged or **definitively**
   DB-expired session cookies are cleared so silent SSO runs; a DB
   down/timeout keeps the cookie and does **not** start silent SSO.
   Info logs: `[oidc] silent …` (no PII).
3. **Protected pages** (`/account`, `/admin`, …) without a session → interactive
   `/login?next=…` preserving path + query (then Keycloak authorize **without**
   `prompt=none`).
4. **`/login`** (button or direct) → interactive authorize via
   `/api/auth/oidc/login` (clears cooldown).
5. Callback validates ID token (JWKS), maps `(issuer, sub)` / email / create
   (see `OIDC_TRUST_IDP_EMAIL`) in one transaction with `ON CONFLICT`.
6. Logout → RP-initiated logout (ends Keycloak session) + clear cooldown →
   `/logged-out`. A later hub login can silent-check again.
7. `/login?error=…` Thai error page + `docx_oidc_fail` loop guard (unchanged).

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
| GET | `/api/auth/oidc/login` | Interactive authorize (no `prompt`) |
| GET | `/api/auth/oidc/silent` | Silent authorize (`prompt=none`) |
| GET | `/api/auth/oidc/callback` | Code callback (+ optional `kc_action_status`) |
| POST | `/api/auth/oidc/logout` | RP logout (POST-only; GET → 405). Top-level form → 303 `end_session`; `id_token_hint` only while fresh |
| POST | `/api/auth/oidc/backchannel-logout` | Back-Channel Logout 1.0 (`logout_token`; RS256/ES256; jti replay) |
| GET | `/api/auth/oidc/passkey/add` | AIA register passkey (session) |
| GET | `/api/auth/oidc/passkey/remove` | AIA delete passkey (session) |
| GET | `/api/auth/oidc/passkey` | List own passkeys (Admin API; optional) |
| GET | `/api/auth-config` | Paths + `passkeyListEnabled` |

OIDC core (authorize/callback/silent/logout/back-channel) is provided by
vendored `@mw-shared/auth` (`vendor/mw-shared`, pin in `MW_SHARED_PIN.json`).
App owns Postgres stores, Better Auth session bridge, and cookie names
(`docx_sso_checked`, `docx_oidc_id_token`, `docx_oidc`).

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
- Backchannel logout URL: `{APP_BASE_URL}/api/auth/oidc/backchannel-logout`
- **Backchannel logout session required: ON**
- PKCE S256 required
- Scopes: `openid email profile` (login); AIA uses `openid`
- Enable AIA actions: `webauthn-register-passwordless`, `delete_credential`
- Admin service-account client (optional list): realm-management roles to read
  user credentials for the realm derived from `OIDC_ISSUER`
