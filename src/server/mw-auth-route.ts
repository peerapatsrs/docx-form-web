/**
 * Shared App Router helpers for OIDC handlers from @mw-shared/auth.
 */

import { NextResponse } from "next/server";
import {
  augmentWithBetterAuthCookies,
  getMwOidcHandlers,
} from "./mw-auth";
import { getAppBaseUrl } from "@/lib/app-base-url";
import { logOidcNotConfigured } from "./oidc-config";

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
 */
export function buildEndSessionContinueHtml(endSessionUrl: string): string {
  const href = escapeHtmlAttr(endSessionUrl);
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
  if (!loc || !/^https?:\/\//i.test(loc)) return response;
  const appBase = getAppBaseUrl();
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

  return new Response(buildEndSessionContinueHtml(loc), {
    status: 200,
    headers,
  });
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
