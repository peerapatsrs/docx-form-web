import { describe, expect, it } from "vitest";
import {
  resolveAuthConfig,
  configFromEnv,
  DEFAULT_PATHS,
} from "../src/core/config.js";

describe("resolveAuthConfig", () => {
  it("applies sane defaults without hardcoded hosts", () => {
    const cfg = resolveAuthConfig({
      issuer: "https://auth.example/realms/dev",
      clientId: "app",
      clientSecret: "secret",
      publicOrigin: "https://app.example",
    });
    expect(cfg.redirectUri).toBe(
      `https://app.example${DEFAULT_PATHS.callback}`,
    );
    expect(cfg.postLogoutRedirectUri).toBe(
      `https://app.example${DEFAULT_PATHS.postLogout}`,
    );
    expect(cfg.cooldownSec).toBe(60);
    expect(cfg.cooldownCookieName).toBe("mw_sso_checked");
    expect(cfg.scopes).toEqual(["openid", "email", "profile"]);
    expect(JSON.stringify(cfg)).not.toMatch(/tps18\.space/);
  });

  it("throws MW_AUTH_* on incomplete / bad URLs", () => {
    expect(() =>
      resolveAuthConfig({
        issuer: "",
        clientId: "a",
        clientSecret: "b",
        publicOrigin: "https://x",
      }),
    ).toThrow(/MW_AUTH_CONFIG_INCOMPLETE/);
    expect(() =>
      resolveAuthConfig({
        issuer: "not-a-url",
        clientId: "a",
        clientSecret: "b",
        publicOrigin: "https://x",
      }),
    ).toThrow(/MW_AUTH_CONFIG_INVALID/);
  });
});

describe("configFromEnv", () => {
  it("maps env at call time only", () => {
    const cfg = configFromEnv({
      OIDC_ISSUER: "https://auth.example/realms/sit",
      OIDC_CLIENT_ID: "c",
      OIDC_CLIENT_SECRET: "s",
      APP_PUBLIC_ORIGIN: "https://app.example",
      OIDC_SSO_HUB_ORIGINS: "https://hub.example/",
      SILENT_SSO_COOLDOWN_SEC: "30",
    });
    const resolved = resolveAuthConfig(cfg);
    expect(resolved.issuer).toBe("https://auth.example/realms/sit");
    expect(resolved.hubOrigins).toEqual(["https://hub.example"]);
    expect(resolved.cooldownSec).toBe(30);
  });
});
