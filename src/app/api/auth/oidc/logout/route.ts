import { NextResponse } from "next/server";
import {
  applyOidcSetCookies,
  buildOidcLogoutRedirect,
  OIDC_ID_TOKEN_COOKIE,
  readCookie,
} from "@/server/oidc-flow";
import { oidcSsoCooldownClearCookie } from "@/server/oidc-silent";
import { getAppBaseUrl } from "@/lib/app-base-url";

export const dynamic = "force-dynamic";

function absoluteRedirect(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  const base = getAppBaseUrl();
  return `${base}${pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`}`;
}

async function logout(request: Request) {
  const idTokenHint = readCookie(
    request.headers.get("cookie"),
    OIDC_ID_TOKEN_COOKIE,
  );
  const result = await buildOidcLogoutRedirect({ idTokenHint });
  const secure = process.env.NODE_ENV === "production";
  const headers = new Headers();
  // RP logout ends Keycloak session; clear cooldown so a later hub login
  // can silent-check immediately (login_required then sets a fresh cooldown).
  applyOidcSetCookies(headers, [
    ...result.setCookies,
    oidcSsoCooldownClearCookie(secure),
  ]);
  return NextResponse.redirect(absoluteRedirect(result.redirectTo), {
    status: 302,
    headers,
  });
}

/** RP-initiated logout (GET or POST). */
export async function GET(request: Request) {
  return logout(request);
}

export async function POST(request: Request) {
  return logout(request);
}
