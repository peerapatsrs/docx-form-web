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
import {
  buildOidcPasskeyDeleteAction,
  validateOidcPasskeyCredentialId,
} from "@/server/oidc-passkey";
import { safeOidcReturnTo } from "@/server/oidc-identities";
import { getAppBaseUrl } from "@/lib/app-base-url";

export const dynamic = "force-dynamic";

/**
 * Keycloak AIA: delete_credential:<id> for the signed-in user.
 * credentialId is validated; ownership is enforced by Keycloak session + AIA.
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
    logOidcNotConfigured("oidc-passkey-remove");
    return NextResponse.redirect(new URL("/login", getAppBaseUrl()), 302);
  }

  const url = new URL(request.url);
  const credentialId = validateOidcPasskeyCredentialId(
    url.searchParams.get("credentialId"),
  );
  if (!credentialId) {
    const account = new URL("/account", getAppBaseUrl());
    account.searchParams.set("passkey", "error");
    return NextResponse.redirect(account, 302);
  }

  const returnTo = safeOidcReturnTo(
    url.searchParams.get("next") || url.searchParams.get("returnTo"),
    "/account",
  );

  let kcAction: string;
  try {
    kcAction = buildOidcPasskeyDeleteAction(credentialId);
  } catch {
    const account = new URL("/account", getAppBaseUrl());
    account.searchParams.set("passkey", "error");
    return NextResponse.redirect(account, 302);
  }

  const result = await buildOidcAuthorizationRedirect({
    returnTo,
    kcAction,
    scopes: ["openid"],
    config,
  });
  if (!result.ok) {
    console.error("[oidc] passkey remove authorize failed:", result.error);
    const account = new URL("/account", getAppBaseUrl());
    account.searchParams.set("passkey", "error");
    return NextResponse.redirect(account, 302);
  }
  const headers = new Headers();
  applyOidcSetCookies(headers, []);
  return NextResponse.redirect(result.url, { status: 302, headers });
}
