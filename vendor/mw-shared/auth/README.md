# `@mw-shared/auth`

Framework-agnostic Keycloak OIDC module (auth-code + PKCE, silent SSO, RP-initiated logout, Back-Channel Logout 1.0, passkey AIA helpers). Runs on **Node 20+** and **Cloudflare workerd** (Web `fetch` / Web Crypto / `Request`/`Response` only — no Node-only APIs, no import-time env reads).

## Install as a git submodule (required for TPS18 apps)

Apps should vendor this repo at a **pinned commit SHA**. The DEV VPS **cannot reach GitHub**, so submodules are **not** fetched at runtime or during the server-side build. Checkout and pin on a machine that has GitHub access (CI laptop / build agent), commit the gitlink, and deploy the already-checked-out tree.

```bash
# On a machine with GitHub access:
git submodule add https://github.com/peerapatsrs/mw-shared.git vendor/mw-shared
cd vendor/mw-shared
git fetch origin
git checkout <MW_SHARED_SHA>   # pin exact commit
cd ../..
git add vendor/mw-shared
git commit -m "vendor: pin mw-shared @ <MW_SHARED_SHA>"
```

Update later the same way: advance the submodule to a new SHA locally/CI, commit the gitlink, deploy the tree that already contains `vendor/mw-shared/` contents. Do **not** run `git submodule update` on the VPS.

### Local workspace / `file:` package

```json
{
  "dependencies": {
    "@mw-shared/auth": "file:vendor/mw-shared/auth"
  }
}
```

pnpm workspace:

```yaml
# pnpm-workspace.yaml
packages:
  - "vendor/mw-shared/auth"
  - "apps/*"
```

Imports:

```ts
import { createAuthClient, configFromEnv } from "@mw-shared/auth";
import { createNextAuthAdapter } from "@mw-shared/auth/adapters/nextjs";
import { createSvelteKitAuthHandle } from "@mw-shared/auth/adapters/sveltekit";
import { createNodeAuthHandler } from "@mw-shared/auth/adapters/node-api";
```

When TypeScript path-maps the submodule source directly:

```ts
import { createAuthClient } from "../vendor/mw-shared/auth/src/index.ts";
```

---

## Architecture

| Layer | Role |
|-------|------|
| **Core** | OIDC discovery, PKCE, authorize/callback, silent SSO, logout, back-channel, passkeys, session validation |
| **Pluggable** | `SessionStore`, `StateStore`, `UserResolver`, `Logger` — apps own persistence and user linking |
| **Adapters** | Thin Next.js / SvelteKit / Node-API wrappers over `Request`/`Response` |

All hosts, realms, client ids, cookie names and paths come from a typed `MwAuthConfig` (sane defaults; zero hardcoding).

---

## Config reference

```ts
import { createAuthClient, configFromEnv, resolveAuthConfig } from "@mw-shared/auth";

const config = resolveAuthConfig(
  configFromEnv(env, {
    publicOrigin: "https://app.example",
    hubOrigins: ["https://hub.example"],
    cooldownSec: 60,
  }),
);
```

| Field | Default | Notes |
|-------|---------|-------|
| `issuer` | — | e.g. `https://auth.example/realms/{env}` |
| `clientId` / `clientSecret` | — | confidential client |
| `publicOrigin` | — | app origin |
| `redirectUri` | `{publicOrigin}{paths.callback}` | |
| `postLogoutRedirectUri` | `{publicOrigin}{paths.postLogout}` | |
| `scopes` | `openid email profile` | AIA uses `openid` only |
| `cooldownSec` | `60` | silent SSO window |
| `hubOrigins` | `[]` | Referer bypass allow-list |
| `cooldownCookieName` | `mw_sso_checked` | value `until:pending:bypassUsed` |
| `idTokenCookieName` | `mw_oidc_id_token` | RP logout hint |
| `paths.*` | see `DEFAULT_PATHS` | override per app |
| `passkeyAddAction` | `webauthn-register-passwordless` | |
| `kcIdpHint` | `null` | optional broker hint |
| `secureCookies` | `true` if https origin | |
| `clockToleranceSec` | `60` | JWT skew |
| `idTokenHintFreshnessSec` | same as `clockToleranceSec` | RP logout: send `id_token_hint` only while `exp > now - freshness` |
| `stateTtlSec` | `600` | PKCE/state TTL |
| `allowedJwtAlgs` | `RS256`, `ES256` | `none` / HS256 rejected |

Env helper (via `configFromEnv`): also `OIDC_LOGOUT_ID_TOKEN_FRESHNESS_SEC`.

Env helper keys (read only when **you** call `configFromEnv` at runtime): `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_SSO_HUB_ORIGINS`, `OIDC_SSO_COOLDOWN_SEC` / `SILENT_SSO_COOLDOWN_SEC`, `OIDC_PASSKEY_ADD_ACTION`, `OIDC_IDP_HINT`, `APP_PUBLIC_ORIGIN` / `APP_BASE_URL` / `API_PUBLIC_ORIGIN`.

---

## Adapter public APIs

### Next.js App Router + Better Auth — `@mw-shared/auth/adapters/nextjs`

```ts
createNextAuthAdapter({ client, protectedPathPrefixes?, interactiveLoginPath? })
  → { handlers, handleProxy, client }

createNextOidcHandlers(client)
  → Record<path, { GET, POST }>

handleNextAuthProxy(request, options)
  → Response | null   // silent SSO + protected gate; public pages never force login

createBetterAuthSessionBridge({ auth, index })
  → SessionStore      // Better Auth sessions + sid/sub index
```

Wire `handlers[path].GET/POST` into `app/api/.../route.ts`. Call `handleProxy` from `proxy.ts` / middleware.

### SvelteKit — `@mw-shared/auth/adapters/sveltekit`

```ts
createSvelteKitAuthHandle({ client, protectedPathPrefixes?, interactiveLoginPath?, landPath? })
  → Handle            // hooks.server.ts

createSvelteKitOidcHandlers(client)
  → { login, silent, callback, logoutGet, logoutPost, land, backchannel }
```

Default protected prefixes: `/app`, `/platform`. Land path default: `/auth/sso/land` (`Referrer-Policy: no-referrer`).

### Node / Fastify / Hono API — `@mw-shared/auth/adapters/node-api`

```ts
createNodeAuthHandler({ client, mountPrefix?, routeMap? })
  → (request: Request) => Promise<Response>

matchOidcRoute(pathname, routes) → action | null
defaultRouteMap(paths, mountPrefix?) → route table
```

Example mount: `mountPrefix: "/api/v1/auth/sso"` → `/login`, `/start-silent`, `/callback`, `/logout` (POST-only, **top-level form** → 303 to `end_session`), `/backchannel-logout`, …

### Logout UX (required)

```html
<!-- Top-level document POST — do NOT use fetch/XHR -->
<form method="POST" action="/api/auth/oidc/logout">
  <button type="submit">Sign out</button>
</form>
```

The response is a document redirect (`303`/`302` + `Location` → Keycloak `end_session` with `id_token_hint`). That top-level navigation is what ends the IdP session.

---

## Behaviour summary (gated)

1. **Login** — discovery-based auth-code + PKCE S256; safe `next`/`returnTo`; optional `kc_idp_hint`.
2. **Silent SSO** — top-level `prompt=none` only when `Sec-Fetch-Dest=document` **and** `Sec-Fetch-Mode=navigate` (never fetch/RSC/prefetch/iframe when detectable). Cooldown cookie `until:pending:bypassUsed` (default 60s). Hub Referer or `?sso=1` bypass at most once per window; refused while pending. Strip `sso` from next/URL. Quiet fail via same-origin land hop + `Referrer-Policy: no-referrer`. `login_required` / `interaction_required` stay quiet. `onSilentLoginSuccess` hook for post-silent redirects (e.g. `/create-shop`). Logs: `[mw-auth] silent`.
3. **Public pages** never auto-redirect to interactive login.
4. **Logout** — POST-only (GET → 405). **Must be a top-level document POST** (HTML `<form method="POST">`), never `fetch` / XHR. The handler responds with a **303** (or 302) document redirect to the IdP `end_session_endpoint` so the browser navigates to Keycloak and ends the SSO session. A fetch/XHR caller would clear only the local cookie and leave the Keycloak session alive. **`id_token_hint` is attached only while the id token is still fresh** (`exp > now - idTokenHintFreshnessSec`); otherwise the redirect sends `client_id` + `post_logout_redirect_uri` only (same pattern as the TPS18 hub) so Keycloak does not show its logout confirmation page. Silent SSO stays **full-page `prompt=none`** — Keycloak sets `frame-ancestors 'self'`, so iframe session checks do not work.
5. **Back-Channel Logout 1.0** — verify `logout_token` via JWKS (RS256/ES256 only; reject `none` / HS256); iss/aud/iat/exp/jti/event; require `sub` and/or `sid`; reject `nonce`; **required** `StateStore.seenJti` replay guard (missing `jti` → 400); delete by `sid` else `sub`; `200` `Cache-Control: no-store` / `400` invalid.
6. **Passkeys** — `kc_action` URLs with **no** `prompt` and **no** `max_age`.
7. **Session validation** — store error keeps the session (fail-safe).

---

## Keycloak client settings

For each env realm (`…/realms/{dev|sit|uat|prod}`):

| Setting | Value |
|---------|-------|
| Access type | confidential |
| Standard flow | ON |
| Valid redirect URIs | `{appOrigin}{callbackPath}` |
| Valid post-logout redirect URIs | `{appOrigin}/` or `{appOrigin}/logged-out` |
| Web origins | `{appOrigin}` |
| Backchannel logout URL | `{appOrigin}{backchannelPath}` |
| Backchannel logout session required | **ON** |
| PKCE | S256 (client or realm default) |

Store `sid` and `sub` on the local session at login (this module does so via `SessionStore`).

---

## Migration plans (do not modify those repos from this task)

### docx-form-web (Next.js + Better Auth)

Pin `vendor/mw-shared` @ chosen SHA. Replace / thin-wrap:

| Current | Replace with |
|---------|----------------|
| `src/server/oidc-*.ts`, `oidc-silent.ts`, `oidc-flow.ts`, … | `@mw-shared/auth` core + `createNextAuthAdapter` |
| `src/proxy.ts` silent/session gate | `handleNextAuthProxy` |
| `src/app/api/auth/oidc/**/route.ts` | `createNextOidcHandlers` |
| Identity / Better Auth session create | `UserResolver` + `createBetterAuthSessionBridge` |
| Keep | Better Auth admin plugin, app UI, `/api/health` secret readiness |

Add back-channel route (not present in gated `21971b5`). Align cooldown cookie to `until:pending:bypassUsed` (or keep name via config). Switch logout to **POST-only**.

### qr-table-order (SvelteKit workerd + Node API)

Pin `vendor/mw-shared` @ chosen SHA. Replace / thin-wrap:

| Current | Replace with |
|---------|----------------|
| Web silent SSO + `/auth/sso/land` | `createSvelteKitAuthHandle` |
| API `/api/v1/auth/sso/*` | `createNodeAuthHandler({ mountPrefix: "/api/v1/auth/sso" })` |
| Redis session | app `SessionStore` implementing create/get/delete/findBySid/findBySub |
| `onSilentLoginSuccess` | redirect no-tenant users to `/create-shop` |
| Keep | tenant/shop domain, wrangler bindings for cooldown/hub origins |

> **Note:** `qr-table-order` was not cloneable from this agent (private/404). Behaviour taken from gate reports `RESULT-51dfb46` / `RESULT-1a1173a`. Confirm the API framework (Fastify vs Hono) when adopting — the Node adapter is Fetch-based and mounts on either.

---

## Develop this package

```bash
cd auth
npm install
npm run typecheck
npm test
npm run test:workerd
npm run build
```

No secrets belong in this repository.
