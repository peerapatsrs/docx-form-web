import { describe, expect, it } from "vitest";
import {
  createOidcAuthRequestSecrets,
  pkceChallengeS256,
} from "../src/core/pkce.js";
import { createTestClient } from "./helpers.js";
import {
  buildOidcPasskeyDeleteAction,
  getOidcPasskeyAddAction,
} from "../src/core/passkey.js";

describe("PKCE", () => {
  it("S256 is stable for a verifier", async () => {
    const a = await pkceChallengeS256("verifier-abc");
    const b = await pkceChallengeS256("verifier-abc");
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("createOidcAuthRequestSecrets yields distinct values", async () => {
    const s = await createOidcAuthRequestSecrets();
    expect(s.state).not.toBe(s.nonce);
    expect(s.codeChallenge).toBe(await pkceChallengeS256(s.codeVerifier));
  });
});

describe("authorize URL", () => {
  it("interactive: PKCE S256, no max_age, no prompt=login", async () => {
    const { client } = await createTestClient();
    const result = await client.startInteractiveLogin({ returnTo: "/app" });
    expect(result.status).toBe(302);
    const url = new URL(result.redirectTo!);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.has("max_age")).toBe(false);
    expect(url.searchParams.get("prompt")).not.toBe("login");
    expect(url.searchParams.get("client_id")).toBe("test-client");
  });

  it("silent: prompt=none only", async () => {
    const { client } = await createTestClient();
    const result = await client.startSilentLogin({ returnTo: "/?sso=1" });
    expect(result.status).toBe(302);
    const url = new URL(result.redirectTo!);
    expect(url.searchParams.get("prompt")).toBe("none");
    expect(url.searchParams.has("max_age")).toBe(false);
    expect(result.headers?.["Referrer-Policy"]).toBe("no-referrer");
  });

  it("supports kc_idp_hint", async () => {
    const { client } = await createTestClient();
    const result = await client.startInteractiveLogin({
      kcIdpHint: "google",
    });
    const url = new URL(result.redirectTo!);
    expect(url.searchParams.get("kc_idp_hint")).toBe("google");
  });

  it("passkey AIA: kc_action, no prompt, no max_age, scope openid", async () => {
    const { client } = await createTestClient();
    const add = await client.startPasskeyAdd({ returnTo: "/settings" });
    const addUrl = new URL(add.redirectTo!);
    expect(addUrl.searchParams.get("kc_action")).toBe(
      getOidcPasskeyAddAction(),
    );
    expect(addUrl.searchParams.get("scope")).toBe("openid");
    expect(addUrl.searchParams.has("prompt")).toBe(false);
    expect(addUrl.searchParams.has("max_age")).toBe(false);

    const remove = await client.startPasskeyRemove({
      credentialId: "cred_abc-123",
      returnTo: "/settings",
    });
    const rmUrl = new URL(remove.redirectTo!);
    expect(rmUrl.searchParams.get("kc_action")).toBe(
      buildOidcPasskeyDeleteAction("cred_abc-123"),
    );
    expect(rmUrl.searchParams.has("prompt")).toBe(false);
    expect(rmUrl.searchParams.has("max_age")).toBe(false);
  });
});
