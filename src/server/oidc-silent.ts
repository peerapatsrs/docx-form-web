/**
 * Silent SSO (prompt=none) session gates — cookies only, no secrets.
 * After one check (or after explicit logout), do not bounce the browser again.
 */

export const OIDC_SSO_CHECKED_COOKIE = "docx_sso_checked";
/** Set on RP logout — skip silent check until interactive login or new browser session. */
export const OIDC_SSO_SKIP_COOKIE = "docx_sso_skip";

export function oidcSsoCheckedSetCookie(secure: boolean): string {
  const secureAttr = secure ? "; Secure" : "";
  // Session cookie — no Max-Age so a logged-out visitor is not re-checked every few minutes.
  return `${OIDC_SSO_CHECKED_COOKIE}=1; Path=/; HttpOnly; SameSite=Lax${secureAttr}`;
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
 * Edge-safe same-origin path + query (no open redirects).
 * Used for silent + interactive returnTo from the proxy.
 */
export function safeAppReturnPath(pathname: string, search = ""): string {
  const raw = `${pathname}${search}`;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return "/";
  }
  if (raw.length > 1 && (raw[1] === "/" || raw[1] === "\\")) return "/";
  return raw.split("#")[0] || "/";
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
 * Real top-level page loads only — not RSC, prefetch, or XHR/fetch.
 * Requires Sec-Fetch-Dest: document or Sec-Fetch-Mode: navigate.
 */
export function isTopLevelDocumentNavigation(input: {
  accept?: string | null;
  secFetchDest?: string | null;
  secFetchMode?: string | null;
  rscHeader?: string | null;
  nextRouterPrefetch?: string | null;
  purpose?: string | null;
  pathname?: string;
  search?: string;
}): boolean {
  const pathname = String(input.pathname || "/");
  if (pathname.startsWith("/api/")) return false;
  if (pathname.startsWith("/_next/")) return false;
  if (/\.[a-z0-9]+$/i.test(pathname)) return false;

  if (String(input.rscHeader || "").trim() === "1") return false;
  const search = String(input.search || "");
  if (search.includes("_rsc=") || /[?&]_rsc(?:&|$)/.test(search)) return false;

  if (String(input.nextRouterPrefetch || "").trim()) return false;
  if (String(input.purpose || "").trim().toLowerCase() === "prefetch") {
    return false;
  }

  const accept = String(input.accept || "");
  if (accept && !accept.includes("text/html")) return false;

  const dest = String(input.secFetchDest || "").trim().toLowerCase();
  const mode = String(input.secFetchMode || "").trim().toLowerCase();
  if (dest === "document" || mode === "navigate") return true;
  return false;
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
