import { describe, expect, it } from "vitest";
import { createTestClient } from "./helpers.js";

describe("callback + silent quiet fail", () => {
  it("silent IdP error lands with no-referrer and strips sso", async () => {
    const { client, state } = await createTestClient();
    await state.save({
      state: "st-silent",
      nonce: "n1",
      codeVerifier: "v".repeat(43),
      returnTo: "/packages?sso=1&y=2",
      silent: true,
      viaBypass: true,
      expiresAt: Date.now() + 60_000,
    });

    const result = await client.handleCallback({
      url: "https://app.test/api/auth/oidc/callback?error=login_required&state=st-silent",
    });
    expect(result.status).toBe(302);
    expect(result.redirectTo).toContain("/api/auth/oidc/silent/land");
    expect(result.redirectTo).toContain(encodeURIComponent("/packages?y=2"));
    expect(result.headers?.["Referrer-Policy"]).toBe("no-referrer");
    expect(result.setCookies?.[0]?.value).toMatch(/:0:1$/); // pending=0 bypassUsed=1
  });

  it("interactive error goes to login?error=", async () => {
    const { client, state } = await createTestClient();
    await state.save({
      state: "st-int",
      nonce: "n2",
      codeVerifier: "v".repeat(43),
      returnTo: "/account",
      silent: false,
      expiresAt: Date.now() + 60_000,
    });
    const result = await client.handleCallback({
      url: "https://app.test/api/auth/oidc/callback?error=login_required&state=st-int",
    });
    expect(result.redirectTo).toContain("/login?error=oidc_login_required");
  });

  it("successful callback stores sid/sub and clears cooldown", async () => {
    const { client, idp, sessions, state } = await createTestClient();
    const secrets = {
      state: "st-ok",
      nonce: "nonce-ok",
      codeVerifier: "verifier_" + "x".repeat(40),
    };
    await state.save({
      ...secrets,
      returnTo: "/app?sso=1",
      silent: false,
      expiresAt: Date.now() + 60_000,
    });
    idp.registerCode("code-1", {
      nonce: secrets.nonce,
      sub: "sub-ok",
      sid: "sid-ok",
    });

    const result = await client.handleCallback({
      url: "https://app.test/api/auth/oidc/callback?code=code-1&state=st-ok",
    });
    expect(result.status).toBe(302);
    expect(result.redirectTo).toBe("/app");
    const sessionCookie = result.setCookies?.find((c) => c.name === "mw_session");
    expect(sessionCookie?.value).toBeTruthy();
    const saved = await sessions.get(sessionCookie!.value);
    expect(saved?.sub).toBe("sub-ok");
    expect(saved?.sid).toBe("sid-ok");
    expect(
      result.setCookies?.some(
        (c) => c.name === "mw_sso_checked" && c.attributes.maxAge === 0,
      ),
    ).toBe(true);
  });

  it("onSilentLoginSuccess can redirect at login time only", async () => {
    const { client, idp, state } = await createTestClient(
      {},
      {
        onSilentLoginSuccess: async () => "/create-shop",
      },
    );
    await state.save({
      state: "st-hook",
      nonce: "n-hook",
      codeVerifier: "verifier_" + "y".repeat(40),
      returnTo: "/packages",
      silent: true,
      expiresAt: Date.now() + 60_000,
    });
    idp.registerCode("code-hook", {
      nonce: "n-hook",
      sub: "sub-new",
      sid: "sid-new",
    });
    const result = await client.handleCallback({
      url: "https://app.test/callback?code=code-hook&state=st-hook",
    });
    expect(result.redirectTo).toBe("/create-shop");
  });

  it("land hop sets no-referrer", async () => {
    const { client } = await createTestClient();
    const land = client.land({ next: "//evil.example" });
    expect(land.redirectTo).toBe("/");
    expect(land.headers?.["Referrer-Policy"]).toBe("no-referrer");
  });
});
