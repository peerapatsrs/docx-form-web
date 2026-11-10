/**
 * Silent SSO (prompt=none) — top-level authorize only (no iframes / 3P cookies).
 * Cooldown cookie gates loops after login_required; hub Referer / ?sso=1 bypass.
 */

export const OIDC_SSO_COOLDOWN_COOKIE = "docx_sso_checked";
/** @deprecated alias — same cookie name (timestamp value). */
export const OIDC_SSO_CHECKED_COOKIE = OIDC_SSO_COOLDOWN_COOKIE;

export const DEFAULT_OIDC_SSO_COOLDOWN_SEC = 60;

export function getOidcSsoCooldownSec(
  envSource: NodeJS.ProcessEnv = process.env,
): number {
  const rawStr = String(envSource.OIDC_SSO_COOLDOWN_SEC || "").trim();
  if (!rawStr) return DEFAULT_OIDC_SSO_COOLDOWN_SEC;
  const raw = Number(rawStr);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return DEFAULT_OIDC_SSO_COOLDOWN_SEC;
}

/** Comma-separated absolute origins (no hardcoded hosts). */
export function parseOidcSsoHubOrigins(
  envSource: NodeJS.ProcessEnv = process.env,
): string[] {
  return String(envSource.OIDC_SSO_HUB_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean)
    .map((raw) => {
      try {
        return new URL(raw).origin;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

export function refererMatchesHubOrigin(
  referer: string | null | undefined,
  hubOrigins: string[],
): boolean {
  if (!referer || hubOrigins.length === 0) return false;
  try {
    const origin = new URL(referer).origin;
    return hubOrigins.includes(origin);
  } catch {
    return false;
  }
}

export function hasSsoBypassQuery(search: string): boolean {
  const raw = String(search || "");
  const q = raw.startsWith("?") ? raw.slice(1) : raw;
  try {
    return new URLSearchParams(q).get("sso") === "1";
  } catch {
    return false;
  }
}

/** Drop ?sso=1 from returnTo so it does not stick after silent login. */
export function stripSsoBypassParam(pathWithQuery: string): string {
  const raw = String(pathWithQuery || "/");
  const qIndex = raw.indexOf("?");
  if (qIndex < 0) return raw || "/";
  const path = raw.slice(0, qIndex) || "/";
  const params = new URLSearchParams(raw.slice(qIndex + 1));
  if (!params.has("sso")) return raw;
  params.delete("sso");
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}

/**
 * Cooldown active when cookie holds a recent timestamp (ms since epoch).
 * Legacy non-numeric values ("1") are ignored so hub login is not stuck.
 */
export function isOidcSsoCooldownActive(
  cookieValue: string | null | undefined,
  nowMs: number = Date.now(),
  cooldownSec: number = getOidcSsoCooldownSec(),
): boolean {
  if (cooldownSec <= 0) return false;
  const ts = Number(String(cookieValue || "").trim());
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return nowMs - ts < cooldownSec * 1000;
}

/** Set after silent login_required (and other quiet fails) to prevent immediate loops. */
export function oidcSsoCooldownSetCookie(
  secure: boolean,
  nowMs: number = Date.now(),
  cooldownSec: number = getOidcSsoCooldownSec(),
): string {
  const secureAttr = secure ? "; Secure" : "";
  const maxAge = Math.max(1, cooldownSec > 0 ? cooldownSec : 1);
  return `${OIDC_SSO_COOLDOWN_COOKIE}=${Math.floor(nowMs)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureAttr}`;
}

export function oidcSsoCooldownClearCookie(secure: boolean): string {
  const secureAttr = secure ? "; Secure" : "";
  return `${OIDC_SSO_COOLDOWN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttr}`;
}

/** @deprecated use oidcSsoCooldownSetCookie */
export const oidcSsoCheckedSetCookie = oidcSsoCooldownSetCookie;
/** @deprecated use oidcSsoCooldownClearCookie */
export const oidcSsoCheckedClearCookie = oidcSsoCooldownClearCookie;

/**
 * Edge-safe same-origin path + query (no open redirects).
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
  if (/\.[a-z0-9]{1,8}$/i.test(path)) return true;
  return false;
}

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
 * Hub Referer / ?sso=1 bypass the post-login_required cooldown.
 */
export function shouldStartSilentSso(input: {
  pathname: string;
  search?: string;
  hasSession: boolean;
  cooldownCookie?: string | null;
  /** Absolute ms; defaults to Date.now(). */
  nowMs?: number;
  cooldownSec?: number;
  hubOrigins?: string[];
  referer?: string | null;
  oidcEnabled: boolean;
  isDocumentNavigation: boolean;
}): boolean {
  if (!input.oidcEnabled) return false;
  if (!input.isDocumentNavigation) return false;
  if (input.hasSession) return false;
  if (shouldSkipSilentSsoPath(input.pathname)) return false;

  const bypass =
    hasSsoBypassQuery(input.search || "") ||
    refererMatchesHubOrigin(
      input.referer,
      input.hubOrigins ?? parseOidcSsoHubOrigins(),
    );
  if (bypass) return true;

  if (
    isOidcSsoCooldownActive(
      input.cooldownCookie,
      input.nowMs ?? Date.now(),
      input.cooldownSec ?? getOidcSsoCooldownSec(),
    )
  ) {
    return false;
  }
  return true;
}
