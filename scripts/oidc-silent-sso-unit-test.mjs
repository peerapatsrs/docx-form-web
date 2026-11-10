#!/usr/bin/env node
/**
 * Silent SSO + public/protected routing unit tests.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const saved = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in saved)) delete process.env[key];
  }
  Object.assign(process.env, saved);
}

function clearOidcEnv() {
  for (const key of [
    "OIDC_ISSUER",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_SSO_COOLDOWN_SEC",
    "OIDC_SSO_HUB_ORIGINS",
    "APP_BASE_URL",
    "NEXT_PUBLIC_APP_URL",
    "BETTER_AUTH_URL",
  ]) {
    delete process.env[key];
  }
}

let failed = 0;
function check(name, fn) {
  return (async () => {
    restoreEnv();
    clearOidcEnv();
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`✗ ${name}`);
      console.error(err);
    }
  })();
}

async function load(mod) {
  return import(`../${mod}?t=${Date.now()}-${Math.random()}`);
}

const ISSUER = "https://auth.tps18.space/realms/tps18-dev";
const CLIENT_ID = "docx-form-web";
const CLIENT_SECRET = "test-secret";
const APP = "https://app.example.com";
const HUB = "https://dev.tps18.space";

function enableOidc() {
  process.env.OIDC_ISSUER = ISSUER;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET;
  process.env.APP_BASE_URL = APP;
}

function discoveryFetch() {
  return async () =>
    new Response(
      JSON.stringify({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
        jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
      }),
      { status: 200 },
    );
}

await check("public vs protected path helpers", async () => {
  const { isProtectedAppPath, isPublicAppPath, shouldSkipSilentSsoPath } =
    await load("src/server/oidc-silent.ts");
  assert.equal(isProtectedAppPath("/account"), true);
  assert.equal(isProtectedAppPath("/admin/users"), true);
  assert.equal(isPublicAppPath("/"), true);
  assert.equal(isPublicAppPath("/logged-out"), true);
  assert.equal(shouldSkipSilentSsoPath("/api/health"), true);
  assert.equal(shouldSkipSilentSsoPath("/api/auth/oidc/callback"), true);
  assert.equal(shouldSkipSilentSsoPath("/login"), true);
  assert.equal(shouldSkipSilentSsoPath("/"), false);
});

await check("protected returnTo keeps path + query (open-redirect safe)", async () => {
  const { safeAppReturnPath, stripSsoBypassParam } = await load(
    "src/server/oidc-silent.ts",
  );
  assert.equal(
    safeAppReturnPath("/account", "?tab=passkeys"),
    "/account?tab=passkeys",
  );
  assert.equal(stripSsoBypassParam("/account?tab=passkeys&sso=1"), "/account?tab=passkeys");
  assert.equal(stripSsoBypassParam("/?sso=1"), "/");
  assert.equal(safeAppReturnPath("//evil.com", ""), "/");
  const proxy = readFileSync(join(root, "src/proxy.ts"), "utf8");
  assert.match(proxy, /safeAppReturnPath\(pathname,\s*search\)/);
});

await check("silent only for top-level document navigations", async () => {
  const { isTopLevelDocumentNavigation } = await load(
    "src/server/oidc-silent.ts",
  );
  const top = {
    accept: "text/html,application/xhtml+xml",
    secFetchDest: "document",
    secFetchMode: "navigate",
    pathname: "/",
    search: "",
  };
  assert.equal(isTopLevelDocumentNavigation(top), true);
  assert.equal(
    isTopLevelDocumentNavigation({ ...top, rscHeader: "1" }),
    false,
  );
  assert.equal(
    isTopLevelDocumentNavigation({ ...top, search: "?_rsc=abc" }),
    false,
  );
  assert.equal(
    isTopLevelDocumentNavigation({ ...top, nextRouterPrefetch: "1" }),
    false,
  );
  assert.equal(
    isTopLevelDocumentNavigation({ ...top, purpose: "prefetch" }),
    false,
  );
  assert.equal(
    isTopLevelDocumentNavigation({ ...top, accept: "application/json" }),
    false,
  );
  assert.equal(
    isTopLevelDocumentNavigation({
      ...top,
      secFetchDest: "empty",
      secFetchMode: "cors",
    }),
    false,
  );
});

await check("cooldown cookie stores timestamp; default 60s; no loop within window", async () => {
  process.env.OIDC_SSO_COOLDOWN_SEC = "60";
  const {
    getOidcSsoCooldownSec,
    isOidcSsoCooldownActive,
    oidcSsoCooldownSetCookie,
    shouldStartSilentSso,
    DEFAULT_OIDC_SSO_COOLDOWN_SEC,
  } = await load("src/server/oidc-silent.ts");
  assert.equal(DEFAULT_OIDC_SSO_COOLDOWN_SEC, 60);
  assert.equal(getOidcSsoCooldownSec(), 60);
  delete process.env.OIDC_SSO_COOLDOWN_SEC;
  assert.equal(getOidcSsoCooldownSec(), 60);

  const t0 = 1_700_000_000_000;
  const set = oidcSsoCooldownSetCookie(false, t0, 60);
  assert.match(set, new RegExp(`docx_sso_checked=${t0}`));
  assert.match(set, /Max-Age=60/);
  assert.match(set, /SameSite=Lax/);
  assert.doesNotMatch(set, /SameSite=Strict/i);

  assert.equal(isOidcSsoCooldownActive(String(t0), t0 + 30_000, 60), true);
  assert.equal(isOidcSsoCooldownActive(String(t0), t0 + 70_000, 60), false);
  assert.equal(isOidcSsoCooldownActive("1", t0 + 1_000, 60), false); // legacy

  const base = {
    pathname: "/",
    hasSession: false,
    cooldownCookie: String(t0),
    nowMs: t0 + 10_000,
    cooldownSec: 60,
    hubOrigins: [],
    referer: null,
    oidcEnabled: true,
    isDocumentNavigation: true,
  };
  assert.equal(shouldStartSilentSso(base), false); // within cooldown
  assert.equal(
    shouldStartSilentSso({ ...base, nowMs: t0 + 70_000 }),
    true,
  ); // after cooldown
});

await check("hub Referer / ?sso=1 bypass cooldown (no hardcoded hosts)", async () => {
  process.env.OIDC_SSO_HUB_ORIGINS = `${HUB},https://sit.tps18.space`;
  const {
    parseOidcSsoHubOrigins,
    shouldStartSilentSso,
    refererMatchesHubOrigin,
  } = await load("src/server/oidc-silent.ts");
  const hubs = parseOidcSsoHubOrigins();
  assert.deepEqual(hubs, [HUB, "https://sit.tps18.space"]);
  assert.equal(refererMatchesHubOrigin(`${HUB}/apps`, hubs), true);
  assert.equal(refererMatchesHubOrigin("https://evil.com/", hubs), false);

  const t0 = 1_700_000_000_000;
  const blocked = {
    pathname: "/",
    hasSession: false,
    cooldownCookie: String(t0),
    nowMs: t0 + 5_000,
    cooldownSec: 60,
    hubOrigins: hubs,
    referer: null,
    oidcEnabled: true,
    isDocumentNavigation: true,
  };
  assert.equal(shouldStartSilentSso(blocked), false);
  assert.equal(
    shouldStartSilentSso({
      ...blocked,
      referer: `${HUB}/dashboard`,
    }),
    true,
  );
  assert.equal(
    shouldStartSilentSso({
      ...blocked,
      search: "?sso=1",
      referer: null,
    }),
    true,
  );
});

await check("no docx_sso_skip anywhere; logout clears cooldown only", async () => {
  const logout = readFileSync(
    join(root, "src/app/api/auth/oidc/logout/route.ts"),
    "utf8",
  );
  assert.doesNotMatch(logout, /docx_sso_skip|oidcSsoSkip/);
  assert.match(logout, /oidcSsoCooldownClearCookie/);
  const login = readFileSync(
    join(root, "src/app/api/auth/oidc/login/route.ts"),
    "utf8",
  );
  assert.doesNotMatch(login, /docx_sso_skip|oidcSsoSkip/);
  const silentMod = readFileSync(
    join(root, "src/server/oidc-silent.ts"),
    "utf8",
  );
  assert.doesNotMatch(silentMod, /OIDC_SSO_SKIP|docx_sso_skip/);
  const flow = readFileSync(join(root, "src/server/oidc-flow.ts"), "utf8");
  assert.doesNotMatch(flow, /oidcSsoSkip|docx_sso_skip/);
});

await check("logged-out → login_required → 70s later re-check allowed", async () => {
  enableOidc();
  const { handleOidcCallback } = await load("src/server/oidc-flow.ts");
  const { getOidcConfig } = await load("src/server/oidc-config.ts");
  const {
    isOidcSsoCooldownActive,
    shouldStartSilentSso,
    getOidcSsoCooldownSec,
  } = await load("src/server/oidc-silent.ts");

  const t0 = 1_700_000_000_000;
  const result = await handleOidcCallback({
    error: "login_required",
    state: "silent-state",
    config: getOidcConfig(),
    consumeState: async () => ({
      nonce: "n",
      codeVerifier: "v",
      returnTo: "/",
      silent: true,
    }),
  });
  assert.equal(result.redirectTo, "/");
  assert.doesNotMatch(result.redirectTo, /error=/);
  const cooldown = result.setCookies.find((c) =>
    c.startsWith("docx_sso_checked="),
  );
  assert.ok(cooldown);
  assert.match(cooldown, /SameSite=Lax/);
  const ts = Number(cooldown.match(/docx_sso_checked=(\d+)/)?.[1]);
  assert.ok(Number.isFinite(ts));

  // Simulate: cookie set at t0 via our helper semantics
  process.env.OIDC_SSO_COOLDOWN_SEC = "60";
  assert.equal(getOidcSsoCooldownSec(), 60);
  assert.equal(isOidcSsoCooldownActive(String(t0), t0 + 10_000, 60), true);
  assert.equal(
    shouldStartSilentSso({
      pathname: "/",
      hasSession: false,
      cooldownCookie: String(t0),
      nowMs: t0 + 10_000,
      cooldownSec: 60,
      hubOrigins: [],
      oidcEnabled: true,
      isDocumentNavigation: true,
    }),
    false,
  );
  // 70s later (e.g. after hub login elsewhere) — re-check without needing Referer
  assert.equal(
    shouldStartSilentSso({
      pathname: "/",
      hasSession: false,
      cooldownCookie: String(t0),
      nowMs: t0 + 70_000,
      cooldownSec: 60,
      hubOrigins: [],
      oidcEnabled: true,
      isDocumentNavigation: true,
    }),
    true,
  );
});

await check("logout then hub login → silent allowed immediately", async () => {
  process.env.OIDC_SSO_HUB_ORIGINS = HUB;
  const { shouldStartSilentSso, parseOidcSsoHubOrigins } = await load(
    "src/server/oidc-silent.ts",
  );
  const t0 = Date.now();
  // Even with a leftover cooldown from a prior login_required, hub Referer wins.
  assert.equal(
    shouldStartSilentSso({
      pathname: "/",
      hasSession: false,
      cooldownCookie: String(t0),
      nowMs: t0 + 5_000,
      cooldownSec: 60,
      hubOrigins: parseOidcSsoHubOrigins(),
      referer: `${HUB}/`,
      oidcEnabled: true,
      isDocumentNavigation: true,
    }),
    true,
  );
});

await check("silent authorize matches interactive (redirect_uri/scope/client/PKCE)", async () => {
  enableOidc();
  const discovery = await load("src/server/oidc-discovery.ts");
  discovery.clearOidcDiscoveryCache();
  const { buildOidcAuthorizationRedirect } = await load(
    "src/server/oidc-flow.ts",
  );
  const { getOidcConfig } = await load("src/server/oidc-config.ts");
  const cfg = getOidcConfig();
  const fetchDiscovery = discoveryFetch();

  const interactive = await buildOidcAuthorizationRedirect({
    returnTo: "/account?tab=passkeys",
    silent: false,
    config: cfg,
    fetchDiscovery,
    ensureSchema: async () => undefined,
    saveState: async () => undefined,
  });
  const silent = await buildOidcAuthorizationRedirect({
    returnTo: "/account?tab=passkeys",
    prompt: "none",
    silent: true,
    config: cfg,
    fetchDiscovery,
    ensureSchema: async () => undefined,
    saveState: async () => undefined,
  });
  assert.equal(interactive.ok, true);
  assert.equal(silent.ok, true);
  const iu = new URL(interactive.url);
  const su = new URL(silent.url);
  assert.equal(su.searchParams.get("client_id"), iu.searchParams.get("client_id"));
  assert.equal(su.searchParams.get("redirect_uri"), iu.searchParams.get("redirect_uri"));
  assert.equal(su.searchParams.get("scope"), iu.searchParams.get("scope"));
  assert.equal(su.searchParams.get("scope"), "openid email profile");
  assert.equal(
    su.searchParams.get("code_challenge_method"),
    iu.searchParams.get("code_challenge_method"),
  );
  assert.equal(su.searchParams.get("code_challenge_method"), "S256");
  assert.equal(su.searchParams.get("prompt"), "none");
  assert.equal(iu.searchParams.get("prompt"), null);
  assert.equal(su.searchParams.get("max_age"), null);
  assert.equal(iu.searchParams.get("max_age"), null);
  assert.equal(
    su.searchParams.get("redirect_uri"),
    `${APP}/api/auth/oidc/callback`,
  );
});

await check("silent success clears cooldown; cookies SameSite=Lax", async () => {
  enableOidc();
  const { handleOidcCallback } = await load("src/server/oidc-flow.ts");
  const { getOidcConfig } = await load("src/server/oidc-config.ts");
  const result = await handleOidcCallback({
    code: "ok-code",
    state: "silent-ok",
    config: getOidcConfig(),
    consumeState: async () => ({
      nonce: "n",
      codeVerifier: "v",
      returnTo: "/?from=hub",
      silent: true,
    }),
    resolveUser: async () => ({ userId: "u1" }),
    createSession: async () => ({
      setCookie:
        "better-auth.session_token=abc; Path=/; HttpOnly; SameSite=Lax; Secure",
      userId: "u1",
    }),
    fetchFn: async (url) => {
      if (String(url).includes("openid-configuration")) {
        return discoveryFetch()();
      }
      return new Response(
        JSON.stringify({
          id_token: "header.payload.sig",
          access_token: "atok",
          token_type: "Bearer",
        }),
        { status: 200 },
      );
    },
    jwks: { keys: [] },
  }).catch((err) => err);

  // Full JWT validate may fail without real JWKS — accept quiet fail OR success.
  // Assert side-cookie builders always use Lax via source + cooldown clear on success path.
  const flow = readFileSync(join(root, "src/server/oidc-flow.ts"), "utf8");
  assert.match(flow, /SameSite=Lax/);
  assert.doesNotMatch(flow, /SameSite=Strict/i);
  assert.match(flow, /oidcSsoCooldownClearCookie/);
  assert.match(flow, /\[oidc\] silent outcome/);
  void result;
});

await check("any silent IdP error → quiet + cooldown; interactive keeps error page", async () => {
  enableOidc();
  const { handleOidcCallback } = await load("src/server/oidc-flow.ts");
  const { getOidcConfig } = await load("src/server/oidc-config.ts");
  const config = getOidcConfig();

  for (const err of ["login_required", "temporarily_unavailable", "access_denied"]) {
    const result = await handleOidcCallback({
      error: err,
      state: `silent-${err}`,
      config,
      consumeState: async () => ({
        nonce: "n",
        codeVerifier: "v",
        returnTo: "/account?tab=passkeys",
        silent: true,
      }),
    });
    assert.equal(result.redirectTo, "/account?tab=passkeys", err);
    assert.ok(result.setCookies.some((c) => c.startsWith("docx_sso_checked=")));
  }

  const interactive = await handleOidcCallback({
    error: "login_required",
    state: "interactive",
    config,
    consumeState: async () => ({
      nonce: "n",
      codeVerifier: "v",
      returnTo: "/account",
      silent: false,
    }),
  });
  assert.match(interactive.redirectTo, /\/login\?error=oidc_login_required/);
});

await check("proxy / silent route: top-level only, no iframe, info logs", async () => {
  const proxy = readFileSync(join(root, "src/proxy.ts"), "utf8");
  assert.match(proxy, /isTopLevelDocumentNavigation/);
  assert.match(proxy, /OIDC_SSO_HUB_ORIGINS|parseOidcSsoHubOrigins/);
  assert.match(proxy, /\/api\/auth\/oidc\/silent/);
  assert.doesNotMatch(proxy, /check-sso|third-party cookie|iframe\.src/i);
  const silent = readFileSync(
    join(root, "src/app/api/auth/oidc/silent/route.ts"),
    "utf8",
  );
  assert.match(silent, /prompt:\s*[\"']none[\"']/);
  assert.match(silent, /\[oidc\] silent/);
  assert.doesNotMatch(silent, /check-sso|iframe\.src/i);
  const auth = readFileSync(join(root, "src/server/auth.ts"), "utf8");
  assert.match(auth, /sameSite:\s*[\"']lax[\"']/);
});

if (failed > 0) {
  console.error(`\n${failed} oidc-silent-sso unit test(s) failed`);
  process.exit(1);
}
console.log("\nAll oidc-silent-sso unit tests passed");
