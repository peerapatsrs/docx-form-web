/**
 * Silent SSO (prompt=none) — top-level authorize only (no iframes / 3P cookies).
 * Cooldown cookie stores attemptedAt + outcome; hub/?sso=1 bypass is one-shot
 * per cooldown window (ignored once a silent attempt has returned).
 */

export const OIDC_SSO_COOLDOWN_COOKIE = "docx_sso_checked";
/** @deprecated alias — same cookie name. */
export const OIDC_SSO_CHECKED_COOKIE = OIDC_SSO_COOLDOWN_COOKIE;

export const DEFAULT_OIDC_SSO_COOLDOWN_SEC = 60;

/** Cookie value outcomes (no PII). */
export type OidcSsoCooldownOutcome =
  | "pending"
  | "login_required"
  | "fail"
  | "success";

export type OidcSsoCooldownState = {
  attemptedAt: number;
  outcome: OidcSsoCooldownOutcome | string;
};

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
 * Cookie value: `<attemptedAtMs>.<outcome>` (e.g. `1700000000000.login_required`).
 * Legacy bare timestamps / `"1"` parse best-effort.
 */
export function parseOidcSsoCooldownCookie(
  cookieValue: string | null | undefined,
): OidcSsoCooldownState | null {
  const raw = String(cookieValue || "").trim();
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot > 0) {
    const attemptedAt = Number(raw.slice(0, dot));
    const outcome = raw.slice(dot + 1).trim() || "fail";
    if (!Number.isFinite(attemptedAt) || attemptedAt <= 0) return null;
    return { attemptedAt, outcome };
  }
  const attemptedAt = Number(raw);
  if (!Number.isFinite(attemptedAt) || attemptedAt <= 0) return null;
  // Legacy timestamp-only → treat as completed fail so hub Referer cannot loop.
  return { attemptedAt, outcome: "fail" };
}

export function serializeOidcSsoCooldownValue(
  state: OidcSsoCooldownState,
): string {
  const ts = Math.floor(state.attemptedAt);
  const outcome = String(state.outcome || "fail")
    .replace(/[^a-z0-9_:-]/gi, "")
    .slice(0, 64) || "fail";
  return `${ts}.${outcome}`;
}

export function isOidcSsoCooldownActive(
  cookieValue: string | null | undefined,
  nowMs: number = Date.now(),
  cooldownSec: number = getOidcSsoCooldownSec(),
): boolean {
  if (cooldownSec <= 0) return false;
  const state = parseOidcSsoCooldownCookie(cookieValue);
  if (!state) return false;
  return nowMs - state.attemptedAt < cooldownSec * 1000;
}

/**
 * Hub Referer / ?sso=1 may bypass cooldown only once per window.
 * Once a silent attempt has returned (any non-pending outcome), ignore bypass.
 */
export function canUseSilentSsoBypass(
  cookieValue: string | null | undefined,
  nowMs: number = Date.now(),
  cooldownSec: number = getOidcSsoCooldownSec(),
): boolean {
  const state = parseOidcSsoCooldownCookie(cookieValue);
  if (!state) return true;
  if (!isOidcSsoCooldownActive(serializeOidcSsoCooldownValue(state), nowMs, cooldownSec)) {
    return true;
  }
  // Pending or any returned outcome → bypass already consumed this window.
  return false;
}

export function normalizeSilentOutcome(
  error: string | null | undefined,
): OidcSsoCooldownOutcome | string {
  const e = String(error || "")
    .trim()
    .toLowerCase()
    .replace(/^oidc_/, "");
  if (!e) return "fail";
  if (e === "login_required" || e === "interaction_required" || e === "consent_required") {
    return "login_required";
  }
  if (e === "pending" || e === "success") return e;
  return "fail";
}

export function oidcSsoCooldownSetCookie(
  secure: boolean,
  input: {
    nowMs?: number;
    outcome?: string;
    cooldownSec?: number;
  } = {},
): string {
  const secureAttr = secure ? "; Secure" : "";
  const cooldownSec = input.cooldownSec ?? getOidcSsoCooldownSec();
  const maxAge = Math.max(1, cooldownSec > 0 ? cooldownSec : 1);
  const value = serializeOidcSsoCooldownValue({
    attemptedAt: input.nowMs ?? Date.now(),
    outcome: normalizeSilentOutcome(input.outcome ?? "pending"),
  });
  return `${OIDC_SSO_COOLDOWN_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureAttr}`;
}

export function oidcSsoCooldownClearCookie(secure: boolean): string {
  const secureAttr = secure ? "; Secure" : "";
  return `${OIDC_SSO_COOLDOWN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttr}`;
}

/** @deprecated */
export function oidcSsoCheckedSetCookie(
  secure: boolean,
  nowMs?: number,
  cooldownSec?: number,
): string {
  return oidcSsoCooldownSetCookie(secure, {
    nowMs,
    outcome: "fail",
    cooldownSec,
  });
}
/** @deprecated */
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
 * Same-origin quiet-land hop after silent fail (strips hub Referer for next GET).
 */
export function buildSilentLandPath(returnTo: string): string {
  const next = safeAppReturnPath(
    String(returnTo || "/").split("?")[0] || "/",
    String(returnTo || "").includes("?")
      ? `?${String(returnTo).split("?").slice(1).join("?")}`
      : "",
  );
  return `/api/auth/oidc/silent/land?next=${encodeURIComponent(stripSsoBypassParam(next))}`;
}

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
 * Whether middleware should kick off a silent SSO check.
 * Hub/?sso=1 bypass is ignored once a silent attempt has returned this window.
 */
export function shouldStartSilentSso(input: {
  pathname: string;
  search?: string;
  hasSession: boolean;
  cooldownCookie?: string | null;
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

  const nowMs = input.nowMs ?? Date.now();
  const cooldownSec = input.cooldownSec ?? getOidcSsoCooldownSec();
  const wantBypass =
    hasSsoBypassQuery(input.search || "") ||
    refererMatchesHubOrigin(
      input.referer,
      input.hubOrigins ?? parseOidcSsoHubOrigins(),
    );

  if (wantBypass) {
    if (canUseSilentSsoBypass(input.cooldownCookie, nowMs, cooldownSec)) {
      return true;
    }
    // Bypass already used this window — fall through; cooldown still blocks.
  }

  if (isOidcSsoCooldownActive(input.cooldownCookie, nowMs, cooldownSec)) {
    return false;
  }
  return true;
}
