import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Optimistic edge gate only — cookie presence, no DB.
 * Real auth/role checks live in server layouts + /api/*.
 * Guests hitting /account|/admin get a hard redirect to /login (avoids
 * Next soft-nav leaving the home app.js shell in a broken state).
 * @see .cursor/rules/page-auth-guards.mdc
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const needsAuth =
    pathname === "/account" ||
    pathname.startsWith("/account/") ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/");

  if (!needsAuth) return NextResponse.next();

  const token = getSessionCookie(request);
  if (token) return NextResponse.next();

  const login = new URL("/login", request.url);
  login.searchParams.set("next", pathname);
  // 307 keeps method; browsers treat this as a full document navigation.
  return NextResponse.redirect(login, 307);
}

export const config = {
  matcher: ["/account", "/account/:path*", "/admin", "/admin/:path*"],
};
