import { getAppBaseUrl, getBetterAuthBaseUrl } from "@/lib/app-base-url";

export type OidcConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Public app origin used for redirect / post-logout URIs (no trailing slash). */
  publicBaseUrl: string;
  /** Auth origin (may equal publicBaseUrl). */
  authBaseUrl: string;
  redirectUri: string;
  /**
   * After IdP logout — must NOT be `/login` (that would auto-loop into OIDC).
   * Use `/logged-out` which shows a static page with a manual sign-in link.
   */
  postLogoutRedirectUri: string;
  scopes: string[];
};

function trimSlash(url: string): string {
  return url.replace(/\/$/, "");
}

/**
 * Central Keycloak SSO as a standard OIDC RP — the only login method.
 * Issuer comes only from OIDC_ISSUER (e.g. …/realms/tps18-{env}) — never hardcode realms.
 * Missing env → callers must show SSO-not-configured (no silent fallback).
 */
export function getOidcConfig(
  envSource: NodeJS.ProcessEnv = process.env,
): OidcConfig | null {
  const issuerRaw = String(envSource.OIDC_ISSUER || "").trim();
  const clientId = String(envSource.OIDC_CLIENT_ID || "").trim();
  const clientSecret = String(envSource.OIDC_CLIENT_SECRET || "").trim();
  if (!issuerRaw || !clientId || !clientSecret) return null;

  let issuer: string;
  try {
    const u = new URL(issuerRaw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    issuer = trimSlash(u.toString());
  } catch {
    return null;
  }

  const publicBaseUrl = trimSlash(
    String(
      envSource.APP_BASE_URL ||
        envSource.NEXT_PUBLIC_APP_URL ||
        envSource.BETTER_AUTH_URL ||
        envSource.RENDER_EXTERNAL_URL ||
        "",
    ).trim() || getAppBaseUrl(),
  );
  const authBaseUrl = trimSlash(
    String(envSource.BETTER_AUTH_URL || "").trim() ||
      publicBaseUrl ||
      getBetterAuthBaseUrl(),
  );

  return {
    issuer,
    clientId,
    clientSecret,
    publicBaseUrl,
    authBaseUrl,
    redirectUri: `${publicBaseUrl}/api/auth/oidc/callback`,
    postLogoutRedirectUri: `${publicBaseUrl}/logged-out`,
    scopes: ["openid", "email", "profile"],
  };
}

export function isOidcEnabled(
  envSource: NodeJS.ProcessEnv = process.env,
): boolean {
  return getOidcConfig(envSource) !== null;
}

/** Log once when SSO env is missing (login/API gates). */
export function logOidcNotConfigured(context: string): void {
  console.error(
    `[oidc] SSO not configured (${context}): set OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET`,
  );
}

/**
 * Optional external passkey help/manage URL override.
 * Account-console defaults were removed (blocked for end users) — passkeys use
 * Keycloak AIA via `/api/auth/oidc/passkey/*`. Returns null unless explicitly set.
 */
export function resolveOidcPasskeyManageUrl(
  envSource: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = String(envSource.OIDC_PASSKEY_MANAGE_URL || "").trim();
  if (!explicit) return null;
  try {
    const u = new URL(explicit);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.toString();
  } catch {
    return null;
  }
}
