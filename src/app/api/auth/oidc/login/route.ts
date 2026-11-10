import { NextResponse } from "next/server";
import {
  applyOidcSetCookies,
  buildOidcAuthorizationRedirect,
} from "@/server/oidc-flow";
import { getAppBaseUrl } from "@/lib/app-base-url";
import { logOidcNotConfigured } from "@/server/oidc-config";
import { safeOidcReturnTo } from "@/server/oidc-identities";
import { oidcSsoCooldownClearCookie } from "@/server/oidc-silent";

export const dynamic = "force-dynamic";

/** Interactive OIDC login (no prompt=none). Clears silent cooldown. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo =
    url.searchParams.get("next") || url.searchParams.get("returnTo");
  const result = await buildOidcAuthorizationRedirect({
    returnTo,
    silent: false,
  });
  const secure = process.env.NODE_ENV === "production";
  if (!result.ok) {
    logOidcNotConfigured(`oidc-login:${result.error}`);
    const login = new URL("/login", getAppBaseUrl());
    login.searchParams.set("next", safeOidcReturnTo(returnTo, "/"));
    const headers = new Headers();
    applyOidcSetCookies(headers, [oidcSsoCooldownClearCookie(secure)]);
    return NextResponse.redirect(login, { status: 302, headers });
  }
  const headers = new Headers();
  applyOidcSetCookies(headers, [oidcSsoCooldownClearCookie(secure)]);
  return NextResponse.redirect(result.url, { status: 302, headers });
}
