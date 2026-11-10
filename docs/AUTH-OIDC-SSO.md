# Central OIDC SSO (Keycloak)

This app is prepared as a standard **OIDC Relying Party** of the TPS18 central Keycloak SSO.

Issuer hosts realms under `https://auth.tps18.space` named `tps18-dev` / `tps18-sit` / `tps18-uat` / `tps18-prod`. **Never hardcode** the issuer or realm in application code — configure per environment via `OIDC_ISSUER`.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `OIDC_ISSUER` | for SSO | e.g. `https://auth.tps18.space/realms/tps18-dev` |
| `OIDC_CLIENT_ID` | for SSO | Confidential client id in that realm |
| `OIDC_CLIENT_SECRET` | for SSO | Client secret |
| `APP_BASE_URL` (or `NEXT_PUBLIC_APP_URL` / `BETTER_AUTH_URL` / `RENDER_EXTERNAL_URL`) | yes for correct redirects | Public base URL used to build redirect URIs |
| `ENABLE_PASSWORD_LOGIN` | optional | `1` to keep email/password login until migration; default off |

When any of `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` is missing, **SSO is disabled** (login button hidden, `/api/auth/oidc/*` returns 404/disabled). The app must not crash.

Passkeys and existing OAuth social providers stay available. DEV test users / DEV auth are unchanged.

## Redirect URIs (register in Keycloak)

Compute from the public base URL of each deploy:

| Env | Example `APP_BASE_URL` | Redirect URI | Post-logout URI |
|---|---|---|---|
| local | `http://localhost:3000` | `http://localhost:3000/api/auth/oidc/callback` | `http://localhost:3000/login` |
| DEV | `https://docx-form-dev.example` | `{APP_BASE_URL}/api/auth/oidc/callback` | `{APP_BASE_URL}/login` |
| SIT | `https://docx-form-sit.example` | `{APP_BASE_URL}/api/auth/oidc/callback` | `{APP_BASE_URL}/login` |
| UAT | `https://docx-form-uat.example` | `{APP_BASE_URL}/api/auth/oidc/callback` | `{APP_BASE_URL}/login` |
| PROD | `https://docx-form.example` | `{APP_BASE_URL}/api/auth/oidc/callback` | `{APP_BASE_URL}/login` |

Matching Keycloak realm issuers (examples — set exactly via `OIDC_ISSUER`):

- DEV → `https://auth.tps18.space/realms/tps18-dev`
- SIT → `https://auth.tps18.space/realms/tps18-sit`
- UAT → `https://auth.tps18.space/realms/tps18-uat`
- PROD → `https://auth.tps18.space/realms/tps18-prod`

Pattern: `https://auth.tps18.space/realms/tps18-{env}` where `{env}` is `dev` | `sit` | `uat` | `prod`.

## Keycloak client settings

Create a **confidential** OpenID Connect client per realm (or reuse a shared client with multiple valid redirect URIs):

- **Client authentication**: On (confidential)
- **Standard flow**: On (authorization code)
- **Direct access grants**: Off (not used)
- **Valid redirect URIs**: each env’s `{APP_BASE_URL}/api/auth/oidc/callback`
- **Valid post logout redirect URIs**: each env’s `{APP_BASE_URL}/login`
- **Web origins**: each env’s `{APP_BASE_URL}` (or `+` if your ops standard allows)
- **PKCE**: required / S256 (RP always sends `code_challenge_method=S256`)

Scopes requested by the RP: `openid email profile`.

## Protocol behaviour (RP)

1. **Discovery** — `GET {OIDC_ISSUER}/.well-known/openid-configuration`
2. **Login** — `GET /api/auth/oidc/login?next=/…` → authorize redirect with:
   - `response_type=code`
   - **PKCE** S256 (`code_verifier` stored server-side)
   - **state** + **nonce** (bound to the callback)
3. **Callback** — `GET /api/auth/oidc/callback`
   - Exchange code at `token_endpoint` (client secret + code_verifier)
   - Validate **ID Token** via discovery **JWKS** (`iss`, `aud`, `exp`, **nonce**)
   - Map user by `(issuer, sub)` in table `identities`
   - Else link an existing app user **only when** `email_verified === true` (match verified email)
   - Else create a new app user; **roles** (`user` / `admin` / `superadmin`) stay in the app DB
   - Set Better Auth session cookie (HttpOnly). Tokens are **never** placed in app URLs or logs.
4. **Logout** — `GET|POST /api/auth/oidc/logout` clears the app session and performs **RP-initiated logout** against `end_session_endpoint` (`client_id`, `post_logout_redirect_uri`, optional `id_token_hint`).

## App routes

| Method | Path | Notes |
|---|---|---|
| GET | `/api/auth/oidc/login` | Start SSO |
| GET | `/api/auth/oidc/callback` | Code callback |
| GET/POST | `/api/auth/oidc/logout` | RP logout |
| GET | `/api/auth-config` | Public flags: `oidc` / `sso` / `ssoLoginPath` / `ssoLogoutPath` / `passwordLogin` |

## Database

Migration (`migrateAuth`) creates:

- `identities` — unique `(issuer, subject)` → `"userId"`
- `oidc_login_state` — short-lived PKCE/state/nonce rows

## Local verification without Keycloak

Unit tests mock discovery, token, and JWKS (`scripts/oidc-sso-unit-test.mjs`). No live IdP is required for CI.
