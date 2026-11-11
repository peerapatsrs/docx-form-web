import { hasSsoBypassQuery, safeAppReturnPath, stripSsoBypassParam } from "./safe-return.js";
import type { SilentSsoStartDecision } from "./types.js";
import { DEFAULT_COOLDOWN_SEC } from "./config.js";

/**
 * Cooldown cookie value: `until:pending:bypassUsed`
 * - until: epoch ms when the cooldown window ends
 * - pending: 1 while a silent attempt is in flight
 * - bypassUsed: 1 if a hub/?sso=1 bypass was used in this window
 */
export type CooldownState = {
  until: number;
  pending: boolean;
  bypassUsed: boolean;
};

export function parseCooldownCookie(
  cookieValue: string | null | undefined,
): CooldownState | null {
  const raw = String(cookieValue || "").trim();
  if (!raw) return null;

  // New format: until:pending:bypassUsed
  if (raw.includes(":")) {
    const parts = raw.split(":");
    if (parts.length < 3) return null;
    const until = Number(parts[0]);
    if (!Number.isFinite(until) || until <= 0) return null;
    const pending = parts[1] === "1" || parts[1] === "true";
    const bypassUsed = parts[2] === "1" || parts[2] === "true";
    return { until, pending, bypassUsed };
  }

  // Legacy docx format: <attemptedAtMs>.<outcome>[.b] — treat as active window from attemptedAt.
  const parts = raw.split(".");
  if (parts.length >= 2) {
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
    const outcome = (outcomeParts.join(".") || "fail").toLowerCase();
    return {
      until: attemptedAt + DEFAULT_COOLDOWN_SEC * 1000,
      pending: outcome === "pending",
      bypassUsed: viaBypass,
    };
  }

  const attemptedAt = Number(raw);
  if (!Number.isFinite(attemptedAt) || attemptedAt <= 0) return null;
  return {
    until: attemptedAt + DEFAULT_COOLDOWN_SEC * 1000,
    pending: false,
    bypassUsed: false,
  };
}

export function serializeCooldownValue(state: CooldownState): string {
  const until = Math.floor(state.until);
  return `${until}:${state.pending ? 1 : 0}:${state.bypassUsed ? 1 : 0}`;
}

export function isCooldownActive(
  cookieValue: string | null | undefined,
  nowMs: number = Date.now(),
  _cooldownSec?: number,
): boolean {
  const state = parseCooldownCookie(cookieValue);
  if (!state) return false;
  return nowMs < state.until;
}

/**
 * Hub / ?sso=1 bypass:
 * - allow when no cookie or window expired
 * - refuse while pending
 * - refuse when bypass already used in this window
 * - allow once after a normal (non-bypass) fail
 */
export function canUseSilentSsoBypass(
  cookieValue: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const state = parseCooldownCookie(cookieValue);
  if (!state) return true;
  if (nowMs >= state.until) return true;
  if (state.pending) return false;
  if (state.bypassUsed) return false;
  return true;
}

export function normalizeSilentOutcome(
  error: string | null | undefined,
): "login_required" | "fail" | "success" | "pending" {
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

export function buildCooldownState(input: {
  nowMs?: number;
  cooldownSec: number;
  pending: boolean;
  bypassUsed: boolean;
  /** Keep existing until when updating outcome inside the window. */
  previous?: CooldownState | null;
}): CooldownState {
  const nowMs = input.nowMs ?? Date.now();
  const sec = Math.max(0, input.cooldownSec);
  const until =
    input.previous && nowMs < input.previous.until
      ? input.previous.until
      : nowMs + Math.max(1, sec) * 1000;
  return {
    until,
    pending: input.pending,
    bypassUsed: input.bypassUsed || Boolean(input.previous?.bypassUsed),
  };
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

/**
 * Top-level document navigations only.
 * Never fetch / RSC / prefetch / iframe when detectable.
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
  if (pathname.startsWith("/_app/")) return false;
  if (/\.[a-z0-9]+$/i.test(pathname)) return false;

  if (String(input.rscHeader || "").trim() === "1") return false;
  const search = String(input.search || "");
  if (search.includes("_rsc=") || /[?&]_rsc(?:&|$)/.test(search)) return false;

  if (String(input.nextRouterPrefetch || "").trim()) return false;
  if (String(input.purpose || "").trim().toLowerCase() === "prefetch") {
    return false;
  }

  const dest = String(input.secFetchDest || "").trim().toLowerCase();
  if (dest === "iframe" || dest === "embed" || dest === "object") return false;

  const accept = String(input.accept || "");
  if (accept && !accept.includes("text/html")) return false;

  // Require document+navigate when Sec-Fetch headers are present.
  if (dest || String(input.secFetchMode || "").trim()) {
    const mode = String(input.secFetchMode || "").trim().toLowerCase();
    return dest === "document" && mode === "navigate";
  }

  // Crawlers without Sec-Fetch: allow one bounce (gated by cooldown).
  return true;
}

export function shouldSkipSilentSsoPath(
  pathname: string,
  extraSkipPrefixes: string[] = [],
): boolean {
  const path = String(pathname || "").split("?")[0] || "/";
  if (path.startsWith("/api/")) return true;
  if (path.startsWith("/_next/")) return true;
  if (path === "/health" || path === "/api/health") return true;
  if (path === "/login" || path.startsWith("/login/")) return true;
  if (path === "/logged-out" || path.startsWith("/logged-out/")) return true;
  if (path.startsWith("/auth/sso/")) return true;
  if (path.startsWith("/api/auth/oidc/")) return true;
  if (/\.[a-z0-9]{1,8}$/i.test(path)) return true;
  for (const p of extraSkipPrefixes) {
    if (path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`)) {
      return true;
    }
  }
  return false;
}

export function buildSilentLandPath(
  returnTo: string,
  landPath = "/api/auth/oidc/silent/land",
): string {
  const next = safeAppReturnPath(
    String(returnTo || "/").split("?")[0] || "/",
    String(returnTo || "").includes("?")
      ? `?${String(returnTo).split("?").slice(1).join("?")}`
      : "",
  );
  return `${landPath}?next=${encodeURIComponent(stripSsoBypassParam(next))}`;
}

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
  skipPathPrefixes?: string[];
}): SilentSsoStartDecision {
  if (!input.oidcEnabled) return { start: false, viaBypass: false };
  if (!input.isDocumentNavigation) return { start: false, viaBypass: false };
  if (input.hasSession) {
    return {
      start: false,
      viaBypass: false,
      stripSsoParam: hasSsoBypassQuery(input.search || ""),
    };
  }
  if (shouldSkipSilentSsoPath(input.pathname, input.skipPathPrefixes)) {
    return { start: false, viaBypass: false };
  }

  const nowMs = input.nowMs ?? Date.now();
  const wantBypass =
    hasSsoBypassQuery(input.search || "") ||
    refererMatchesHubOrigin(input.referer, input.hubOrigins ?? []);

  if (wantBypass && canUseSilentSsoBypass(input.cooldownCookie, nowMs)) {
    return { start: true, viaBypass: true };
  }

  if (isCooldownActive(input.cooldownCookie, nowMs, input.cooldownSec)) {
    return {
      start: false,
      viaBypass: false,
      stripSsoParam: hasSsoBypassQuery(input.search || ""),
    };
  }
  return { start: true, viaBypass: false };
}
