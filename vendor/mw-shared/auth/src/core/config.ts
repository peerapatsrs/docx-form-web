import type { MwAuthConfig, MwAuthPaths } from "./types.js";

export const DEFAULT_PATHS: MwAuthPaths = {
  login: "/api/auth/oidc/login",
  silent: "/api/auth/oidc/silent",
  silentLand: "/api/auth/oidc/silent/land",
  callback: "/api/auth/oidc/callback",
  logout: "/api/auth/oidc/logout",
  backchannelLogout: "/api/auth/oidc/backchannel-logout",
  passkeyAdd: "/api/auth/oidc/passkey/add",
  passkeyRemove: "/api/auth/oidc/passkey/remove",
  postLogout: "/logged-out",
};

export const DEFAULT_COOLDOWN_SEC = 60;
export const DEFAULT_STATE_TTL_SEC = 600;
export const DEFAULT_CLOCK_TOLERANCE_SEC = 60;
export const DEFAULT_PASSKEY_ADD_ACTION = "webauthn-register-passwordless";
export const DEFAULT_COOLDOWN_COOKIE = "mw_sso_checked";
export const DEFAULT_ID_TOKEN_COOKIE = "mw_oidc_id_token";
export const DEFAULT_OIDC_FLAG_COOKIE = "mw_oidc";
export const DEFAULT_JWT_ALGS = ["RS256", "ES256"] as const;

export type ResolvedAuthConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  publicOrigin: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  scopes: string[];
  cooldownCookieName: string;
  idTokenCookieName: string;
  oidcFlagCookieName: string;
  cooldownSec: number;
  hubOrigins: string[];
  clockToleranceSec: number;
  /** Skew window for id_token_hint freshness on RP logout. */
  idTokenHintFreshnessSec: number;
  stateTtlSec: number;
  passkeyAddAction: string;
  secureCookies: boolean;
  paths: MwAuthPaths;
  kcIdpHint: string | null;
  allowedJwtAlgs: ReadonlyArray<"RS256" | "ES256">;
};

function stripSlash(url: string): string {
  return url.replace(/\/$/, "");
}

function joinOriginPath(origin: string, path: string): string {
  const base = stripSlash(origin);
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}

export function normalizeHubOrigins(raw: string[] | undefined): string[] {
  if (!raw || raw.length === 0) return [];
  const out: string[] = [];
  for (const item of raw) {
    const trimmed = String(item || "")
      .trim()
      .replace(/\/$/, "");
    if (!trimmed) continue;
    try {
      out.push(new URL(trimmed).origin);
    } catch {
      // skip invalid
    }
  }
  return out;
}

/**
 * Resolve typed runtime config with sane defaults.
 * Throws if required fields are missing / invalid.
 * Never reads process.env — callers pass values.
 */
export function resolveAuthConfig(input: MwAuthConfig): ResolvedAuthConfig {
  const issuer = stripSlash(String(input.issuer || "").trim());
  const clientId = String(input.clientId || "").trim();
  const clientSecret = String(input.clientSecret || "").trim();
  const publicOrigin = stripSlash(String(input.publicOrigin || "").trim());

  if (!issuer || !clientId || !clientSecret || !publicOrigin) {
    throw new Error("MW_AUTH_CONFIG_INCOMPLETE");
  }
  let issuerUrl: URL;
  let originUrl: URL;
  try {
    issuerUrl = new URL(issuer);
    originUrl = new URL(publicOrigin);
  } catch {
    throw new Error("MW_AUTH_CONFIG_INVALID_URL");
  }
  if (
    (issuerUrl.protocol !== "http:" && issuerUrl.protocol !== "https:") ||
    (originUrl.protocol !== "http:" && originUrl.protocol !== "https:")
  ) {
    throw new Error("MW_AUTH_CONFIG_INVALID_PROTOCOL");
  }

  const paths: MwAuthPaths = { ...DEFAULT_PATHS, ...input.paths };
  const secureCookies =
    input.secureCookies ?? originUrl.protocol === "https:";

  const cooldownSec =
    input.cooldownSec != null &&
    Number.isFinite(input.cooldownSec) &&
    input.cooldownSec >= 0
      ? Math.floor(input.cooldownSec)
      : DEFAULT_COOLDOWN_SEC;

  return {
    issuer,
    clientId,
    clientSecret,
    publicOrigin,
    redirectUri:
      input.redirectUri?.trim() || joinOriginPath(publicOrigin, paths.callback),
    postLogoutRedirectUri:
      input.postLogoutRedirectUri?.trim() ||
      joinOriginPath(publicOrigin, paths.postLogout),
    scopes:
      input.scopes && input.scopes.length > 0
        ? [...input.scopes]
        : ["openid", "email", "profile"],
    cooldownCookieName: input.cooldownCookieName || DEFAULT_COOLDOWN_COOKIE,
    idTokenCookieName: input.idTokenCookieName || DEFAULT_ID_TOKEN_COOKIE,
    oidcFlagCookieName: input.oidcFlagCookieName || DEFAULT_OIDC_FLAG_COOKIE,
    cooldownSec,
    hubOrigins: normalizeHubOrigins(input.hubOrigins),
    clockToleranceSec: input.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC,
    idTokenHintFreshnessSec:
      input.idTokenHintFreshnessSec != null &&
      Number.isFinite(input.idTokenHintFreshnessSec) &&
      input.idTokenHintFreshnessSec >= 0
        ? Math.floor(input.idTokenHintFreshnessSec)
        : (input.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC),
    stateTtlSec: input.stateTtlSec ?? DEFAULT_STATE_TTL_SEC,
    passkeyAddAction: input.passkeyAddAction || DEFAULT_PASSKEY_ADD_ACTION,
    secureCookies,
    paths,
    kcIdpHint: input.kcIdpHint ?? null,
    allowedJwtAlgs: input.allowedJwtAlgs ?? DEFAULT_JWT_ALGS,
  };
}

/** Build config from a plain env-like record (caller supplies the map at runtime). */
export function configFromEnv(
  env: Record<string, string | undefined>,
  overrides: Partial<MwAuthConfig> = {},
): MwAuthConfig {
  const hub = String(env.OIDC_SSO_HUB_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const cooldownRaw = String(
    env.OIDC_SSO_COOLDOWN_SEC || env.SILENT_SSO_COOLDOWN_SEC || "",
  ).trim();
  const cooldownSec = cooldownRaw
    ? Number(cooldownRaw)
    : overrides.cooldownSec;

  const publicOrigin = String(
    overrides.publicOrigin ||
      env.APP_PUBLIC_ORIGIN ||
      env.APP_BASE_URL ||
      env.API_PUBLIC_ORIGIN ||
      env.PUBLIC_APP_URL ||
      "",
  ).trim();

  return {
    issuer: overrides.issuer ?? String(env.OIDC_ISSUER || "").trim(),
    clientId: overrides.clientId ?? String(env.OIDC_CLIENT_ID || "").trim(),
    clientSecret:
      overrides.clientSecret ?? String(env.OIDC_CLIENT_SECRET || "").trim(),
    publicOrigin,
    redirectUri: overrides.redirectUri ?? env.OIDC_REDIRECT_URI,
    postLogoutRedirectUri:
      overrides.postLogoutRedirectUri ?? env.OIDC_POST_LOGOUT_REDIRECT_URI,
    cooldownSec:
      cooldownSec != null && Number.isFinite(cooldownSec)
        ? cooldownSec
        : undefined,
    hubOrigins: overrides.hubOrigins ?? hub,
    passkeyAddAction:
      overrides.passkeyAddAction ?? env.OIDC_PASSKEY_ADD_ACTION,
    kcIdpHint: overrides.kcIdpHint ?? env.OIDC_IDP_HINT ?? null,
    paths: overrides.paths,
    scopes: overrides.scopes,
    secureCookies: overrides.secureCookies,
    cooldownCookieName: overrides.cooldownCookieName,
    idTokenCookieName: overrides.idTokenCookieName,
    oidcFlagCookieName: overrides.oidcFlagCookieName,
    clockToleranceSec: overrides.clockToleranceSec,
    idTokenHintFreshnessSec: (() => {
      if (overrides.idTokenHintFreshnessSec != null) {
        return overrides.idTokenHintFreshnessSec;
      }
      const raw = String(
        env.OIDC_LOGOUT_ID_TOKEN_FRESHNESS_SEC || "",
      ).trim();
      if (!raw) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    })(),
    stateTtlSec: overrides.stateTtlSec,
    allowedJwtAlgs: overrides.allowedJwtAlgs,
  };
}
