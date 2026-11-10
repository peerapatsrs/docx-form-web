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
  const { isProtectedAppPath, shouldSkipSilentSsoPath } = await load(
    "src/server/oidc-silent.ts",
  );
  assert.equal(isProtectedAppPath("/account"), true);
  assert.equal(shouldSkipSilentSsoPath("/api/auth/oidc/callback"), true);
  assert.equal(shouldSkipSilentSsoPath("/"), false);
});

await check("hub link no Keycloak session = exactly 1 silent trip then quiet (Referer sticky)", async () => {
  process.env.OIDC_SSO_HUB_ORIGINS = HUB;
  process.env.OIDC_SSO_COOLDOWN_SEC = "60";
  enableOidc();
  const {
    shouldStartSilentSso,
    parseOidcSsoHubOrigins,
    oidcSsoCooldownSetCookie,
    canUseSilentSsoBypass,
    buildSilentLandPath,
  } = await load("src/server/oidc-silent.ts");
  const { handleOidcCallback } = await load("src/server/oidc-flow.ts");
  const { getOidcConfig } = await load("src/server/oidc-config.ts");

  const t0 = 1_700_000_000_000;
  const hubs = parseOidcSsoHubOrigins();

  // First open from hub — bypass allowed.
  assert.equal(
    shouldStartSilentSso({
      pathname: "/",
      hasSession: false,
      cooldownCookie: null,
      nowMs: t0,
      cooldownSec: 60,
      hubOrigins: hubs,
      referer: `${HUB}/apps`,
      oidcEnabled: true,
      isDocumentNavigation: true,
    }),
    true,
  );

  // Silent start marks pending — sticky hub Referer must NOT start again.
  const pending = oidcSsoCooldownSetCookie(false, {
    nowMs: t0,
    outcome: "pending",
    cooldownSec: 60,
  });
  const pendingVal = pending.match(/docx_sso_checked=([^;]+)/)?.[1];
  assert.equal(canUseSilentSsoBypass(pendingVal, t0 + 1000, 60), false);
  assert.equal(
    shouldStartSilentSso({
      pathname: "/",
      hasSession: false,
      cooldownCookie: pendingVal,
      nowMs: t0 + 1000,
      cooldownSec: 60,
      hubOrigins: hubs,
      referer: `${HUB}/apps`,
      oidcEnabled: true,
      isDocumentNavigation: true,
    }),
    false,
  );

  // login_required → quiet land (never /login?error) even if Referer preserved.
  const result = await handleOidcCallback({
    error: "login_required",
    state: "silent-1",
    config: getOidcConfig(),
    consumeState: async () => ({
      nonce: "n",
      codeVerifier: "v",
      returnTo: "/",
      silent: true,
    }),
  });
  assert.match(result.redirectTo, /^\/api\/auth\/oidc\/silent\/land\?/);
  assert.doesNotMatch(result.redirectTo, /login\?error/);
  assert.equal(result.referrerPolicy, "no-referrer");
  assert.equal(buildSilentLandPath("/"), "/api/auth/oidc/silent/land?next=%2F");

  const failCookie = result.setCookies.find((c) =>
    c.startsWith("docx_sso_checked="),
  );
  const failVal = failCookie.match(/docx_sso_checked=([^;]+)/)?.[1];
  assert.match(failVal, /\.login_required$/);

  // Sticky hub Referer after returned attempt — still blocked (one bypass only).
  assert.equal(
    shouldStartSilentSso({
      pathname: "/",
      hasSession: false,
      cooldownCookie: failVal,
      nowMs: t0 + 5_000,
      cooldownSec: 60,
      hubOrigins: hubs,
      referer: `${HUB}/apps`,
      oidcEnabled: true,
      isDocumentNavigation: true,
    }),
    false,
  );

  // Same without Referer — also quiet/blocked within cooldown.
  assert.equal(
    shouldStartSilentSso({
      pathname: "/",
      hasSession: false,
      cooldownCookie: failVal,
      nowMs: t0 + 5_000,
      cooldownSec: 60,
      hubOrigins: hubs,
      referer: null,
      oidcEnabled: true,
      isDocumentNavigation: true,
    }),
    false,
  );
});

await check("?sso=1 bypass also one-shot per cooldown window", async () => {
  const {
    shouldStartSilentSso,
    oidcSsoCooldownSetCookie,
  } = await load("src/server/oidc-silent.ts");
  const t0 = 1_700_000_000_000;
  assert.equal(
    shouldStartSilentSso({
      pathname: "/",
      search: "?sso=1",
      hasSession: false,
      cooldownCookie: null,
      nowMs: t0,
      cooldownSec: 60,
      hubOrigins: [],
      oidcEnabled: true,
      isDocumentNavigation: true,
    }),
    true,
  );
  const used = oidcSsoCooldownSetCookie(false, {
    nowMs: t0,
    outcome: "login_required",
  });
  const val = used.match(/docx_sso_checked=([^;]+)/)?.[1];
  assert.equal(
    shouldStartSilentSso({
      pathname: "/",
      search: "?sso=1",
      hasSession: false,
      cooldownCookie: val,
      nowMs: t0 + 1000,
      cooldownSec: 60,
      hubOrigins: [],
      oidcEnabled: true,
      isDocumentNavigation: true,
    }),
    false,
  );
});

await check("missing silent state + login_required still quiet (never error page)", async () => {
  enableOidc();
  const { handleOidcCallback } = await load("src/server/oidc-flow.ts");
  const { getOidcConfig } = await load("src/server/oidc-config.ts");
  const result = await handleOidcCallback({
    error: "login_required",
    state: "already-consumed",
    config: getOidcConfig(),
    consumeState: async () => null,
  });
  assert.match(result.redirectTo, /\/api\/auth\/oidc\/silent\/land/);
  assert.doesNotMatch(result.redirectTo, /login\?error/);
});

await check("interactive login_required still shows Thai error page", async () => {
  enableOidc();
  const { handleOidcCallback } = await load("src/server/oidc-flow.ts");
  const { getOidcConfig } = await load("src/server/oidc-config.ts");
  const result = await handleOidcCallback({
    error: "login_required",
    state: "interactive",
    config: getOidcConfig(),
    consumeState: async () => ({
      nonce: "n",
      codeVerifier: "v",
      returnTo: "/account",
      silent: false,
    }),
  });
  assert.match(result.redirectTo, /\/login\?error=oidc_login_required/);
});

await check("bogus session cookie treated as absent (signature verify)", async () => {
  const { verifySignedCookieValue, resolveProxySession } = await load(
    "src/server/oidc-session-edge.ts",
  );
  assert.equal(await verifySignedCookieValue("not-a-real-session"), null);
  assert.equal(await verifySignedCookieValue("token.bad"), null);
  assert.equal(await verifySignedCookieValue(""), null);

  const headers = new Headers({
    cookie: "better-auth.session_token=forged.tokenvalue========",
  });
  const resolved = await resolveProxySession({
    request: { headers },
    secure: false,
  });
  assert.equal(resolved.hasSession, false);
  assert.ok(resolved.clearCookies.length > 0);
  assert.ok(
    resolved.clearCookies.some((c) => c.includes("session_token") && c.includes("Max-Age=0")),
  );

  // Valid-looking signature length but wrong HMAC → absent
  const fakeSig = `${"a".repeat(32)}.${Buffer.from("x".repeat(32)).toString("base64")}`;
  assert.equal(await verifySignedCookieValue(fakeSig), null);
});

await check("proxy clears invalid session and uses resolveProxySession", async () => {
  const proxy = readFileSync(join(root, "src/proxy.ts"), "utf8");
  assert.match(proxy, /resolveProxySession/);
  assert.match(proxy, /clearCookies/);
  assert.doesNotMatch(proxy, /getSessionCookie\(request\)/);
});

await check("logged-out home link uses /?sso=1", async () => {
  const page = readFileSync(join(root, "src/app/logged-out/page.tsx"), "utf8");
  assert.match(page, /href=[\"']\/\?sso=1[\"']/);
});

await check("env example + compose passthrough for silent SSO vars", async () => {
  const env = readFileSync(join(root, ".env.example"), "utf8");
  assert.match(env, /OIDC_SSO_COOLDOWN_SEC/);
  assert.match(env, /OIDC_SSO_HUB_ORIGINS/);
  const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
  assert.match(compose, /OIDC_SSO_COOLDOWN_SEC/);
  assert.match(compose, /OIDC_SSO_HUB_ORIGINS/);
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
    returnTo: "/",
    silent: false,
    config: cfg,
    fetchDiscovery,
    ensureSchema: async () => undefined,
    saveState: async () => undefined,
  });
  const silent = await buildOidcAuthorizationRedirect({
    returnTo: "/",
    prompt: "none",
    silent: true,
    config: cfg,
    fetchDiscovery,
    ensureSchema: async () => undefined,
    saveState: async () => undefined,
  });
  assert.equal(interactive.ok && silent.ok, true);
  const iu = new URL(interactive.url);
  const su = new URL(silent.url);
  assert.equal(su.searchParams.get("client_id"), iu.searchParams.get("client_id"));
  assert.equal(su.searchParams.get("redirect_uri"), iu.searchParams.get("redirect_uri"));
  assert.equal(su.searchParams.get("scope"), iu.searchParams.get("scope"));
  assert.equal(su.searchParams.get("prompt"), "none");
  assert.equal(su.searchParams.get("max_age"), null);
});

await check("silent start sets pending; land route + callback Referrer-Policy", async () => {
  const silent = readFileSync(
    join(root, "src/app/api/auth/oidc/silent/route.ts"),
    "utf8",
  );
  assert.match(silent, /outcome:\s*[\"']pending[\"']/);
  assert.match(silent, /Referrer-Policy/);
  const land = readFileSync(
    join(root, "src/app/api/auth/oidc/silent/land/route.ts"),
    "utf8",
  );
  assert.match(land, /no-referrer/);
  const cb = readFileSync(
    join(root, "src/app/api/auth/oidc/callback/route.ts"),
    "utf8",
  );
  assert.match(cb, /Referrer-Policy/);
});

await check("cooldown after 70s allows re-check; logout clears cooldown", async () => {
  const {
    shouldStartSilentSso,
    oidcSsoCooldownSetCookie,
  } = await load("src/server/oidc-silent.ts");
  const t0 = 1_700_000_000_000;
  const set = oidcSsoCooldownSetCookie(false, {
    nowMs: t0,
    outcome: "login_required",
    cooldownSec: 60,
  });
  const val = set.match(/docx_sso_checked=([^;]+)/)?.[1];
  assert.equal(
    shouldStartSilentSso({
      pathname: "/",
      hasSession: false,
      cooldownCookie: val,
      nowMs: t0 + 70_000,
      cooldownSec: 60,
      hubOrigins: [],
      oidcEnabled: true,
      isDocumentNavigation: true,
    }),
    true,
  );
  const logout = readFileSync(
    join(root, "src/app/api/auth/oidc/logout/route.ts"),
    "utf8",
  );
  assert.match(logout, /oidcSsoCooldownClearCookie/);
  assert.doesNotMatch(logout, /docx_sso_skip/);
});

if (failed > 0) {
  console.error(`\n${failed} oidc-silent-sso unit test(s) failed`);
  process.exit(1);
}
console.log("\nAll oidc-silent-sso unit tests passed");
