import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { HTML_CACHE_CONTROL, securityHeaders } from "@/lib/security-headers";
import { isDevAuthEnabled } from "@/lib/dev-auth-flag";

function applySecurityHeaders(response: NextResponse): NextResponse {
  const headers = securityHeaders();
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
  // Do not advertise the application framework.
  response.headers.delete("x-powered-by");
  return response;
}

function isDocumentNavigation(request: NextRequest): boolean {
  const accept = request.headers.get("accept") || "";
  if (accept.includes("text/html")) return true;
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api/")) return false;
  if (pathname.startsWith("/_next/")) return false;
  if (/\.[a-z0-9]+$/i.test(pathname)) return false;
  return true;
}

/**
 * Behind Render (and similar), TLS terminates at the proxy. Honor
 * x-forwarded-proto so cleartext hops redirect to HTTPS instead of erroring.
 * Skip loopback / missing proto so container health checks stay on HTTP.
 */
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

  const host =
    (
      request.headers.get("x-forwarded-host") ||
      request.headers.get("host") ||
      ""
    )
      .split(",")[0]
      .trim() || request.nextUrl.host;

  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".local")
  ) {
    return null;
  }

  // Build a fresh https URL from the public host — do not keep the
  // container's listen port (e.g. :3000) from request.nextUrl.
  const path = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const target = new URL(`https://${host}${path}`);
  return applySecurityHeaders(NextResponse.redirect(target, 308));
}

/**
 * Network boundary: HTTPS redirect, security headers, auth gates, and
 * production blocking of development-only auth paths.
 * Real auth/role checks still live in server layouts + /api/*.
 */
export function proxy(request: NextRequest) {
  const httpsRedirect = maybeRedirectToHttps(request);
  if (httpsRedirect) return httpsRedirect;

  const { pathname } = request.nextUrl;

  // Development-only Better Auth plugin paths — unavailable when disabled.
  if (pathname.startsWith("/api/auth/dev")) {
    if (!isDevAuthEnabled()) {
      return applySecurityHeaders(new NextResponse(null, { status: 404 }));
    }
  }

  const needsAuth =
    pathname === "/account" ||
    pathname.startsWith("/account/") ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/");

  if (needsAuth) {
    const token = getSessionCookie(request);
    if (!token) {
      const login = new URL("/login", request.url);
      login.searchParams.set("next", pathname);
      return applySecurityHeaders(NextResponse.redirect(login, 307));
    }
  }

  const response = NextResponse.next();
  applySecurityHeaders(response);
  if (isDocumentNavigation(request)) {
    response.headers.set("Cache-Control", HTML_CACHE_CONTROL);
  }
  return response;
}

export const config = {
  matcher: [
    /*
     * Apply to all paths except Next internals and common static file extensions
     * that are covered by long-lived asset caching in next.config.
     */
    "/((?!_next/static|_next/image|.*\\.(?:ico|png|jpg|jpeg|gif|webp|svg|txt|xml|map)$).*)",
  ],
};
