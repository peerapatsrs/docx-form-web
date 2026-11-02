import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import {
  documentCacheControl,
  securityHeaders,
} from "@/lib/security-headers";
import { isDevAuthEnabled } from "@/lib/dev-auth-flag";
import {
  buildSafeHttpsRedirectUrl,
  safeAppPathUrl,
} from "@/lib/public-origin";

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
 * Presented host is used only for allowlist checks — never as the redirect
 * target. Prefer X-Forwarded-Host then Host for the check value alone.
 */
function presentedHostForAllowlist(request: NextRequest): string {
  const raw =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    request.nextUrl.host ||
    "";
  return raw.split(",")[0].trim();
}

/**
 * Behind Render (and similar), TLS terminates at the proxy. Honor
 * x-forwarded-proto so cleartext hops redirect to HTTPS instead of erroring.
 * Redirect target comes from APP_BASE_URL (etc.), not from Host headers.
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

  const path = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  const target = buildSafeHttpsRedirectUrl(
    path,
    presentedHostForAllowlist(request),
  );
  if (!target) return null;

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
      // Build from configured public origin — do not trust request.url host.
      const login = new URL(safeAppPathUrl("/login"));
      login.searchParams.set("next", pathname);
      const redirect = applySecurityHeaders(NextResponse.redirect(login, 307));
      // Do not let shared caches store auth redirects for private surfaces.
      redirect.headers.set("Cache-Control", documentCacheControl(pathname));
      return redirect;
    }
  }

  const response = NextResponse.next();
  applySecurityHeaders(response);
  if (isDocumentNavigation(request)) {
    response.headers.set("Cache-Control", documentCacheControl(pathname));
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
