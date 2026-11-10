/**
 * Silent SSO (prompt=none) — top-level authorize only (no iframes / 3P cookies).
 *
 * Cooldown cookie: `<attemptedAtMs>.<outcome>` or `<attemptedAtMs>.<outcome>.b`
 * where `.b` means the attempt was started via hub/?sso=1 bypass.
 *
 * Bypass rules:
 * - Allowed when no active cookie, or last attempt was a normal (non-bypass) fail
 * - Refused while pending, or when the last attempt was itself a bypass (.b)
 */

export const OIDC_SSO_COOLDOWN_COOKIE = "docx_sso_checked";
/** @deprecated alias — same cookie name. */
export const OIDC_SSO_CHECKED_COOKIE = OIDC_SSO_COOLDOWN_COOKIE;

export const DEFAULT_OIDC_SSO_COOLDOWN_SEC = 60;

export type OidcSsoCooldownOutcome =
  | "pending"
  | "login_required"
  | "fail"
  | "success";

export type OidcSsoCooldownState = {
  attemptedAt: number;
  outcome: OidcSsoCooldownOutcome | string;
  /** True when this attempt was started via hub Referer / ?sso=1 bypass. */
  viaBypass: boolean;
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
 * Cookie value: `<ts>.<outcome>` or `<ts>.<outcome>.b` (bypass attempt).
 */
export function parseOidcSsoCooldownCookie(
  cookieValue: string | null | undefined,
): OidcSsoCooldownState | null {
  const raw = String(cookieValue || "").trim();
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length >= 2) {
    const attemptedAt = Number(parts[0]);
    if (!Number.isFinite(attemptedAt) || attemptedAt <= 0) return null;
    let viaBypass = false;
    let outcomeParts = parts.slice(1);
    if (outcomeParts.length >= 2 && outcomeParts[outcomeParts.length - 1] === "b") {
      viaBypass = true;
      outcomeParts = outcomeParts.slice(0, -1);
    }
    const outcome = outcomeParts.join(".").trim() || "fail";
    return { attemptedAt, outcome, viaBypass };
  }
  const attemptedAt = Number(raw);
  if (!Number.isFinite(attemptedAt) || attemptedAt <= 0) return null;
  return { attemptedAt, outcome: "fail", viaBypass: false };
}

export function serializeOidcSsoCooldownValue(
  state: OidcSsoCooldownState,
): string {
  const ts = Math.floor(state.attemptedAt);
  const outcome =
    String(state.outcome || "fail")
      .replace(/[^a-z0-9_:-]/gi, "")
      .slice(0, 64) || "fail";
  return state.viaBypass ? `${ts}.${outcome}.b` : `${ts}.${outcome}`;
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
 * Hub / ?sso=1 bypass:
 * - allow after a normal (non-bypass) cooldown fail so hub login can silent-SSO
 * - refuse while pending, or when the last attempt was itself a bypass (.b)
 */
export function canUseSilentSsoBypass(
  cookieValue: string | null | undefined,
  nowMs: number = Date.now(),
  cooldownSec: number = getOidcSsoCooldownSec(),
): boolean {
  const state = parseOidcSsoCooldownCookie(cookieValue);
  if (!state) return true;
  if (
    !isOidcSsoCooldownActive(
      serializeOidcSsoCooldownValue(state),
      nowMs,
      cooldownSec,
    )
  ) {
    return true;
  }
  const outcome = String(state.outcome || "").toLowerCase();
  if (outcome === "pending") return false;
  if (state.viaBypass) return false;
  // Normal returned attempt (login_required / fail) → one bypass allowed.
  return true;
}

export function normalizeSilentOutcome(
  error: string | null | undefined,
): OidcSsoCooldownOutcome | string {
  const e = String(error || "")
    .trim()
    .toLowerCase()
    .replace(/^oidc_/, "");
  if (!e) return "fail";
  if (
    e === "login_required" ||
    e === "interaction_required" ||
    e === "consent_required"
  ) {
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
    viaBypass?: boolean;
    cooldownSec?: number;
  } = {},
): string {
  const secureAttr = secure ? "; Secure" : "";
  const cooldownSec = input.cooldownSec ?? getOidcSsoCooldownSec();
  const maxAge = Math.max(1, cooldownSec > 0 ? cooldownSec : 1);
  const value = serializeOidcSsoCooldownValue({
    attemptedAt: input.nowMs ?? Date.now(),
    outcome: normalizeSilentOutcome(input.outcome ?? "pending"),
    viaBypass: Boolean(input.viaBypass),
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

export function safeAppReturnPath(pathname: string, search = ""): string {
  const raw = `${pathname}${search}`;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    return "/";
  }
  if (raw.length > 1 && (raw[1] === "/" || raw[1] === "\\")) return "/";
  return raw.split("#")[0] || "/";
}

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

export type SilentSsoStartDecision = {
  start: boolean;
  /** Hub / ?sso=1 path — mark cooldown with .b */
  viaBypass: boolean;
};

/**
 * Decide whether to start silent SSO and whether this start is a bypass.
 */
export function resolveSilentSsoStart(input: {
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
}): SilentSsoStartDecision {
  if (!input.oidcEnabled) return { start: false, viaBypass: false };
  if (!input.isDocumentNavigation) return { start: false, viaBypass: false };
  if (input.hasSession) return { start: false, viaBypass: false };
  if (shouldSkipSilentSsoPath(input.pathname)) {
    return { start: false, viaBypass: false };
  }

  const nowMs = input.nowMs ?? Date.now();
  const cooldownSec = input.cooldownSec ?? getOidcSsoCooldownSec();
  const wantBypass =
    hasSsoBypassQuery(input.search || "") ||
    refererMatchesHubOrigin(
      input.referer,
      input.hubOrigins ?? parseOidcSsoHubOrigins(),
    );

  if (wantBypass && canUseSilentSsoBypass(input.cooldownCookie, nowMs, cooldownSec)) {
    return { start: true, viaBypass: true };
  }

  if (isOidcSsoCooldownActive(input.cooldownCookie, nowMs, cooldownSec)) {
    return { start: false, viaBypass: false };
  }
  return { start: true, viaBypass: false };
}

/** @deprecated use resolveSilentSsoStart */
export function shouldStartSilentSso(
  input: Parameters<typeof resolveSilentSsoStart>[0],
): boolean {
  return resolveSilentSsoStart(input).start;
}
