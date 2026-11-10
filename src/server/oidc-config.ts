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
  postLogoutRedirectUri: string;
  scopes: string[];
};

function trimSlash(url: string): string {
  return url.replace(/\/$/, "");
}

/**
 * Central Keycloak SSO as a standard OIDC RP.
 * Enabled only when OIDC_ISSUER + OIDC_CLIENT_ID + OIDC_CLIENT_SECRET are set.
 * Missing env → SSO disabled (no throw).
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
    // Validate absolute URL; keep path (Keycloak realm) but drop trailing slash.
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
    postLogoutRedirectUri: `${publicBaseUrl}/login`,
    scopes: ["openid", "email", "profile"],
  };
}

export function isOidcEnabled(
  envSource: NodeJS.ProcessEnv = process.env,
): boolean {
  return getOidcConfig(envSource) !== null;
}

/** Password / email login remains opt-in until migration decides otherwise. */
export function isPasswordLoginEnabled(
  envSource: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = String(envSource.ENABLE_PASSWORD_LOGIN || "")
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
