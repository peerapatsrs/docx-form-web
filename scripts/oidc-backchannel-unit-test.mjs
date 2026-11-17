#!/usr/bin/env node
/**
 * Back-channel logout: valid logout_token kills sessions; bad sig/alg/iss/aud/replay → 400.
 */
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createAuthClient, MemorySessionStore, MemoryStateStore } from "../vendor/mw-shared/auth/dist/index.js";

const ISSUER = "https://auth.example/realms/tps18-dev";
const CLIENT_ID = "docx-form-web";
const CLIENT_SECRET = "test-secret";
const APP = "https://app.example.com";

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${name}`);
    console.error(err);
  }
}

console.log("oidc-backchannel-unit-test");

const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = await exportJWK(publicKey);
jwk.kid = "bc-test-1";
jwk.alg = "RS256";
jwk.use = "sig";

const discovery = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/auth`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/certs`,
  end_session_endpoint: `${ISSUER}/logout`,
};

async function mintLogoutToken(claims, alg = "RS256", key = privateKey) {
  let builder = new SignJWT({
    events: { "http://schemas.openid.net/event/backchannel-logout": {} },
    ...claims,
  })
    .setProtectedHeader({ alg, kid: "bc-test-1" })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime("2h")
    .setJti(claims.jti || `jti-${Date.now()}-${Math.random()}`);
  if (claims.sub) builder = builder.setSubject(claims.sub);
  return builder.sign(key);
}

function makeClient(sessions, state) {
  const fetchFn = async (url) => {
    const u = String(url);
    if (u.includes("openid-configuration") || u.endsWith("/.well-known/openid-configuration")) {
      return new Response(JSON.stringify(discovery), { status: 200 });
    }
    if (u.includes("/certs") || u.includes("jwks")) {
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  return createAuthClient({
    config: {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      publicOrigin: APP,
    },
    deps: {
      sessions,
      state,
      users: {
        async resolve() {
          return { userId: "u1", linkedBy: "identity" };
        },
      },
      fetch: fetchFn,
    },
  });
}

await check("valid logout_token deletes session by sid", async () => {
  const sessions = new MemorySessionStore();
  const state = new MemoryStateStore();
  await sessions.create({
    sessionId: "tok-1",
    userId: "user-1",
    sub: "sub-1",
    sid: "sid-abc",
  });
  await sessions.create({
    sessionId: "tok-2",
    userId: "user-1",
    sub: "sub-1",
    sid: "sid-other",
  });
  const client = makeClient(sessions, state);
  const token = await mintLogoutToken({ sub: "sub-1", sid: "sid-abc", jti: "jti-ok-1" });
  const result = await client.handleBackchannelLogout({ logoutToken: token });
  assert.equal(result.status, 200);
  assert.equal(result.headers?.["Cache-Control"], "no-store");
  assert.equal(await sessions.get("tok-1"), null);
  assert.ok(await sessions.get("tok-2"));
});

await check("valid logout_token falls back to sub when no sid match", async () => {
  const sessions = new MemorySessionStore();
  const state = new MemoryStateStore();
  await sessions.create({
    sessionId: "tok-sub",
    userId: "user-2",
    sub: "sub-only",
    sid: null,
  });
  const client = makeClient(sessions, state);
  const token = await mintLogoutToken({ sub: "sub-only", jti: "jti-ok-2" });
  const result = await client.handleBackchannelLogout({ logoutToken: token });
  assert.equal(result.status, 200);
  assert.equal(await sessions.get("tok-sub"), null);
});

await check("bad signature → 400", async () => {
  const { privateKey: other } = await generateKeyPair("RS256");
  const sessions = new MemorySessionStore();
  const state = new MemoryStateStore();
  const client = makeClient(sessions, state);
  const token = await mintLogoutToken({ sub: "s", sid: "x", jti: "jti-bad-sig" }, "RS256", other);
  const result = await client.handleBackchannelLogout({ logoutToken: token });
  assert.equal(result.status, 400);
});

await check("HS256 alg rejected → 400", async () => {
  const sessions = new MemorySessionStore();
  const state = new MemoryStateStore();
  const client = makeClient(sessions, state);
  // Craft header claiming HS256 — jose SignJWT with HS needs secret; use raw invalid.
  const fake =
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url") +
    "." +
    Buffer.from(
      JSON.stringify({
        iss: ISSUER,
        aud: CLIENT_ID,
        sub: "s",
        jti: "jti-hs",
        events: { "http://schemas.openid.net/event/backchannel-logout": {} },
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url") +
    ".sig";
  const result = await client.handleBackchannelLogout({ logoutToken: fake });
  assert.equal(result.status, 400);
});

await check("wrong iss → 400", async () => {
  const sessions = new MemorySessionStore();
  const state = new MemoryStateStore();
  const client = makeClient(sessions, state);
  const token = await new SignJWT({
    events: { "http://schemas.openid.net/event/backchannel-logout": {} },
    sub: "s",
    sid: "x",
  })
    .setProtectedHeader({ alg: "RS256", kid: "bc-test-1" })
    .setIssuer("https://evil.example/realms/x")
    .setAudience(CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime("2h")
    .setJti("jti-bad-iss")
    .sign(privateKey);
  const result = await client.handleBackchannelLogout({ logoutToken: token });
  assert.equal(result.status, 400);
});

await check("wrong aud → 400", async () => {
  const sessions = new MemorySessionStore();
  const state = new MemoryStateStore();
  const client = makeClient(sessions, state);
  const token = await new SignJWT({
    events: { "http://schemas.openid.net/event/backchannel-logout": {} },
    sub: "s",
    sid: "x",
  })
    .setProtectedHeader({ alg: "RS256", kid: "bc-test-1" })
    .setIssuer(ISSUER)
    .setAudience("other-client")
    .setIssuedAt()
    .setExpirationTime("2h")
    .setJti("jti-bad-aud")
    .sign(privateKey);
  const result = await client.handleBackchannelLogout({ logoutToken: token });
  assert.equal(result.status, 400);
});

await check("replay jti → 400", async () => {
  const sessions = new MemorySessionStore();
  const state = new MemoryStateStore();
  const client = makeClient(sessions, state);
  await sessions.create({
    sessionId: "tok-r",
    userId: "u",
    sub: "sub-r",
    sid: "sid-r",
  });
  const token = await mintLogoutToken({ sub: "sub-r", sid: "sid-r", jti: "jti-replay" });
  const first = await client.handleBackchannelLogout({ logoutToken: token });
  assert.equal(first.status, 200);
  const second = await client.handleBackchannelLogout({ logoutToken: token });
  assert.equal(second.status, 400);
});

await check("route file mounts backchannel-logout", async () => {
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const route = readFileSync(
    join(root, "src/app/api/auth/oidc/backchannel-logout/route.ts"),
    "utf8",
  );
  assert.match(route, /backchannel-logout/);
  assert.match(route, /runMwOidcHandler/);
  const apiDoc = readFileSync(join(root, "docs/API-AI-KEYS-AND-SKIP.md"), "utf8");
  void apiDoc;
});

if (failed) {
  console.error(`oidc-backchannel-unit-test: ${failed} failed`);
  process.exit(1);
}
console.log("oidc-backchannel-unit-test: ok");
