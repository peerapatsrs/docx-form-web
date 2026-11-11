import { describe, expect, it } from "vitest";
import { createTestClient } from "./helpers.js";
import { SignJWT, generateKeyPair } from "jose";
import { createAuthClient } from "../src/core/client.js";
import {
  MemorySessionStore,
  MemoryUserResolver,
} from "../src/core/memory-stores.js";
import { BACKCHANNEL_EVENT } from "../src/core/logout-token.js";
import type { StateStore } from "../src/core/interfaces.js";
import type { PendingAuthState } from "../src/core/types.js";

describe("Back-Channel Logout 1.0", () => {
  it("deletes by sid first, else by sub; returns 200 no-store", async () => {
    const { client, sessions, idp } = await createTestClient();
    await sessions.create({
      sessionId: "a",
      userId: "u1",
      sub: "sub-1",
      sid: "sid-1",
    });
    await sessions.create({
      sessionId: "b",
      userId: "u1",
      sub: "sub-1",
      sid: "sid-other",
    });

    const token = await idp.signLogoutToken({
      sub: "sub-1",
      sid: "sid-1",
      jti: "jti-1",
    });
    const res = await client.handleBackchannelLogout({ logoutToken: token });
    expect(res.status).toBe(200);
    expect(res.headers?.["Cache-Control"]).toBe("no-store");
    expect(await sessions.get("a")).toBeNull();
    expect(await sessions.get("b")).not.toBeNull();
  });

  it("falls back to sub when no sid match", async () => {
    const { client, sessions, idp } = await createTestClient();
    await sessions.create({
      sessionId: "c",
      userId: "u2",
      sub: "sub-2",
      sid: null,
    });
    const token = await idp.signLogoutToken({ sub: "sub-2", jti: "jti-2" });
    const res = await client.handleBackchannelLogout({ logoutToken: token });
    expect(res.status).toBe(200);
    expect(await sessions.get("c")).toBeNull();
  });

  it("rejects missing event, nonce, and missing sub+sid", async () => {
    const { client, idp } = await createTestClient();
    const noEvent = await idp.signLogoutToken({
      sub: "x",
      omitEvent: true,
      jti: "j3",
    });
    expect(
      (await client.handleBackchannelLogout({ logoutToken: noEvent })).status,
    ).toBe(400);

    const withNonce = await idp.signLogoutToken({
      sub: "x",
      nonce: "n",
      jti: "j4",
    });
    expect(
      (await client.handleBackchannelLogout({ logoutToken: withNonce }))
        .status,
    ).toBe(400);

    const neither = await idp.signLogoutToken({ jti: "j5" });
    expect(
      (await client.handleBackchannelLogout({ logoutToken: neither })).status,
    ).toBe(400);
  });

  it("rejects missing jti with 400 no-store", async () => {
    const { client, idp } = await createTestClient();
    const token = await idp.signLogoutToken({
      sub: "x",
      omitJti: true,
    });
    const res = await client.handleBackchannelLogout({ logoutToken: token });
    expect(res.status).toBe(400);
    expect(res.headers?.["Cache-Control"]).toBe("no-store");
    expect(res.error).toMatch(/JTI/i);
  });

  it("rejects when StateStore has no seenJti", async () => {
    const { idp } = await createTestClient();
    const stateWithoutReplay: StateStore = {
      async save(_s: PendingAuthState) {},
      async consume() {
        return null;
      },
      // seenJti intentionally missing
    } as StateStore;

    const client = createAuthClient({
      config: {
        issuer: "https://idp.test/realms/dev",
        clientId: "test-client",
        clientSecret: "test-secret",
        publicOrigin: "https://app.test",
      },
      deps: {
        sessions: new MemorySessionStore(),
        state: stateWithoutReplay,
        users: new MemoryUserResolver(),
        fetch: idp.fetch,
      },
    });

    const token = await idp.signLogoutToken({ sub: "x", jti: "no-guard" });
    const res = await client.handleBackchannelLogout({ logoutToken: token });
    expect(res.status).toBe(400);
    expect(res.headers?.["Cache-Control"]).toBe("no-store");
    expect(res.error).toMatch(/REPLAY_GUARD/i);
  });

  it("rejects alg=none", async () => {
    const { client } = await createTestClient();
    const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const now = Math.floor(Date.now() / 1000);
    const payload = btoa(
      JSON.stringify({
        iss: "https://idp.test/realms/dev",
        aud: "test-client",
        iat: now,
        exp: now + 300,
        jti: "none-jti",
        sub: "x",
        events: { [BACKCHANNEL_EVENT]: {} },
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    const noneToken = `${header}.${payload}.`;
    const res = await client.handleBackchannelLogout({
      logoutToken: noneToken,
    });
    expect(res.status).toBe(400);
  });

  it("rejects alg=HS256", async () => {
    const { client } = await createTestClient();
    const now = Math.floor(Date.now() / 1000);
    const secret = new TextEncoder().encode("hs256-secret-key-for-test!!");
    const hs = await new SignJWT({
      sub: "x",
      jti: "hs-jti",
      events: { [BACKCHANNEL_EVENT]: {} },
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("https://idp.test/realms/dev")
      .setAudience("test-client")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(secret);
    const res = await client.handleBackchannelLogout({ logoutToken: hs });
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/ALG/i);
  });

  it("rejects expired exp", async () => {
    const { client, idp } = await createTestClient({
      clockToleranceSec: 5,
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await idp.signLogoutToken({
      sub: "x",
      jti: "expired-jti",
      iat: now - 120,
      exp: now - 60,
    });
    const res = await client.handleBackchannelLogout({ logoutToken: token });
    expect(res.status).toBe(400);
  });

  it("rejects missing exp and stale iat outside clockToleranceSec", async () => {
    const { client, idp } = await createTestClient({
      clockToleranceSec: 30,
    });
    const now = Math.floor(Date.now() / 1000);

    const noExp = await idp.signLogoutToken({
      sub: "x",
      jti: "no-exp",
      omitExp: true,
      iat: now,
    });
    expect(
      (await client.handleBackchannelLogout({ logoutToken: noExp })).status,
    ).toBe(400);

    const staleIat = await idp.signLogoutToken({
      sub: "x",
      jti: "stale-iat",
      iat: now - 600,
      exp: now + 300,
    });
    const staleRes = await client.handleBackchannelLogout({
      logoutToken: staleIat,
    });
    expect(staleRes.status).toBe(400);
    expect(staleRes.error).toMatch(/IAT/i);
  });

  it("guards jti replay", async () => {
    const { client, idp } = await createTestClient();
    const token = await idp.signLogoutToken({
      sub: "sub-r",
      jti: "replay-me",
    });
    expect(
      (await client.handleBackchannelLogout({ logoutToken: token })).status,
    ).toBe(200);
    expect(
      (await client.handleBackchannelLogout({ logoutToken: token })).status,
    ).toBe(400);
  });

  it("rejects wrong audience / forged key", async () => {
    const { client } = await createTestClient();
    const { privateKey } = await generateKeyPair("RS256");
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({
      sub: "x",
      jti: "forged-jti",
      events: { [BACKCHANNEL_EVENT]: {} },
    })
      .setProtectedHeader({ alg: "RS256", kid: "forged" })
      .setIssuer("https://idp.test/realms/dev")
      .setAudience("test-client")
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(privateKey);
    expect(
      (await client.handleBackchannelLogout({ logoutToken: forged })).status,
    ).toBe(400);
  });
});
