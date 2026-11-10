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

function enableOidc() {
  process.env.OIDC_ISSUER = ISSUER;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET;
  process.env.APP_BASE_URL = APP;
}

await check("public vs protected path helpers", async () => {
  const { isProtectedAppPath, isPublicAppPath, shouldSkipSilentSsoPath } =
    await load("src/server/oidc-silent.ts");
  assert.equal(isProtectedAppPath("/account"), true);
  assert.equal(isProtectedAppPath("/admin/users"), true);
  assert.equal(isPublicAppPath("/"), true);
  assert.equal(isPublicAppPath("/logged-out"), true);
  assert.equal(shouldSkipSilentSsoPath("/api/health"), true);
  assert.equal(shouldSkipSilentSsoPath("/api/me"), true);
  assert.equal(shouldSkipSilentSsoPath("/api/auth/oidc/callback"), true);
  assert.equal(shouldSkipSilentSsoPath("/login"), true);
  assert.equal(shouldSkipSilentSsoPath("/app.js"), true);
  assert.equal(shouldSkipSilentSsoPath("/"), false);
  assert.equal(shouldSkipSilentSsoPath("/account"), false);
});

await check("protected returnTo keeps path + query (open-redirect safe)", async () => {
  const { safeAppReturnPath } = await load("src/server/oidc-silent.ts");
  assert.equal(
    safeAppReturnPath("/account", "?tab=passkeys"),
    "/account?tab=passkeys",
  );
  assert.equal(safeAppReturnPath("/admin/users", "?q=1&x=2"), "/admin/users?q=1&x=2");
  assert.equal(safeAppReturnPath("/", "?x=1"), "/?x=1");
  assert.equal(safeAppReturnPath("//evil.com", ""), "/");
  assert.equal(safeAppReturnPath("/\\evil", "?a=1"), "/");
  const proxy = readFileSync(join(root, "src/proxy.ts"), "utf8");
  assert.match(
    proxy,
    /safeAppReturnPath\(pathname,\s*search\)/,
  );
  // Both silent and protected interactive paths pass search.
  const matches = proxy.match(/safeAppReturnPath\(pathname,\s*search\)/g) || [];
  assert.ok(matches.length >= 2, "silent + protected must keep query");
});

await check("silent only for top-level document navigations", async () => {
  const { isTopLevelDocumentNavigation, shouldStartSilentSso } = await load(
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
    isTopLevelDocumentNavigation({ ...top, secFetchDest: "", secFetchMode: "navigate" }),
    true,
  );
  assert.equal(
    isTopLevelDocumentNavigation({ ...top, secFetchDest: "empty", secFetchMode: "cors" }),
    false,
  );
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
    isTopLevelDocumentNavigation({
      ...top,
      accept: "application/json",
    }),
    false,
  );
  assert.equal(
    shouldStartSilentSso({
      pathname: "/",
      hasSession: false,
      ssoChecked: false,
      ssoSkip: false,
      oidcEnabled: true,
      isDocumentNavigation: false,
    }),
    false,
  );
});

await check("silent check cookie is session-scoped (no Max-Age)", async () => {
  const {
    shouldStartSilentSso,
    oidcSsoCheckedSetCookie,
    OIDC_SSO_CHECKED_COOKIE,
  } = await load("src/server/oidc-silent.ts");
  const set = oidcSsoCheckedSetCookie(false);
  assert.match(set, new RegExp(`^${OIDC_SSO_CHECKED_COOKIE}=1`));
  assert.doesNotMatch(set, /Max-Age=/);
  assert.equal(
    shouldStartSilentSso({
      pathname: "/",
      hasSession: false,
      ssoChecked: true,
      ssoSkip: false,
      oidcEnabled: true,
      isDocumentNavigation: true,
    }),
    false,
  );
});

await check("silent check runs once per browser session", async () => {
  const { shouldStartSilentSso } = await load("src/server/oidc-silent.ts");
  const base = {
    pathname: "/",
    hasSession: false,
    ssoChecked: false,
    ssoSkip: false,
    oidcEnabled: true,
    isDocumentNavigation: true,
  };
  assert.equal(shouldStartSilentSso(base), true);
  assert.equal(shouldStartSilentSso({ ...base, ssoChecked: true }), false);
  assert.equal(shouldStartSilentSso({ ...base, ssoSkip: true }), false);
  assert.equal(shouldStartSilentSso({ ...base, hasSession: true }), false);
  assert.equal(
    shouldStartSilentSso({ ...base, isDocumentNavigation: false }),
    false,
  );
  assert.equal(
    shouldStartSilentSso({ ...base, pathname: "/api/me" }),
    false,
  );
});

await check("no silent check after logout skip cookie", async () => {
  const {
    shouldStartSilentSso,
    oidcSsoSkipSetCookie,
    OIDC_SSO_SKIP_COOKIE,
  } = await load("src/server/oidc-silent.ts");
  const set = oidcSsoSkipSetCookie(false);
  assert.match(set, new RegExp(`^${OIDC_SSO_SKIP_COOKIE}=1`));
  assert.doesNotMatch(set, /Max-Age=/); // session cookie
  assert.equal(
    shouldStartSilentSso({
      pathname: "/",
      hasSession: false,
      ssoChecked: false,
      ssoSkip: true,
      oidcEnabled: true,
      isDocumentNavigation: true,
    }),
    false,
  );
});

await check("silent authorize URL includes prompt=none + PKCE", async () => {
  enableOidc();
  const discovery = await load("src/server/oidc-discovery.ts");
  discovery.clearOidcDiscoveryCache();
  const { buildOidcAuthorizationRedirect } = await load(
    "src/server/oidc-flow.ts",
  );
  const { getOidcConfig } = await load("src/server/oidc-config.ts");
  const savedRows = [];
  const result = await buildOidcAuthorizationRedirect({
    returnTo: "/account?tab=passkeys",
    prompt: "none",
    silent: true,
    config: getOidcConfig(),
    fetchDiscovery: async () =>
      new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
          token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
          jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
        }),
        { status: 200 },
      ),
    ensureSchema: async () => undefined,
    saveState: async (row) => {
      savedRows.push(row);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(savedRows[0].silent, true);
  assert.equal(savedRows[0].returnTo, "/account?tab=passkeys");
  const url = new URL(result.url);
  assert.equal(url.searchParams.get("prompt"), "none");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("state"));
  assert.ok(url.searchParams.get("nonce"));
  assert.equal(
    url.searchParams.get("redirect_uri"),
    `${APP}/api/auth/oidc/callback`,
  );
});

await check("login_required on silent → quiet returnTo (no /login?error)", async () => {
  enableOidc();
  const { handleOidcCallback } = await load("src/server/oidc-flow.ts");
  const { getOidcConfig } = await load("src/server/oidc-config.ts");
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
  assert.equal(result.status, 302);
  assert.equal(result.redirectTo, "/");
  assert.doesNotMatch(result.redirectTo, /error=/);
  assert.ok(
    result.setCookies.some((c) => c.startsWith("docx_sso_checked=")),
  );
});

await check("any silent IdP/token error → quiet logged out (not error page)", async () => {
  enableOidc();
  const { handleOidcCallback } = await load("src/server/oidc-flow.ts");
  const { getOidcConfig } = await load("src/server/oidc-config.ts");
  const config = getOidcConfig();

  for (const err of ["temporarily_unavailable", "access_denied", "server_error"]) {
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
    assert.doesNotMatch(result.redirectTo, /login\?error/);
  }

  const tokenFail = await handleOidcCallback({
    code: "bad-code",
    state: "silent-token",
    config,
    consumeState: async () => ({
      nonce: "n",
      codeVerifier: "v",
      returnTo: "/?from=silent",
      silent: true,
    }),
    fetchFn: async () => {
      throw new Error("token exchange failed");
    },
  });
  assert.equal(tokenFail.redirectTo, "/?from=silent");
  assert.doesNotMatch(tokenFail.redirectTo, /login\?error/);
  assert.ok(
    tokenFail.setCookies.some((c) => c.startsWith("docx_sso_checked=")),
  );
});

await check("interactive login errors still show Thai error page + loop guard", async () => {
  enableOidc();
  const { handleOidcCallback } = await load("src/server/oidc-flow.ts");
  const { getOidcConfig } = await load("src/server/oidc-config.ts");
  const result = await handleOidcCallback({
    error: "login_required",
    state: "interactive-state",
    config: getOidcConfig(),
    consumeState: async () => ({
      nonce: "n",
      codeVerifier: "v",
      returnTo: "/account",
      silent: false,
    }),
  });
  assert.match(result.redirectTo, /\/login\?error=oidc_login_required/);
  assert.ok(result.setCookies.some((c) => c.includes("docx_oidc_fail")));

  const denied = await handleOidcCallback({
    error: "access_denied",
    state: "interactive-denied",
    config: getOidcConfig(),
    consumeState: async () => ({
      nonce: "n",
      codeVerifier: "v",
      returnTo: "/account",
      silent: false,
    }),
  });
  assert.match(denied.redirectTo, /\/login\?error=oidc_access_denied/);
});

await check("return-to preserved and open-redirect safe", async () => {
  const { safeOidcReturnTo } = await load("src/server/oidc-identities.ts");
  const base = APP;
  assert.equal(safeOidcReturnTo("/account", "/", base), "/account");
  assert.equal(safeOidcReturnTo("/account?tab=passkeys", "/", base), "/account?tab=passkeys");
  assert.equal(safeOidcReturnTo("/?x=1", "/", base), "/?x=1");
  assert.equal(safeOidcReturnTo("https://evil.com", "/", base), "/");
  assert.equal(safeOidcReturnTo("//evil.com", "/", base), "/");
  assert.equal(safeOidcReturnTo("/\\evil", "/", base), "/");
});

await check("AuthBar / proxy / login wiring for silent + public button", async () => {
  const bar = readFileSync(join(root, "src/components/AuthBar.tsx"), "utf8");
  assert.match(bar, /เข้าสู่ระบบ/);
  assert.match(bar, /\/login\?next=/);
  const proxy = readFileSync(join(root, "src/proxy.ts"), "utf8");
  assert.match(proxy, /\/api\/auth\/oidc\/silent/);
  assert.match(proxy, /isTopLevelDocumentNavigation/);
  assert.match(proxy, /shouldStartSilentSso|isProtectedAppPath/);
  const login = readFileSync(join(root, "src/app/login/page.tsx"), "utf8");
  assert.match(login, /\/api\/auth\/oidc\/login/);
  assert.doesNotMatch(login, /prompt:\s*[\"']none[\"']/);
  const silent = readFileSync(
    join(root, "src/app/api/auth/oidc/silent/route.ts"),
    "utf8",
  );
  assert.match(silent, /prompt:\s*[\"']none[\"']/);
  const logout = readFileSync(
    join(root, "src/app/api/auth/oidc/logout/route.ts"),
    "utf8",
  );
  assert.match(logout, /oidcSsoSkipSetCookie/);
});

if (failed > 0) {
  console.error(`\n${failed} oidc-silent-sso unit test(s) failed`);
  process.exit(1);
}
console.log("\nAll oidc-silent-sso unit tests passed");
