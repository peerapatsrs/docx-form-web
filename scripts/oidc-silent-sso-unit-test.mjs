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

function cookieVal(setCookie) {
  return setCookie.match(/docx_sso_checked=([^;]+)/)?.[1];
}

await check("visit → hub login → hub link within cooldown = bypass allowed", async () => {
  process.env.OIDC_SSO_HUB_ORIGINS = HUB;
  process.env.OIDC_SSO_COOLDOWN_SEC = "60";
  const {
    resolveSilentSsoStart,
    oidcSsoCooldownSetCookie,
    canUseSilentSsoBypass,
    parseOidcSsoHubOrigins,
  } = await load("src/server/oidc-silent.ts");

  const t0 = 1_700_000_000_000;
  const hubs = parseOidcSsoHubOrigins();

  // Normal visit → login_required (non-bypass).
  const normalFail = cookieVal(
    oidcSsoCooldownSetCookie(false, {
      nowMs: t0,
      outcome: "login_required",
      viaBypass: false,
    }),
  );
  assert.match(normalFail, /\.login_required$/);
  assert.doesNotMatch(normalFail, /\.b$/);
  assert.equal(canUseSilentSsoBypass(normalFail, t0 + 5_000, 60), true);

  // Hub link within cooldown after hub login → must start (viaBypass).
  const hubStart = resolveSilentSsoStart({
    pathname: "/",
    hasSession: false,
    cooldownCookie: normalFail,
    nowMs: t0 + 5_000,
    cooldownSec: 60,
    hubOrigins: hubs,
    referer: `${HUB}/dashboard`,
    oidcEnabled: true,
    isDocumentNavigation: true,
  });
  assert.deepEqual(hubStart, { start: true, viaBypass: true });
});

await check("same via ?sso=1 after normal cooldown fail", async () => {
  const {
    resolveSilentSsoStart,
    oidcSsoCooldownSetCookie,
  } = await load("src/server/oidc-silent.ts");
  const t0 = 1_700_000_000_000;
  const normalFail = cookieVal(
    oidcSsoCooldownSetCookie(false, {
      nowMs: t0,
      outcome: "login_required",
      viaBypass: false,
    }),
  );
  const d = resolveSilentSsoStart({
    pathname: "/",
    search: "?sso=1",
    hasSession: false,
    cooldownCookie: normalFail,
    nowMs: t0 + 10_000,
    cooldownSec: 60,
    hubOrigins: [],
    oidcEnabled: true,
    isDocumentNavigation: true,
  });
  assert.deepEqual(d, { start: true, viaBypass: true });
});

await check("second bypass in same window with no KC session = 0 extra trips", async () => {
  process.env.OIDC_SSO_HUB_ORIGINS = HUB;
  enableOidc();
  const {
    resolveSilentSsoStart,
    oidcSsoCooldownSetCookie,
    canUseSilentSsoBypass,
    parseOidcSsoHubOrigins,
    buildSilentLandPath,
  } = await load("src/server/oidc-silent.ts");
  const { handleOidcCallback } = await load("src/server/oidc-flow.ts");
  const { getOidcConfig } = await load("src/server/oidc-config.ts");

  const t0 = 1_700_000_000_000;
  const hubs = parseOidcSsoHubOrigins();

  // First bypass attempt pending → refuse another start.
  const pendingB = cookieVal(
    oidcSsoCooldownSetCookie(false, {
      nowMs: t0,
      outcome: "pending",
      viaBypass: true,
    }),
  );
  assert.match(pendingB, /\.pending\.b$/);
  assert.equal(canUseSilentSsoBypass(pendingB, t0 + 100, 60), false);
  assert.equal(
    resolveSilentSsoStart({
      pathname: "/",
      hasSession: false,
      cooldownCookie: pendingB,
      nowMs: t0 + 100,
      cooldownSec: 60,
      hubOrigins: hubs,
      referer: `${HUB}/`,
      oidcEnabled: true,
      isDocumentNavigation: true,
    }).start,
    false,
  );

  // Bypass returns login_required.b → still refuse second bypass.
  const result = await handleOidcCallback({
    error: "login_required",
    state: "bypass-1",
    config: getOidcConfig(),
    ssoCooldownCookieRaw: pendingB,
    consumeState: async () => ({
      nonce: "n",
      codeVerifier: "v",
      returnTo: "/?sso=1",
      silent: true,
    }),
  });
  assert.match(result.redirectTo, /\/api\/auth\/oidc\/silent\/land/);
  assert.equal(buildSilentLandPath("/?sso=1"), "/api/auth/oidc/silent/land?next=%2F");
  const failB = cookieVal(
    result.setCookies.find((c) => c.startsWith("docx_sso_checked=")),
  );
  assert.match(failB, /\.login_required\.b$/);
  assert.equal(
    resolveSilentSsoStart({
      pathname: "/",
      search: "?sso=1",
      hasSession: false,
      cooldownCookie: failB,
      nowMs: t0 + 5_000,
      cooldownSec: 60,
      hubOrigins: hubs,
      referer: `${HUB}/`,
      oidcEnabled: true,
      isDocumentNavigation: true,
    }).start,
    false,
  );
});

await check("no Keycloak session = exactly 1 round trip (normal, no loop)", async () => {
  enableOidc();
  const {
    resolveSilentSsoStart,
    oidcSsoCooldownSetCookie,
  } = await load("src/server/oidc-silent.ts");
  const { handleOidcCallback } = await load("src/server/oidc-flow.ts");
  const { getOidcConfig } = await load("src/server/oidc-config.ts");

  const t0 = 1_700_000_000_000;
  assert.equal(
    resolveSilentSsoStart({
      pathname: "/",
      hasSession: false,
      cooldownCookie: null,
      nowMs: t0,
      cooldownSec: 60,
      hubOrigins: [],
      oidcEnabled: true,
      isDocumentNavigation: true,
    }).start,
    true,
  );

  const result = await handleOidcCallback({
    error: "login_required",
    state: "normal-1",
    config: getOidcConfig(),
    ssoCooldownCookieRaw: cookieVal(
      oidcSsoCooldownSetCookie(false, {
        nowMs: t0,
        outcome: "pending",
        viaBypass: false,
      }),
    ),
    consumeState: async () => ({
      nonce: "n",
      codeVerifier: "v",
      returnTo: "/",
      silent: true,
    }),
  });
  assert.match(result.redirectTo, /silent\/land/);
  assert.doesNotMatch(result.redirectTo, /login\?error/);
  const fail = cookieVal(
    result.setCookies.find((c) => c.startsWith("docx_sso_checked=")),
  );
  assert.match(fail, /\.login_required$/);
  assert.doesNotMatch(fail, /\.b$/);
  assert.equal(
    resolveSilentSsoStart({
      pathname: "/",
      hasSession: false,
      cooldownCookie: fail,
      nowMs: t0 + 1_000,
      cooldownSec: 60,
      hubOrigins: [],
      referer: null,
      oidcEnabled: true,
      isDocumentNavigation: true,
    }).start,
    false,
  );
});

await check("logout → hub login → /logged-out plain anchor /?sso=1", async () => {
  const page = readFileSync(join(root, "src/app/logged-out/page.tsx"), "utf8");
  assert.match(page, /<a[^>]+href=[\"']\/\?sso=1[\"']/);
  assert.doesNotMatch(page, /<Link[^>]+href=[\"']\/\?sso=1[\"']/);
  assert.match(page, /<a[^>]+href=[\"']\/login[\"']/);
  // Soft-nav comment present
  assert.match(page, /full document navigation|plain <a/i);
});

await check("expired DB session + live Keycloak → typed / can silent SSO", async () => {
  const { resolveProxySession, verifySignedCookieValue } = await load(
    "src/server/oidc-session-edge.ts",
  );
  // Forged cookie → absent
  const headers = new Headers({
    cookie: "better-auth.session_token=forged.value========",
  });
  const bad = await resolveProxySession({
    request: { headers },
    secure: false,
    validateInDb: true,
  });
  assert.equal(bad.hasSession, false);
  assert.ok(bad.clearCookies.length > 0);

  // validateInDb is wired for top-level page loads in proxy
  const proxy = readFileSync(join(root, "src/proxy.ts"), "utf8");
  assert.match(proxy, /validateInDb:\s*topLevelDoc/);
  assert.match(proxy, /resolveSilentSsoStart/);
  assert.match(proxy, /bypass=1|bypass/);

  // Unit seam: when getSession would return null, clearCookies path is used
  // (covered by resolveProxySession catch / null session above for forged).
  assert.equal(await verifySignedCookieValue("x.y"), null);
});

await check("shared BETTER_AUTH_SECRET helper; prod fail-fast", async () => {
  const {
    resolveBetterAuthSecret,
    DEV_AUTH_SECRET_FALLBACK,
  } = await load("src/server/auth-secret.ts");
  delete process.env.BETTER_AUTH_SECRET;
  delete process.env.AUTH_SECRET;
  process.env.NODE_ENV = "development";
  assert.equal(resolveBetterAuthSecret(), DEV_AUTH_SECRET_FALLBACK);
  process.env.NODE_ENV = "production";
  assert.throws(() => resolveBetterAuthSecret(), /BETTER_AUTH_SECRET/);
  process.env.BETTER_AUTH_SECRET = "prod-secret-value-32chars-minimum!!";
  assert.equal(resolveBetterAuthSecret(), "prod-secret-value-32chars-minimum!!");

  const authSrc = readFileSync(join(root, "src/server/auth.ts"), "utf8");
  assert.match(authSrc, /resolveBetterAuthSecret/);
  assert.doesNotMatch(authSrc, /docx-form-dev-secret-change-me-32b/);
  const edgeSrc = readFileSync(
    join(root, "src/server/oidc-session-edge.ts"),
    "utf8",
  );
  assert.match(edgeSrc, /resolveBetterAuthSecret/);
  assert.doesNotMatch(edgeSrc, /docx-form-dev-secret-change-me-32b/);
});

await check("interactive login_required still shows error page", async () => {
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

await check("silent authorize matches interactive; land strips sso=1", async () => {
  enableOidc();
  const discovery = await load("src/server/oidc-discovery.ts");
  discovery.clearOidcDiscoveryCache();
  const { buildOidcAuthorizationRedirect } = await load(
    "src/server/oidc-flow.ts",
  );
  const { getOidcConfig } = await load("src/server/oidc-config.ts");
  const { buildSilentLandPath, stripSsoBypassParam } = await load(
    "src/server/oidc-silent.ts",
  );
  const cfg = getOidcConfig();
  const fetchDiscovery = async () =>
    new Response(
      JSON.stringify({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
        jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
      }),
      { status: 200 },
    );
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
  assert.equal(su.searchParams.get("prompt"), "none");
  assert.equal(stripSsoBypassParam("/?sso=1"), "/");
  assert.equal(buildSilentLandPath("/?sso=1&x=1"), "/api/auth/oidc/silent/land?next=%2F%3Fx%3D1");
});

await check("env example + compose + silent pending.b wiring", async () => {
  const env = readFileSync(join(root, ".env.example"), "utf8");
  assert.match(env, /OIDC_SSO_COOLDOWN_SEC/);
  assert.match(env, /OIDC_SSO_HUB_ORIGINS/);
  const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
  assert.match(compose, /OIDC_SSO_COOLDOWN_SEC/);
  const silent = readFileSync(
    join(root, "src/app/api/auth/oidc/silent/route.ts"),
    "utf8",
  );
  assert.match(silent, /viaBypass/);
  assert.match(silent, /bypass/);
  const land = readFileSync(
    join(root, "src/app/api/auth/oidc/silent/land/route.ts"),
    "utf8",
  );
  assert.match(land, /no-referrer/);
});

if (failed > 0) {
  console.error(`\n${failed} oidc-silent-sso unit test(s) failed`);
  process.exit(1);
}
console.log("\nAll oidc-silent-sso unit tests passed");
