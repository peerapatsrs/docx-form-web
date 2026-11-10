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
import { oidcSsoCooldownSetCookie } from "@/server/oidc-silent";
import { getAppBaseUrl } from "@/lib/app-base-url";

export const dynamic = "force-dynamic";

/**
 * Silent SSO start: top-level authorize with prompt=none (no iframe).
 * Marks cooldown pending (`.b` when hub/?sso=1 bypass) before Keycloak.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = safeOidcReturnTo(
    url.searchParams.get("next") || url.searchParams.get("returnTo"),
    "/",
  );
  const viaBypass = url.searchParams.get("bypass") === "1";
  const secure = process.env.NODE_ENV === "production";
  const pendingCookie = oidcSsoCooldownSetCookie(secure, {
    outcome: "pending",
    viaBypass,
  });

  console.info("[oidc] silent attempt", {
    returnTo,
    viaBypass: viaBypass || undefined,
  });

  const config = getOidcConfig();
  if (!config) {
    logOidcNotConfigured("oidc-silent");
    console.info("[oidc] silent outcome", { outcome: "disabled" });
    const home = new URL(returnTo, getAppBaseUrl());
    const headers = new Headers();
    headers.set("Referrer-Policy", "no-referrer");
    applyOidcSetCookies(headers, [
      oidcSsoCooldownSetCookie(secure, { outcome: "fail", viaBypass }),
    ]);
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
    headers.set("Referrer-Policy", "no-referrer");
    applyOidcSetCookies(headers, [
      oidcSsoCooldownSetCookie(secure, { outcome: "fail", viaBypass }),
    ]);
    return NextResponse.redirect(home, { status: 302, headers });
  }

  console.info("[oidc] silent outcome", { outcome: "redirect_authorize" });
  const headers = new Headers();
  applyOidcSetCookies(headers, [pendingCookie]);
  headers.set("Referrer-Policy", "no-referrer");
  return NextResponse.redirect(result.url, { status: 302, headers });
}
