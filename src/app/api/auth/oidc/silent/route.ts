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
  oidcSsoCooldownSetCookie,
} from "@/server/oidc-silent";
import { getAppBaseUrl } from "@/lib/app-base-url";

export const dynamic = "force-dynamic";

/**
 * Silent SSO start: top-level authorize with prompt=none (no iframe).
 * Same redirect_uri / client_id / scopes / PKCE as interactive login.
 * Cooldown cookie is set only after login_required (callback), not here —
 * except when authorize cannot start (avoid tight local loops).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = safeOidcReturnTo(
    url.searchParams.get("next") || url.searchParams.get("returnTo"),
    "/",
  );
  const secure = process.env.NODE_ENV === "production";

  console.info("[oidc] silent attempt", { returnTo });

  const config = getOidcConfig();
  if (!config) {
    logOidcNotConfigured("oidc-silent");
    console.info("[oidc] silent outcome", { outcome: "disabled" });
    const home = new URL(returnTo, getAppBaseUrl());
    const headers = new Headers();
    applyOidcSetCookies(headers, [oidcSsoCooldownSetCookie(secure)]);
    return NextResponse.redirect(home, { status: 302, headers });
  }

  const result = await buildOidcAuthorizationRedirect({
    returnTo,
    prompt: "none",
    silent: true,
    config,
  });
  if (!result.ok) {
    console.info("[oidc] silent outcome", {
      outcome: "authorize_failed",
      error: result.error,
    });
    const home = new URL(returnTo, getAppBaseUrl());
    const headers = new Headers();
    applyOidcSetCookies(headers, [oidcSsoCooldownSetCookie(secure)]);
    return NextResponse.redirect(home, { status: 302, headers });
  }

  console.info("[oidc] silent outcome", { outcome: "redirect_authorize" });
  // Do not set cooldown yet — wait for IdP login_required / success.
  return NextResponse.redirect(result.url, { status: 302 });
}
