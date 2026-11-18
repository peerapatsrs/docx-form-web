/**
 * Shared App Router helpers for OIDC handlers from @mw-shared/auth.
 */

import { NextResponse } from "next/server";
import {
  augmentWithBetterAuthCookies,
  getMwOidcHandlers,
} from "./mw-auth";
import { getAppBaseUrl } from "@/lib/app-base-url";
import { getOidcConfig, logOidcNotConfigured } from "./oidc-config";

function absoluteLocation(location: string | null): string | null {
  if (!location) return null;
  if (/^https?:\/\//i.test(location)) return location;
  const base = getAppBaseUrl();
  return `${base}${location.startsWith("/") ? location : `/${location}`}`;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Escape a URL for use in an HTML attribute / text node.
 * Only used for IdP end_session URLs we just built (still escape defensively).
 */
export function escapeHtmlAttr(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export type EndSessionContinueOptions = {
  /**
   * Absolute origin of the IdP `end_session_endpoint` (from OIDC discovery).
   * When omitted, derived from `issuerUrl` / `OIDC_ISSUER` (same origin as
   * Keycloak end_session). Never hardcode hosts.
   */
  allowedEndSessionOrigin?: string | null;
  /** OIDC issuer URL — used when allowedEndSessionOrigin is omitted. */
  issuerUrl?: string | null;
  /** Safe same-app fallback when the candidate URL is rejected. */
  fallbackHref?: string;
};

function resolveAllowedEndSessionOrigin(
  opts: EndSessionContinueOptions = {},
): { origin: string; allowHttp: boolean } | null {
  if (opts.allowedEndSessionOrigin) {
    try {
      const u = new URL(opts.allowedEndSessionOrigin);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return { origin: u.origin, allowHttp: u.protocol === "http:" };
    } catch {
      return null;
    }
  }

  const issuerRaw =
    opts.issuerUrl || getOidcConfig()?.issuer || process.env.OIDC_ISSUER || "";
  const trimmed = String(issuerRaw).trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return { origin: u.origin, allowHttp: u.protocol === "http:" };
  } catch {
    return null;
  }
}

/**
 * Defense in depth for the logout continue page: only emit http(s) URLs whose
 * origin matches the configured IdP end_session origin. Reject javascript:,
 * data:, foreign https origins, and CTL/whitespace smuggling.
 */
export function resolveSafeEndSessionContinueHref(
  endSessionUrl: string,
  opts: EndSessionContinueOptions = {},
): string {
  const fallback = opts.fallbackHref || "/logged-out";
  const allowed = resolveAllowedEndSessionOrigin(opts);
  if (!allowed) return fallback;

  const raw = String(endSessionUrl ?? "");
  // Reject control characters (incl. NUL) anywhere — blocks prefix smuggling.
  for (let i = 0; i < raw.length; i += 1) {
    const c = raw.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return fallback;
  }

  const trimmed = raw.trim();
  if (!trimmed) return fallback;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return fallback;
  }

  if (url.protocol === "https:") {
    // always allowed when origin matches
  } else if (url.protocol === "http:") {
    // http: only when the configured issuer/end_session is itself http (local).
    if (!allowed.allowHttp) return fallback;
  } else {
    return fallback;
  }

  if (url.origin !== allowed.origin) return fallback;
  return url.toString();
}

/**
 * Browser continue page for cross-origin RP logout.
 *
 * A 303 Location to Keycloak after a form POST is blocked when the document
 * CSP has `form-action 'self'` (and when multiple CSPs AND together). Returning
 * 200 HTML to the same origin completes the form POST under form-action, then
 * meta-refresh / link / optional DOM-based location.replace perform a top-level
 * GET to end_session (not subject to form-action).
 *
 * The end_session URL must never be interpolated into a `<script>` literal —
 * a raw `</script>` in the URL would end the script early (XSS). Meta + `<a href>`
 * use HTML attribute escaping; any script only reads the URL from the anchor.
 * Candidate URLs are origin-checked (DEF-BE-END-SESSION-JAVASCRIPT-HREF).
 */
export function buildEndSessionContinueHtml(
  endSessionUrl: string,
  opts: EndSessionContinueOptions = {},
): string {
  const safeHref = resolveSafeEndSessionContinueHref(endSessionUrl, opts);
  const href = escapeHtmlAttr(safeHref);
  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${href}">
<meta name="robots" content="noindex">
<title>กำลังออกจากระบบ…</title>
</head>
<body>
<p>กำลังออกจากระบบ Keycloak…</p>
<p><a id="oidc-end-session-continue" href="${href}">ดำเนินการต่อ</a></p>
<script>
(function () {
  var a = document.getElementById("oidc-end-session-continue");
  if (a && a.href) location.replace(a.href);
})();
</script>
</body>
</html>`;
}

/**
 * When logout returns a cross-origin 3xx to end_session, convert to an HTML
 * continue document so the browser navigates even if form-action would block
 * a redirect chain. Same-origin post_logout fallbacks stay as redirects.
 */
export function maybeContinueToEndSession(response: Response): Response {
  if (response.status < 300 || response.status >= 400) return response;
  const loc = response.headers.get("Location");
  if (!loc) return response;
  const appBase = getAppBaseUrl();
  // Same-origin post_logout (/logged-out) stays a normal redirect.
  if (sameOrigin(loc, appBase)) return response;

  const headers = new Headers();
  // Preserve Set-Cookie clears from the module response.
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  for (const c of setCookies) headers.append("Set-Cookie", c);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("Referrer-Policy", "no-referrer");

  const cfg = getOidcConfig();
  return new Response(
    buildEndSessionContinueHtml(loc, {
      issuerUrl: cfg?.issuer ?? null,
      // Issuer origin == end_session_endpoint origin for Keycloak / standard OIDC.
      allowedEndSessionOrigin: cfg ? new URL(cfg.issuer).origin : null,
      fallbackHref: "/logged-out",
    }),
    {
      status: 200,
      headers,
    },
  );
}

/**
 * Run a module handler and absolute-ize relative Location redirects for Next.
 */
export async function runMwOidcHandler(
  path: string,
  method: "GET" | "POST",
  request: Request,
): Promise<Response> {
  const handlers = getMwOidcHandlers();
  if (!handlers) {
    logOidcNotConfigured(path);
    return NextResponse.json(
      { error: "OIDC_DISABLED", code: "OIDC_DISABLED" },
      { status: 404 },
    );
  }
  const pair = handlers[path];
  if (!pair) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }
  const fn = method === "POST" ? pair.POST : pair.GET;
  let response = await fn(request);
  response = await augmentWithBetterAuthCookies(response);

  const loc = response.headers.get("Location");
  const abs = absoluteLocation(loc);
  if (abs && abs !== loc) {
    const headers = new Headers(response.headers);
    headers.set("Location", abs);
    response = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  if (path === "/api/auth/oidc/logout" && method === "POST") {
    response = maybeContinueToEndSession(response);
  }

  return response;
}
