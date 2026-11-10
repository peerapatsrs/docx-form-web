import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  documentCacheControl,
  securityHeaders,
} from "@/lib/security-headers";
import {
  buildSafeHttpsRedirectUrl,
  safeAppPathUrl,
} from "@/lib/public-origin";
import { isOidcEnabled } from "@/server/oidc-config";
import {
  getOidcSsoCooldownSec,
  isProtectedAppPath,
  isTopLevelDocumentNavigation,
  OIDC_SSO_COOLDOWN_COOKIE,
  parseOidcSsoHubOrigins,
  safeAppReturnPath,
  shouldStartSilentSso,
  stripSsoBypassParam,
} from "@/server/oidc-silent";
import { resolveProxySession } from "@/server/oidc-session-edge";

function applySecurityHeaders(response: NextResponse): NextResponse {
  const headers = securityHeaders();
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  response.headers.delete("x-powered-by");
  return response;
}

function applySetCookies(response: NextResponse, cookies: string[]): void {
  for (const c of cookies) {
    response.headers.append("Set-Cookie", c);
  }
}

/** Broader than silent SSO — used only for Cache-Control on HTML-ish responses. */
function isHtmlishNavigation(request: NextRequest): boolean {
  const accept = request.headers.get("accept") || "";
  if (accept.includes("text/html")) return true;
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api/")) return false;
  if (pathname.startsWith("/_next/")) return false;
  if (/\.[a-z0-9]+$/i.test(pathname)) return false;
  return true;
}

function presentedHostForAllowlist(request: NextRequest): string {
  const raw =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    request.nextUrl.host ||
    "";
  return raw.split(",")[0].trim();
}

function maybeRedirectToHttps(request: NextRequest): NextResponse | null {
  const proto = (
    request.headers.get("x-forwarded-proto") ||
    request.nextUrl.protocol.replace(/:$/, "") ||
    ""
  )
    .split(",")[0]
    .trim()
    .toLowerCase();
  if (proto !== "http") return null;

  const path = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const target = buildSafeHttpsRedirectUrl(
    path,
    presentedHostForAllowlist(request),
  );
  if (!target) return null;

  return applySecurityHeaders(NextResponse.redirect(target, 308));
}

/**
 * Network boundary: HTTPS redirect, security headers, auth gates, silent SSO.
 * Public pages render logged-out; protected pages → interactive /login.
 * Silent SSO is a top-level prompt=none redirect (no iframes) on document loads.
 */
export async function proxy(request: NextRequest) {
  const httpsRedirect = maybeRedirectToHttps(request);
  if (httpsRedirect) return httpsRedirect;

  const { pathname } = request.nextUrl;
  const search = request.nextUrl.search;

  // Removed DEV auth + app-hosted passkey/WebAuthn paths — always 404.
  if (
    pathname.startsWith("/api/auth/dev") ||
    pathname.startsWith("/api/dev/") ||
    pathname === "/api/auth/passkey" ||
    pathname.startsWith("/api/auth/passkey/")
  ) {
    return applySecurityHeaders(new NextResponse(null, { status: 404 }));
  }

  const session = await resolveProxySession({ request });
  const hasSession = session.hasSession;
  const htmlish = isHtmlishNavigation(request);
  const topLevelDoc = isTopLevelDocumentNavigation({
    accept: request.headers.get("accept"),
    secFetchDest: request.headers.get("sec-fetch-dest"),
    secFetchMode: request.headers.get("sec-fetch-mode"),
    rscHeader: request.headers.get("rsc"),
    nextRouterPrefetch: request.headers.get("next-router-prefetch"),
    purpose: request.headers.get("purpose"),
    pathname,
    search,
  });

  // Silent SSO — top-level document navigations only (Safari/ITP-safe).
  if (
    shouldStartSilentSso({
      pathname,
      search,
      hasSession,
      cooldownCookie: request.cookies.get(OIDC_SSO_COOLDOWN_COOKIE)?.value,
      cooldownSec: getOidcSsoCooldownSec(),
      hubOrigins: parseOidcSsoHubOrigins(),
      referer: request.headers.get("referer"),
      oidcEnabled: isOidcEnabled(),
      isDocumentNavigation: topLevelDoc,
    })
  ) {
    const returnTo = stripSsoBypassParam(
      safeAppReturnPath(pathname, search),
    );
    const silent = new URL(safeAppPathUrl("/api/auth/oidc/silent"));
    silent.searchParams.set("next", returnTo);
    const redirect = applySecurityHeaders(NextResponse.redirect(silent, 307));
    redirect.headers.set("Referrer-Policy", "no-referrer");
    applySetCookies(redirect, session.clearCookies);
    if (htmlish) {
      redirect.headers.set("Cache-Control", documentCacheControl(pathname));
    }
    return redirect;
  }

  // Protected pages only — interactive login (not silent). Preserve query.
  if (isProtectedAppPath(pathname) && !hasSession) {
    const login = new URL(safeAppPathUrl("/login"));
    login.searchParams.set(
      "next",
      stripSsoBypassParam(safeAppReturnPath(pathname, search)),
    );
    const redirect = applySecurityHeaders(NextResponse.redirect(login, 307));
    applySetCookies(redirect, session.clearCookies);
    redirect.headers.set("Cache-Control", documentCacheControl(pathname));
    return redirect;
  }

  const response = NextResponse.next();
  applySecurityHeaders(response);
  applySetCookies(response, session.clearCookies);
  if (htmlish) {
    response.headers.set("Cache-Control", documentCacheControl(pathname));
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|.*\\.(?:ico|png|jpg|jpeg|gif|webp|svg|txt|xml|map)$).*)",
  ],
};
