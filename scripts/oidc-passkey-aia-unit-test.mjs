#!/usr/bin/env node
/**
 * Keycloak AIA passkey unit tests — authorize URL (PKCE + kc_action),
 * credentialId validation, own-sub listing, kc_action_status callback.
 */
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
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
    "OIDC_PASSKEY_ADD_ACTION",
    "OIDC_ADMIN_CLIENT_ID",
    "OIDC_ADMIN_CLIENT_SECRET",
    "OIDC_PASSKEY_MANAGE_URL",
    "APP_BASE_URL",
    "NEXT_PUBLIC_APP_URL",
    "BETTER_AUTH_URL",
    "RENDER_EXTERNAL_URL",
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

function mockDiscoveryFetch(extra = {}) {
  return async (url, init) => {
    const u = String(url);
    if (u.includes("/.well-known/openid-configuration")) {
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
          token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
          jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
          end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
        }),
        { status: 200 },
      );
    }
    if (typeof extra === "function") return extra(url, init);
    if (extra[u]) return extra[u](init);
    return new Response("not found", { status: 404 });
  };
}

await check("credentialId validation accepts UUID-like and rejects junk", async () => {
  const {
    validateOidcPasskeyCredentialId,
    buildOidcPasskeyDeleteAction,
  } = await load("src/server/oidc-passkey.ts");
  assert.equal(
    validateOidcPasskeyCredentialId("a1b2c3d4-e5f6-7890-abcd-ef1234567890"),
    "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  );
  assert.equal(validateOidcPasskeyCredentialId("../etc/passwd"), null);
  assert.equal(validateOidcPasskeyCredentialId("id with spaces"), null);
  assert.equal(validateOidcPasskeyCredentialId(""), null);
  assert.equal(validateOidcPasskeyCredentialId("a;rm -rf"), null);
  assert.equal(
    buildOidcPasskeyDeleteAction("cred_abc-123"),
    "delete_credential:cred_abc-123",
  );
  assert.throws(() => buildOidcPasskeyDeleteAction("bad id"));
});

await check("admin realm base derives from issuer (no hardcoding)", async () => {
  const { deriveKeycloakAdminRealmBase, getOidcAdminConfig } = await load(
    "src/server/oidc-passkey.ts",
  );
  assert.equal(
    deriveKeycloakAdminRealmBase(ISSUER),
    "https://auth.tps18.space/admin/realms/tps18-dev",
  );
  assert.equal(
    deriveKeycloakAdminRealmBase("https://sso.example.com/realms/my-realm/"),
    "https://sso.example.com/admin/realms/my-realm",
  );
  assert.equal(deriveKeycloakAdminRealmBase("https://x.example/nope"), null);
  enableOidc();
  assert.equal(getOidcAdminConfig(), null);
  process.env.OIDC_ADMIN_CLIENT_ID = "admin-cli-svc";
  process.env.OIDC_ADMIN_CLIENT_SECRET = "admin-secret";
  const admin = getOidcAdminConfig();
  assert.ok(admin);
  assert.equal(admin.adminRealmBase, "https://auth.tps18.space/admin/realms/tps18-dev");
  assert.equal(admin.tokenUrl, `${ISSUER}/protocol/openid-connect/token`);
});

await check("no account-console default for passkey manage URL", async () => {
  enableOidc();
  const { resolveOidcPasskeyManageUrl } = await load("src/server/oidc-config.ts");
  assert.equal(resolveOidcPasskeyManageUrl(), null);
  process.env.OIDC_PASSKEY_MANAGE_URL = "https://help.example.com/passkeys";
  assert.equal(
    resolveOidcPasskeyManageUrl(),
    "https://help.example.com/passkeys",
  );
});

await check("AIA add authorize URL has PKCE S256 + kc_action + openid scope", async () => {
  enableOidc();
  const { getOidcPasskeyAddAction } = await load("src/server/oidc-passkey.ts");
  assert.equal(getOidcPasskeyAddAction(), "webauthn-register-passwordless");
  process.env.OIDC_PASSKEY_ADD_ACTION = "custom-webauthn-register";
  assert.equal(getOidcPasskeyAddAction(), "custom-webauthn-register");

  const discovery = await load("src/server/oidc-discovery.ts");
  discovery.clearOidcDiscoveryCache();
  const { buildOidcAuthorizationRedirect } = await load(
    "src/server/oidc-flow.ts",
  );
  const { getOidcConfig } = await load("src/server/oidc-config.ts");
  const saved = [];
  const result = await buildOidcAuthorizationRedirect({
    returnTo: "/account",
    kcAction: "webauthn-register-passwordless",
    scopes: ["openid"],
    config: getOidcConfig(),
    fetchDiscovery: mockDiscoveryFetch(),
    ensureSchema: async () => undefined,
    saveState: async (row) => {
      saved.push(row);
    },
  });
  assert.equal(result.ok, true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].returnTo, "/account");
  const url = new URL(result.url);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.equal(url.searchParams.get("kc_action"), "webauthn-register-passwordless");
  assert.equal(url.searchParams.get("scope"), "openid");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    `${APP}/api/auth/oidc/callback`,
  );
  assert.ok(url.searchParams.get("state"));
  assert.ok(url.searchParams.get("nonce"));
  assert.match(url.origin + url.pathname, /\/protocol\/openid-connect\/auth$/);
  // AIA must not force re-auth — no prompt=login / max_age.
  assert.equal(url.searchParams.get("prompt"), null);
  assert.equal(url.searchParams.get("max_age"), null);
  assert.doesNotMatch(result.url, /[?&]prompt=/);
  assert.doesNotMatch(result.url, /[?&]max_age=/);
});

await check("AIA remove authorize also has no prompt=login / max_age", async () => {
  enableOidc();
  const discovery = await load("src/server/oidc-discovery.ts");
  discovery.clearOidcDiscoveryCache();
  const { buildOidcAuthorizationRedirect } = await load(
    "src/server/oidc-flow.ts",
  );
  const { getOidcConfig } = await load("src/server/oidc-config.ts");
  const result = await buildOidcAuthorizationRedirect({
    returnTo: "/account",
    kcAction: "delete_credential:cred_abc-123",
    scopes: ["openid"],
    config: getOidcConfig(),
    fetchDiscovery: mockDiscoveryFetch(),
    ensureSchema: async () => undefined,
    saveState: async () => undefined,
  });
  assert.equal(result.ok, true);
  const url = new URL(result.url);
  assert.equal(url.searchParams.get("kc_action"), "delete_credential:cred_abc-123");
  assert.equal(url.searchParams.get("prompt"), null);
  assert.equal(url.searchParams.get("max_age"), null);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

await check("delete_credential kc_action is URL-encoded safely", async () => {
  const { buildOidcPasskeyDeleteAction } = await load("src/server/oidc-passkey.ts");
  const action = buildOidcPasskeyDeleteAction("cred-XYZ_99");
  const params = new URLSearchParams();
  params.set("kc_action", action);
  assert.equal(params.get("kc_action"), "delete_credential:cred-XYZ_99");
  assert.match(params.toString(), /kc_action=delete_credential%3Acred-XYZ_99/);
});

await check("list filters webauthn-passwordless for own sub only", async () => {
  enableOidc();
  process.env.OIDC_ADMIN_CLIENT_ID = "admin-svc";
  process.env.OIDC_ADMIN_CLIENT_SECRET = "admin-secret";
  const { listOwnOidcPasskeys, getOidcAdminConfig } = await load(
    "src/server/oidc-passkey.ts",
  );
  const admin = getOidcAdminConfig();
  const ownSub = "user-sub-own";
  let listedUrl = "";
  const fetchFn = async (url, init) => {
    const u = String(url);
    if (u === admin.tokenUrl) {
      assert.equal(init.method, "POST");
      const body = String(init.body || "");
      assert.match(body, /grant_type=client_credentials/);
      assert.doesNotMatch(body, /password=/);
      return new Response(
        JSON.stringify({ access_token: "admin-token-not-for-browser" }),
        { status: 200 },
      );
    }
    if (u.includes("/credentials")) {
      listedUrl = u;
      const auth = init.headers.Authorization || init.headers.authorization;
      assert.equal(auth, "Bearer admin-token-not-for-browser");
      assert.ok(!u.includes("other-sub"));
      return new Response(
        JSON.stringify([
          {
            id: "pk-1",
            type: "webauthn-passwordless",
            userLabel: "YubiKey",
            createdDate: 1_700_000_000_000,
          },
          {
            id: "pw-1",
            type: "password",
            userLabel: "pwd",
            createdDate: 1_700_000_000_000,
          },
          {
            id: "pk-bad spaces",
            type: "webauthn-passwordless",
            userLabel: "bad",
          },
        ]),
        { status: 200 },
      );
    }
    return new Response("nope", { status: 404 });
  };
  const result = await listOwnOidcPasskeys({
    keycloakSub: ownSub,
    admin,
    fetchFn,
  });
  assert.equal(result.ok, true);
  assert.equal(result.credentials.length, 1);
  assert.equal(result.credentials[0].id, "pk-1");
  assert.equal(result.credentials[0].label, "YubiKey");
  assert.ok(result.credentials[0].createdAt);
  assert.match(listedUrl, /\/users\/user-sub-own\/credentials$/);
  assert.doesNotMatch(JSON.stringify(result.credentials), /admin-token/);

  const bad = await listOwnOidcPasskeys({
    keycloakSub: "../x",
    admin,
    fetchFn,
  });
  assert.equal(bad.ok, false);
});

await check("kc_action_status callback appends Thai-facing passkey query", async () => {
  enableOidc();
  const {
    appendOidcPasskeyStatusParam,
    normalizeKcActionStatus,
  } = await load("src/server/oidc-passkey.ts");
  assert.equal(normalizeKcActionStatus("success"), "success");
  assert.equal(normalizeKcActionStatus("CANCELLED"), "cancelled");
  assert.equal(normalizeKcActionStatus("error"), "error");
  assert.equal(normalizeKcActionStatus("nope"), null);
  assert.equal(
    appendOidcPasskeyStatusParam("/account", "success"),
    "/account?passkey=success",
  );
  assert.equal(
    appendOidcPasskeyStatusParam("/account?x=1", "cancelled"),
    "/account?x=1&passkey=cancelled",
  );

  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "k1";
  jwk.alg = "RS256";
  jwk.use = "sig";
  const jwks = { keys: [jwk] };
  const nonce = "nonce-aia-1";
  const codeVerifier = "verifier-aia-0123456789abcdef";

  const idToken = await new SignJWT({
    email: "aia@example.com",
    email_verified: true,
    name: "AIA User",
    nonce,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setSubject("sub-aia")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);

  const discovery = await load("src/server/oidc-discovery.ts");
  discovery.clearOidcDiscoveryCache();
  const { handleOidcCallback } = await load("src/server/oidc-flow.ts");
  const { getOidcConfig } = await load("src/server/oidc-config.ts");
  const cfg = getOidcConfig();

  const fetchFn = async (url) => {
    const u = String(url);
    if (u.includes("/.well-known/openid-configuration")) {
      return new Response(
        JSON.stringify({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/auth`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/certs`,
        }),
        { status: 200 },
      );
    }
    if (u.includes("/token")) {
      return new Response(JSON.stringify({ id_token: idToken }), {
        status: 200,
      });
    }
    return new Response("no", { status: 404 });
  };

  const pending = {
    nonce,
    codeVerifier,
    returnTo: "/account",
  };

  const success = await handleOidcCallback({
    code: "auth-code",
    state: "state-ok",
    kcActionStatus: "success",
    config: cfg,
    fetchFn,
    jwks,
    consumeState: async () => pending,
    resolveUser: async () => ({ userId: "user-aia", linkedBy: "identity" }),
    createSession: async () => ({
      setCookie: "session=fake; Path=/",
      userId: "user-aia",
    }),
  });
  assert.equal(success.status, 302);
  assert.equal(success.redirectTo, "/account?passkey=success");
  assert.doesNotMatch(success.redirectTo, /eyJ|id_token|access_token/);
  assert.ok(success.setCookies.some((c) => c.startsWith("session=")));

  const cancelled = await handleOidcCallback({
    code: null,
    state: "state-cancel",
    kcActionStatus: "cancelled",
    config: cfg,
    consumeState: async () => ({
      nonce: "n",
      codeVerifier: "v",
      returnTo: "/account",
    }),
  });
  assert.equal(cancelled.status, 302);
  assert.equal(cancelled.redirectTo, "/account?passkey=cancelled");
  assert.deepEqual(cancelled.setCookies, []);

  const errored = await handleOidcCallback({
    code: null,
    state: null,
    kcActionStatus: "error",
    config: cfg,
  });
  assert.equal(errored.redirectTo, "/account?passkey=error");
});

await check("account UI uses AIA add/remove paths (not account console)", async () => {
  const account = readFileSync(join(root, "src/app/account/page.tsx"), "utf8");
  assert.match(account, /passkeyAddPath/);
  assert.match(account, /\/api\/auth\/oidc\/passkey\/remove/);
  assert.match(account, /\/api\/auth\/oidc\/passkey/);
  assert.match(account, /จัดการ passkey/);
  assert.match(account, /เพิ่ม passkey/);
  assert.doesNotMatch(account, /account\/#\/account-security/);
  const authCfg = readFileSync(
    join(root, "src/app/api/auth-config/route.ts"),
    "utf8",
  );
  assert.match(authCfg, /\/api\/auth\/oidc\/passkey\/add/);
  const proxy = readFileSync(join(root, "src/proxy.ts"), "utf8");
  // Legacy Better Auth passkey still 404; OIDC AIA paths are under /oidc/passkey
  assert.match(proxy, /\/api\/auth\/passkey/);
  assert.doesNotMatch(proxy, /\/api\/auth\/oidc\/passkey/);
});

if (failed > 0) {
  console.error(`\n${failed} oidc-passkey-aia unit test(s) failed`);
  process.exit(1);
}
console.log("\nAll oidc-passkey-aia unit tests passed");
