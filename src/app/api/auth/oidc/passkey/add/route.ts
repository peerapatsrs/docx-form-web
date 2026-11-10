import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import {
  applyOidcSetCookies,
  buildOidcAuthorizationRedirect,
} from "@/server/oidc-flow";
import {
  getOidcConfig,
  logOidcNotConfigured,
} from "@/server/oidc-config";
import { getOidcPasskeyAddAction } from "@/server/oidc-passkey";
import { safeOidcReturnTo } from "@/server/oidc-identities";
import { getAppBaseUrl } from "@/lib/app-base-url";

export const dynamic = "force-dynamic";

/**
 * Keycloak AIA: register passwordless WebAuthn (passkey).
 * Requires an app session; redirects to IdP authorize with kc_action.
 */
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    const login = new URL("/login", getAppBaseUrl());
    login.searchParams.set("next", "/account");
    return NextResponse.redirect(login, 302);
  }

  const config = getOidcConfig();
  if (!config) {
    logOidcNotConfigured("oidc-passkey-add");
    return NextResponse.redirect(new URL("/login", getAppBaseUrl()), 302);
  }

  const url = new URL(request.url);
  const returnTo = safeOidcReturnTo(
    url.searchParams.get("next") || url.searchParams.get("returnTo"),
    "/account",
  );
  const kcAction = getOidcPasskeyAddAction();
  const result = await buildOidcAuthorizationRedirect({
    returnTo,
    kcAction,
    scopes: ["openid"],
    config,
  });
  if (!result.ok) {
    console.error("[oidc] passkey add authorize failed:", result.error);
    const account = new URL("/account", getAppBaseUrl());
    account.searchParams.set("passkey", "error");
    return NextResponse.redirect(account, 302);
  }
  const headers = new Headers();
  applyOidcSetCookies(headers, []);
  return NextResponse.redirect(result.url, { status: 302, headers });
}
