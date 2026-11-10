import { NextResponse } from "next/server";
import {
  applyOidcSetCookies,
  handleOidcCallback,
  readCookie,
} from "@/server/oidc-flow";
import { OIDC_FAIL_COOKIE } from "@/server/oidc-login-guard";
import { getAppBaseUrl } from "@/lib/app-base-url";

export const dynamic = "force-dynamic";

function absoluteRedirect(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = getAppBaseUrl();
  return `${base}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
}

/** OIDC authorization-code callback — validates state/nonce/PKCE + JWKS id_token. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  // Authorization code must never be logged.
  const result = await handleOidcCallback({
    code: url.searchParams.get("code"),
    state: url.searchParams.get("state"),
    error: url.searchParams.get("error"),
    kcActionStatus: url.searchParams.get("kc_action_status"),
    failCookieRaw: readCookie(
      request.headers.get("cookie"),
      OIDC_FAIL_COOKIE,
    ),
  });
  const headers = new Headers();
  applyOidcSetCookies(headers, result.setCookies);
  return NextResponse.redirect(absoluteRedirect(result.redirectTo), {
    status: 302,
    headers,
  });
}
