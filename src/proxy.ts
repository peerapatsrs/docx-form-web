import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import {
  documentCacheControl,
  securityHeaders,
} from "@/lib/security-headers";
import {
  buildSafeHttpsRedirectUrl,
  safeAppPathUrl,
} from "@/lib/public-origin";

function applySecurityHeaders(response: NextResponse): NextResponse {
  const headers = securityHeaders();
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }
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
 * Network boundary: HTTPS redirect, security headers, auth gates.
 * Unauthenticated /account|/admin → /login?next=… (OIDC-only login).
 */
export function proxy(request: NextRequest) {
  const httpsRedirect = maybeRedirectToHttps(request);
  if (httpsRedirect) return httpsRedirect;

  const { pathname } = request.nextUrl;

  // Removed DEV auth paths — always 404.
  if (pathname.startsWith("/api/auth/dev") || pathname.startsWith("/api/dev/")) {
    return applySecurityHeaders(new NextResponse(null, { status: 404 }));
  }

  const needsAuth =
    pathname === "/account" ||
    pathname.startsWith("/account/") ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/");

  if (needsAuth) {
    const token = getSessionCookie(request);
    if (!token) {
      const login = new URL(safeAppPathUrl("/login"));
      login.searchParams.set("next", pathname);
      const redirect = applySecurityHeaders(NextResponse.redirect(login, 307));
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
    "/((?!_next/static|_next/image|.*\\.(?:ico|png|jpg|jpeg|gif|webp|svg|txt|xml|map)$).*)",
  ],
};
