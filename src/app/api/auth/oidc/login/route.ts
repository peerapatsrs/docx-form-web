import { NextResponse } from "next/server";
import {
  applyOidcSetCookies,
  buildOidcAuthorizationRedirect,
} from "@/server/oidc-flow";
import { getAppBaseUrl } from "@/lib/app-base-url";
import { logOidcNotConfigured } from "@/server/oidc-config";
import { safeOidcReturnTo } from "@/server/oidc-identities";

export const dynamic = "force-dynamic";

/** Start OIDC authorization-code + PKCE login. Missing env → /login error page. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo =
    url.searchParams.get("next") || url.searchParams.get("returnTo");
  const result = await buildOidcAuthorizationRedirect({ returnTo });
  if (!result.ok) {
    logOidcNotConfigured(`oidc-login:${result.error}`);
    const login = new URL("/login", getAppBaseUrl());
    login.searchParams.set("next", safeOidcReturnTo(returnTo, "/"));
    return NextResponse.redirect(login, 302);
  }
  const headers = new Headers();
  applyOidcSetCookies(headers, []);
  return NextResponse.redirect(result.url, { status: 302, headers });
}
