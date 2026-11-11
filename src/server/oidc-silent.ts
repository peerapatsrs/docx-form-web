/**
 * Silent SSO helpers — thin wrap of @mw-shared/auth core + app cookie/env names.
 */
import {
  buildSilentLandPath as mwBuildSilentLandPath,
  canUseSilentSsoBypass as mwCanUseSilentSsoBypass,
  hasSsoBypassQuery,
  isCooldownActive,
  isTopLevelDocumentNavigation as mwIsTopLevelDocumentNavigation,
  normalizeSilentOutcome as mwNormalizeSilentOutcome,
  parseCooldownCookie,
  refererMatchesHubOrigin as mwRefererMatchesHubOrigin,
  resolveSilentSsoStart as mwResolveSilentSsoStart,
  safeAppReturnPath as mwSafeAppReturnPath,
  serializeCooldownValue,
  shouldSkipSilentSsoPath as mwShouldSkipSilentSsoPath,
  stripSsoBypassParam,
  type SilentSsoStartDecision as MwSilentSsoStartDecision,
} from "@mw-shared/auth";
/** Kept as docx_* for live cookie continuity (also set on MwAuthConfig). */
export const OIDC_SSO_COOLDOWN_COOKIE = "docx_sso_checked";
export const OIDC_SSO_CHECKED_COOKIE = OIDC_SSO_COOLDOWN_COOKIE;
export const DEFAULT_OIDC_SSO_COOLDOWN_SEC = 60;

export type OidcSsoCooldownOutcome =
  | "login_required"
  | "fail"
  | "success"
  | "pending"
  | string;

export type OidcSsoCooldownState = {
  attemptedAt: number;
  outcome: OidcSsoCooldownOutcome;
  viaBypass: boolean;
};

export function getOidcSsoCooldownSec(
  envSource: NodeJS.ProcessEnv = process.env,
): number {
  const rawStr = String(
    envSource.OIDC_SSO_COOLDOWN_SEC || envSource.SILENT_SSO_COOLDOWN_SEC || "",
  ).trim();
  if (!rawStr) return DEFAULT_OIDC_SSO_COOLDOWN_SEC;
  const n = Number(rawStr);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_OIDC_SSO_COOLDOWN_SEC;
  return Math.floor(n);
}

export function parseOidcSsoHubOrigins(
  envSource: NodeJS.ProcessEnv = process.env,
): string[] {
  return String(envSource.OIDC_SSO_HUB_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean)
    .map((s) => {
      try {
        return new URL(s).origin;
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

export {
  hasSsoBypassQuery,
  stripSsoBypassParam,
};

export function refererMatchesHubOrigin(
  referer: string | null | undefined,
  hubOrigins: string[],
): boolean {
  return mwRefererMatchesHubOrigin(referer, hubOrigins);
}

/**
 * Parse cooldown cookie (module `until:pending:bypassUsed`, plus legacy
 * `<ts>.<outcome>[.b]`). Returns a legacy-shaped state for app callers/tests.
 */
export function parseOidcSsoCooldownCookie(
  cookieValue: string | null | undefined,
  cooldownSec: number = DEFAULT_OIDC_SSO_COOLDOWN_SEC,
): OidcSsoCooldownState | null {
  const raw = String(cookieValue || "").trim();
  if (!raw) return null;

  // Preserve legacy outcome string when present (unit tests / old cookies).
  if (!raw.includes(":") && raw.includes(".")) {
    const parts = raw.split(".");
    const attemptedAt = Number(parts[0]);
    if (!Number.isFinite(attemptedAt) || attemptedAt <= 0) return null;
    let viaBypass = false;
    let outcomeParts = parts.slice(1);
    if (
      outcomeParts.length >= 2 &&
      outcomeParts[outcomeParts.length - 1] === "b"
    ) {
      viaBypass = true;
      outcomeParts = outcomeParts.slice(0, -1);
    }
    return {
      attemptedAt,
      outcome: (outcomeParts.join(".") || "fail").toLowerCase(),
      viaBypass,
    };
  }

  const parsed = parseCooldownCookie(cookieValue);
  if (!parsed) return null;
  const outcome = parsed.pending ? "pending" : "fail";
  return {
    attemptedAt: Math.max(0, parsed.until - Math.max(1, cooldownSec) * 1000),
    outcome,
    viaBypass: parsed.bypassUsed,
  };
}

export function serializeOidcSsoCooldownValue(
  state: OidcSsoCooldownState,
  cooldownSec: number = DEFAULT_OIDC_SSO_COOLDOWN_SEC,
): string {
  const until = state.attemptedAt + Math.max(1, cooldownSec) * 1000;
  return serializeCooldownValue({
    until,
    pending: String(state.outcome).toLowerCase() === "pending",
    bypassUsed: Boolean(state.viaBypass),
  });
}

export function isOidcSsoCooldownActive(
  cookieValue: string | null | undefined,
  nowMs: number = Date.now(),
  _cooldownSec: number = getOidcSsoCooldownSec(),
): boolean {
  return isCooldownActive(cookieValue, nowMs);
}

export function canUseSilentSsoBypass(
  cookieValue: string | null | undefined,
  nowMs: number = Date.now(),
  _cooldownSec?: number,
): boolean {
  return mwCanUseSilentSsoBypass(cookieValue, nowMs);
}

export function normalizeSilentOutcome(
  error: string | null | undefined,
): OidcSsoCooldownOutcome {
  return mwNormalizeSilentOutcome(error);
}

export function oidcSsoCooldownSetCookie(
  secure: boolean,
  input: {
    outcome?: string;
    viaBypass?: boolean;
    previous?: string | null;
    cooldownSec?: number;
    /** Test seam — production callers omit this. */
    nowMs?: number;
  } = {},
): string {
  const cooldownSec = input.cooldownSec ?? getOidcSsoCooldownSec();
  const nowMs = input.nowMs ?? Date.now();
  const previous = parseCooldownCookie(input.previous);
  const pending = String(input.outcome || "").toLowerCase() === "pending";
  const until =
    previous && nowMs < previous.until
      ? previous.until
      : nowMs + Math.max(1, cooldownSec) * 1000;
  const value = serializeCooldownValue({
    until,
    pending,
    bypassUsed: Boolean(input.viaBypass) || Boolean(previous?.bypassUsed),
  });
  const secureAttr = secure ? "; Secure" : "";
  const maxAge = Math.max(1, Math.ceil((until - nowMs) / 1000));
  return `${OIDC_SSO_COOLDOWN_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureAttr}`;
}

export function oidcSsoCooldownClearCookie(secure: boolean): string {
  const secureAttr = secure ? "; Secure" : "";
  return `${OIDC_SSO_COOLDOWN_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureAttr}`;
}

export function oidcSsoCheckedSetCookie(
  secure: boolean,
  input?: Parameters<typeof oidcSsoCooldownSetCookie>[1],
): string {
  return oidcSsoCooldownSetCookie(secure, input);
}

export const oidcSsoCheckedClearCookie = oidcSsoCooldownClearCookie;

export function safeAppReturnPath(pathname: string, search = ""): string {
  return mwSafeAppReturnPath(pathname, search);
}

export function buildSilentLandPath(returnTo: string): string {
  return mwBuildSilentLandPath(returnTo, "/api/auth/oidc/silent/land");
}

export function shouldSkipSilentSsoPath(pathname: string): boolean {
  return mwShouldSkipSilentSsoPath(pathname);
}

export function isProtectedAppPath(pathname: string): boolean {
  const path = String(pathname || "").split("?")[0] || "/";
  return path === "/account" || path.startsWith("/account/") ||
    path === "/admin" || path.startsWith("/admin/");
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
  return mwIsTopLevelDocumentNavigation(input);
}

export type SilentSsoStartDecision = MwSilentSsoStartDecision;

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
  return mwResolveSilentSsoStart({
    ...input,
    cooldownSec: input.cooldownSec ?? getOidcSsoCooldownSec(),
    hubOrigins: input.hubOrigins ?? parseOidcSsoHubOrigins(),
  });
}

/** @deprecated use resolveSilentSsoStart */
export function shouldStartSilentSso(
  input: Parameters<typeof resolveSilentSsoStart>[0],
): boolean {
  return resolveSilentSsoStart(input).start;
}
