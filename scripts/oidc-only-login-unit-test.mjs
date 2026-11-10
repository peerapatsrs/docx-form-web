#!/usr/bin/env node
/**
 * OIDC-only login integration-style unit tests with a local mock IdP
 * (discovery + JWKS + token + end_session).
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
    "APP_BASE_URL",
    "NEXT_PUBLIC_APP_URL",
    "BETTER_AUTH_URL",
    "ENABLE_PASSWORD_LOGIN",
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

const ISSUER = "https://auth.tps18.space/realms/tps18-dev";
const CLIENT_ID = "docx-form-web";
const CLIENT_SECRET = "test-secret";
const APP = "https://app.example.com";

async function load(mod) {
  return import(`../${mod}?t=${Date.now()}-${Math.random()}`);
}

function memoryDb() {
  const identities = new Map();
  const users = new Map();
  const states = new Map();
  const query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (s.startsWith("CREATE TABLE") || s.startsWith("CREATE INDEX")) {
      return { rows: [], rowCount: 0 };
    }
    if (s.includes("FROM identities") && s.includes("issuer = $1")) {
      const row = identities.get(`${params[0]}|${params[1]}`);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (s.includes('FROM "user"') && s.includes("lower(email)")) {
      return { rows: [], rowCount: 0 };
    }
    if (s.includes('INSERT INTO "user"')) {
      const [id, name, email, emailVerified, image, role, plan] = params;
      users.set(id, { id, name, email, emailVerified, image, role, plan });
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("INSERT INTO identities")) {
      const [id, issuer, subject, userId, email, emailVerified] = params;
      const row = { id, issuer, subject, userId, email, emailVerified };
      identities.set(`${issuer}|${subject}`, row);
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("UPDATE identities")) {
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("INSERT INTO oidc_login_state")) {
      const [state, nonce, codeVerifier, returnTo] = params;
      states.set(state, {
        state,
        nonce,
        codeVerifier,
        returnTo,
        expiresAt: new Date(Date.now() + 600_000),
      });
      return { rows: [], rowCount: 1 };
    }
    if (s.includes("DELETE FROM oidc_login_state")) {
      const row = states.get(params[0]);
      states.delete(params[0]);
      return {
        rows: row
          ? [
              {
                nonce: row.nonce,
                codeVerifier: row.codeVerifier,
                returnTo: row.returnTo,
                expiresAt: row.expiresAt,
              },
            ]
          : [],
        rowCount: row ? 1 : 0,
      };
    }
    throw new Error(`unexpected SQL: ${s.slice(0, 100)}`);
  };
  return { identities, users, states, query };
}

function mockDiscoveryFetch(meta) {
  return async (url, init) => {
    const u = String(url);
    if (u.includes(".well-known/openid-configuration")) {
      return new Response(JSON.stringify(meta), { status: 200 });
    }
    if (u.includes("/token") && init?.method === "POST") {
      // Caller supplies id_token via closure — set on meta.__tokenResponse
      return new Response(JSON.stringify(meta.__tokenResponse || {}), {
        status: 200,
      });
    }
    return new Response("not found", { status: 404 });
  };
}

await check("login page is server OIDC redirect (no chooser / SSO button)", async () => {
  const login = readFileSync(join(root, "src/app/login/page.tsx"), "utf8");
  assert.match(login, /buildOidcAuthorizationRedirect/);
  assert.match(login, /SSO not configured/);
  assert.doesNotMatch(login, /เข้าด้วย TPS18 SSO/);
  assert.doesNotMatch(login, /signInSocial|passkey|test-accounts|DevPicker/);
  assert.doesNotMatch(login, /"use client"/);
});

await check("old DEV / social / passkey routes and modules are gone", async () => {
  const files = [
    "src/server/dev-auth-plugin.ts",
    "src/server/dev-test-accounts.ts",
    "src/components/DevAuthControls.tsx",
    "docs/FE-DEV-TEST-LOGIN.md",
    "docs/DEV-TEST-ACCOUNTS.md",
  ];
  for (const f of files) {
    let exists = true;
    try {
      readFileSync(join(root, f));
    } catch {
      exists = false;
    }
    assert.equal(exists, false, f);
  }
  const auth = readFileSync(join(root, "src/server/auth.ts"), "utf8");
  assert.doesNotMatch(auth, /from "@better-auth\/passkey"/);
  assert.doesNotMatch(auth, /devAuthPlugin|buildSocialProviders/);
  assert.doesNotMatch(auth, /passkey\(/);
  assert.match(auth, /emailAndPassword:\s*\{\s*enabled:\s*false/);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.dependencies["@better-auth/passkey"], undefined);
  const api = readFileSync(join(root, "src/server/api.ts"), "utf8");
  assert.match(api, /Removed DEV test-login/);
});

await check("authorize redirect includes PKCE S256 + state + nonce to issuer", async () => {
  process.env.OIDC_ISSUER = ISSUER;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET;
  process.env.APP_BASE_URL = APP;
  const { getOidcConfig } = await load("src/server/oidc-config.ts");
  const { createOidcAuthRequestSecrets, pkceChallengeS256 } = await load(
    "src/server/oidc-pkce.ts",
  );
  const { clearOidcDiscoveryCache, fetchOidcDiscovery } = await load(
    "src/server/oidc-discovery.ts",
  );
  const identities = await load("src/server/oidc-identities.ts");
  identities.resetOidcIdentitiesSchemaGate();
  const db = memoryDb();
  await identities.ensureOidcIdentitiesSchema(db.query);
  clearOidcDiscoveryCache();
  const cfg = getOidcConfig();
  const meta = await fetchOidcDiscovery(ISSUER, {
    bypassCache: true,
    fetch: mockDiscoveryFetch({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
      token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
      jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
      end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
    }),
  });
  const secrets = createOidcAuthRequestSecrets();
  await identities.saveOidcLoginState({
    state: secrets.state,
    nonce: secrets.nonce,
    codeVerifier: secrets.codeVerifier,
    returnTo: "/account",
    query: db.query,
  });
  const url = new URL(meta.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("scope", cfg.scopes.join(" "));
  url.searchParams.set("state", secrets.state);
  url.searchParams.set("nonce", secrets.nonce);
  url.searchParams.set("code_challenge", secrets.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  assert.equal(url.origin + url.pathname, `${ISSUER}/protocol/openid-connect/auth`);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("code_challenge"),
    pkceChallengeS256(secrets.codeVerifier),
  );
  assert.ok(url.searchParams.get("state"));
  assert.ok(url.searchParams.get("nonce"));
  assert.equal(cfg.postLogoutRedirectUri, `${APP}/logged-out`);
});

await check("callback creates user/session path; open redirects rejected", async () => {
  const { validateOidcIdToken } = await load("src/server/oidc-id-token.ts");
  const identities = await load("src/server/oidc-identities.ts");
  identities.resetOidcIdentitiesSchemaGate();
  const db = memoryDb();
  await identities.ensureOidcIdentitiesSchema(db.query);
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "k1";
  jwk.alg = "RS256";
  const nonce = "n-1";
  const idToken = await new SignJWT({
    email: "owner@example.com",
    email_verified: true,
    name: "Owner",
    nonce,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setSubject("sub-owner")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
  const claims = await validateOidcIdToken({
    idToken,
    issuer: ISSUER,
    clientId: CLIENT_ID,
    nonce,
    jwksUri: `${ISSUER}/certs`,
    jwks: { keys: [jwk] },
  });
  const resolved = await identities.resolveUserForOidcClaims(claims, {
    query: db.query,
  });
  assert.ok(resolved.userId);
  assert.equal(resolved.linkedBy, "created");
  assert.equal(identities.safeOidcReturnTo("//evil.com", "/", APP), "/");
  assert.equal(identities.safeOidcReturnTo("/\\evil.com", "/", APP), "/");
  assert.equal(identities.safeOidcReturnTo("/%2Fevil", "/", APP), "/");
  assert.equal(identities.safeOidcReturnTo("/account", "/", APP), "/account");
});

await check("logout redirects to end_session with post_logout=/logged-out", async () => {
  process.env.OIDC_ISSUER = ISSUER;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = CLIENT_SECRET;
  process.env.APP_BASE_URL = APP;
  const { getOidcConfig } = await load("src/server/oidc-config.ts");
  const { buildOidcLogoutRedirect } = await load("src/server/oidc-flow.ts");
  const { clearOidcDiscoveryCache } = await load("src/server/oidc-discovery.ts");
  clearOidcDiscoveryCache();
  const cfg = getOidcConfig();
  const result = await buildOidcLogoutRedirect({
    config: cfg,
    idTokenHint: "eyJhbGciOiJSUzI1NiJ9.hint.sig",
    clearSession: async () => ["session=; Max-Age=0"],
    fetchFn: mockDiscoveryFetch({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/auth`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/certs`,
      end_session_endpoint: `${ISSUER}/logout`,
    }),
  });
  assert.equal(result.status, 302);
  assert.match(result.redirectTo, /\/logout\?/);
  assert.match(result.redirectTo, /post_logout_redirect_uri=/);
  assert.match(
    decodeURIComponent(result.redirectTo),
    /\/logged-out/,
  );
  assert.match(result.redirectTo, /id_token_hint=/);
  assert.equal(cfg.postLogoutRedirectUri, `${APP}/logged-out`);
});

await check("AuthBar / account logout go to /api/auth/oidc/logout", async () => {
  const bar = readFileSync(join(root, "src/components/AuthBar.tsx"), "utf8");
  assert.match(bar, /\/api\/auth\/oidc\/logout/);
  assert.doesNotMatch(bar, /DEV_AUTH|loginAsDev|DevAuth/);
  const account = readFileSync(join(root, "src/app/account/page.tsx"), "utf8");
  assert.match(account, /\/api\/auth\/oidc\/logout/);
  assert.doesNotMatch(account, /passkey\.|linkSocial|unlinkAccount/);
});

await check("missing OIDC env does not enable soft social/password fallback", async () => {
  const { isOidcEnabled, getOidcConfig } = await load("src/server/oidc-config.ts");
  assert.equal(isOidcEnabled(), false);
  assert.equal(getOidcConfig(), null);
  const authCfg = readFileSync(
    join(root, "src/app/api/auth-config/route.ts"),
    "utf8",
  );
  assert.match(authCfg, /passkey:\s*false/);
  assert.match(authCfg, /passwordLogin:\s*false/);
  assert.match(authCfg, /providers:\s*\[\]/);
});

if (failed > 0) {
  console.error(`\n${failed} oidc-only-login unit test(s) failed`);
  process.exit(1);
}
console.log("\nAll oidc-only-login unit tests passed");
