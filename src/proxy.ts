import { NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Optional gate: set AUTH_REQUIRED=1 to force login for app pages.
 * Auth API + static assets stay public.
 */
export function proxy(request: NextRequest) {
  const required =
    String(process.env.AUTH_REQUIRED || "").trim() === "1" ||
    String(process.env.AUTH_REQUIRED || "").toLowerCase() === "true";
  if (!required) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/auth-config") ||
    pathname.startsWith("/api/health") ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/style.css") ||
    pathname.startsWith("/app.js") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"],
};
