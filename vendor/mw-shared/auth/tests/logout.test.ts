import { describe, expect, it } from "vitest";
import { createTestClient } from "./helpers.js";
import { createNodeAuthHandler } from "../src/adapters/node-api/index.js";
import { toWebResponse } from "../src/core/http.js";
import { bytesToBase64Url } from "../src/core/crypto.js";

function unsignedJwt(payload: Record<string, unknown>): string {
  const enc = (obj: unknown) =>
    bytesToBase64Url(new TextEncoder().encode(JSON.stringify(obj)));
  return `${enc({ alg: "none", typ: "JWT" })}.${enc(payload)}.sig`;
}

describe("RP-initiated logout", () => {
  it("POST clears local session and 303-redirects as a document navigation", async () => {
    const now = Math.floor(Date.now() / 1000);
    const freshToken = unsignedJwt({
      exp: now + 600,
      iat: now,
      sub: "u",
    });
    const { client, sessions } = await createTestClient({
      postLogoutRedirectUri: "https://app.test/",
      idTokenHintFreshnessSec: 60,
    });
    await sessions.create({
      sessionId: "sess-1",
      userId: "u1",
      sub: "sub-1",
      sid: "sid-1",
      idToken: freshToken,
    });

    const result = await client.logout({
      sessionId: "sess-1",
      idTokenHint: freshToken,
    });
    expect([302, 303]).toContain(result.status);
    expect(result.redirectTo).toContain("/protocol/openid-connect/logout");
    const url = new URL(result.redirectTo!);
    expect(url.searchParams.get("id_token_hint")).toBe(freshToken);
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe(
      "https://app.test/",
    );
    expect(url.searchParams.get("client_id")).toBe("test-client");
    expect(await sessions.get("sess-1")).toBeNull();

    const res = toWebResponse(result);
    expect([302, 303]).toContain(res.status);
    expect(res.headers.get("location")).toBe(result.redirectTo);
    expect(res.body).toBeNull();
  });

  it("omits id_token_hint when the token is stale (hub fallback)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const staleToken = unsignedJwt({
      exp: now - 120,
      iat: now - 3600,
      sub: "u",
    });
    const { client } = await createTestClient({
      postLogoutRedirectUri: "https://app.test/logged-out",
      idTokenHintFreshnessSec: 30,
    });

    const result = await client.logout({ idTokenHint: staleToken });
    expect([302, 303]).toContain(result.status);
    const url = new URL(result.redirectTo!);
    expect(url.searchParams.has("id_token_hint")).toBe(false);
    expect(url.searchParams.get("client_id")).toBe("test-client");
    expect(url.searchParams.get("post_logout_redirect_uri")).toBe(
      "https://app.test/logged-out",
    );
  });

  it("honours configurable freshness window for the hint", async () => {
    const now = Math.floor(Date.now() / 1000);
    // Expired 10s ago — fresh with skew=60, stale with skew=0.
    const almostStale = unsignedJwt({ exp: now - 10, iat: now - 100, sub: "u" });

    const wide = await createTestClient({ idTokenHintFreshnessSec: 60 });
    const wideUrl = new URL(
      (await wide.client.logout({ idTokenHint: almostStale })).redirectTo!,
    );
    expect(wideUrl.searchParams.get("id_token_hint")).toBe(almostStale);

    const tight = await createTestClient({ idTokenHintFreshnessSec: 0 });
    const tightUrl = new URL(
      (await tight.client.logout({ idTokenHint: almostStale })).redirectTo!,
    );
    expect(tightUrl.searchParams.has("id_token_hint")).toBe(false);
    expect(tightUrl.searchParams.get("client_id")).toBe("test-client");
  });

  it("node-api GET logout returns 405; POST returns document redirect", async () => {
    const now = Math.floor(Date.now() / 1000);
    const freshToken = unsignedJwt({ exp: now + 300, iat: now, sub: "u" });
    const { client, sessions } = await createTestClient();
    await sessions.create({
      sessionId: "s2",
      userId: "u",
      sub: "sub",
      idToken: freshToken,
    });
    const handler = createNodeAuthHandler({
      client,
      mountPrefix: "/api/v1/auth/sso",
    });
    const get = await handler(
      new Request("https://app.test/api/v1/auth/sso/logout", {
        method: "GET",
      }),
    );
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toMatch(/POST/i);

    const post = await handler(
      new Request("https://app.test/api/v1/auth/sso/logout", {
        method: "POST",
        headers: {
          cookie: `mw_session=s2; mw_oidc_id_token=${freshToken}`,
        },
      }),
    );
    expect([302, 303]).toContain(post.status);
    const loc = post.headers.get("location");
    expect(loc).toContain("/protocol/openid-connect/logout");
    expect(loc).toContain("id_token_hint=");
  });
});
