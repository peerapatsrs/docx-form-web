import { NextResponse } from "next/server";
import {
  applyOidcSetCookies,
  buildOidcAuthorizationRedirect,
} from "@/server/oidc-flow";
import {
  getOidcConfig,
  logOidcNotConfigured,
} from "@/server/oidc-config";
import { safeOidcReturnTo } from "@/server/oidc-identities";
import {
  oidcSsoCheckedSetCookie,
} from "@/server/oidc-silent";
import { getAppBaseUrl } from "@/lib/app-base-url";

export const dynamic = "force-dynamic";

/**
 * Silent SSO start: authorize with prompt=none.
 * Sets docx_sso_checked immediately so a failed/cancelled check does not loop.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = safeOidcReturnTo(
    url.searchParams.get("next") || url.searchParams.get("returnTo"),
    "/",
  );
  const secure = process.env.NODE_ENV === "production";
  const checked = oidcSsoCheckedSetCookie(secure);

  const config = getOidcConfig();
  if (!config) {
    logOidcNotConfigured("oidc-silent");
    const home = new URL(returnTo, getAppBaseUrl());
    const headers = new Headers();
    applyOidcSetCookies(headers, [checked]);
    return NextResponse.redirect(home, { status: 302, headers });
  }

  const result = await buildOidcAuthorizationRedirect({
    returnTo,
    prompt: "none",
    silent: true,
    config,
  });
  if (!result.ok) {
    console.error("[oidc] silent authorize failed:", result.error);
    const home = new URL(returnTo, getAppBaseUrl());
    const headers = new Headers();
    applyOidcSetCookies(headers, [checked]);
    return NextResponse.redirect(home, { status: 302, headers });
  }

  const headers = new Headers();
  applyOidcSetCookies(headers, [checked]);
  return NextResponse.redirect(result.url, { status: 302, headers });
}
