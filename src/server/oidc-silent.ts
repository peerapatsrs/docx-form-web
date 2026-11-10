/**
 * Silent SSO (prompt=none) session gates — cookies only, no secrets.
 * After one check (or after explicit logout), do not bounce the browser again.
 */

export const OIDC_SSO_CHECKED_COOKIE = "docx_sso_checked";
/** Set on RP logout — skip silent check until interactive login or new browser session. */
export const OIDC_SSO_SKIP_COOKIE = "docx_sso_skip";

/** How long to remember that a silent check already ran (~5 minutes). */
export const OIDC_SSO_CHECKED_MAX_AGE_SEC = 5 * 60;

export const SILENT_OIDC_ERRORS = new Set([
  "login_required",
  "interaction_required",
  "consent_required",
]);

export function isSilentOidcError(error: string | null | undefined): boolean {
  const e = String(error || "")
    .trim()
    .toLowerCase();
  // Callback may prefix with oidc_ when re-encoding; accept both.
  const bare = e.startsWith("oidc_") ? e.slice(5) : e;
  return SILENT_OIDC_ERRORS.has(bare) || SILENT_OIDC_ERRORS.has(e);
}

export function oidcSsoCheckedSetCookie(secure: boolean): string {
  const secureAttr = secure ? "; Secure" : "";
  return `${OIDC_SSO_CHECKED_COOKIE}=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=${OIDC_SSO_CHECKED_MAX_AGE_SEC}${secureAttr}`;
}

export function oidcSsoCheckedClearCookie(secure: boolean): string {
  const secureAttr = secure ? "; Secure" : "";
  return `${OIDC_SSO_CHECKED_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttr}`;
}

/** Session cookie — cleared when the browser session ends. */
export function oidcSsoSkipSetCookie(secure: boolean): string {
  const secureAttr = secure ? "; Secure" : "";
  return `${OIDC_SSO_SKIP_COOKIE}=1; Path=/; HttpOnly; SameSite=Lax${secureAttr}`;
}

export function oidcSsoSkipClearCookie(secure: boolean): string {
  const secureAttr = secure ? "; Secure" : "";
  return `${OIDC_SSO_SKIP_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttr}`;
}

/**
 * Paths that never trigger silent SSO (APIs, health, static-ish, OIDC endpoints).
 */
export function shouldSkipSilentSsoPath(pathname: string): boolean {
  const path = String(pathname || "").split("?")[0] || "/";
  if (path.startsWith("/api/")) return true;
  if (path.startsWith("/_next/")) return true;
  if (path === "/health" || path === "/api/health") return true;
  if (path === "/login" || path.startsWith("/login/")) return true;
  if (path === "/logged-out" || path.startsWith("/logged-out/")) return true;
  if (path.startsWith("/api/auth/oidc/")) return true;
  // Static file extensions
  if (/\.[a-z0-9]{1,8}$/i.test(path)) return true;
  return false;
}

/** App pages that require an interactive login when unauthenticated. */
export function isProtectedAppPath(pathname: string): boolean {
  const path = String(pathname || "").split("?")[0] || "/";
  return (
    path === "/account" ||
    path.startsWith("/account/") ||
    path === "/admin" ||
    path.startsWith("/admin/")
  );
}

export function isPublicAppPath(pathname: string): boolean {
  return !isProtectedAppPath(pathname);
}

/**
 * Whether middleware should kick off a silent SSO check for this document request.
 */
export function shouldStartSilentSso(input: {
  pathname: string;
  hasSession: boolean;
  ssoChecked: boolean;
  ssoSkip: boolean;
  oidcEnabled: boolean;
  isDocumentNavigation: boolean;
}): boolean {
  if (!input.oidcEnabled) return false;
  if (!input.isDocumentNavigation) return false;
  if (input.hasSession) return false;
  if (input.ssoChecked) return false;
  if (input.ssoSkip) return false;
  if (shouldSkipSilentSsoPath(input.pathname)) return false;
  return true;
}
