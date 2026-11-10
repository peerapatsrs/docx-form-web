import { NextResponse } from "next/server";
import {
  applyOidcSetCookies,
  buildOidcAuthorizationRedirect,
} from "@/server/oidc-flow";

export const dynamic = "force-dynamic";

/** Start OIDC authorization-code + PKCE login. Soft 404 when SSO env is missing. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("next") || url.searchParams.get("returnTo");
  const result = await buildOidcAuthorizationRedirect({ returnTo });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, sso: false },
      { status: result.status },
    );
  }
  const headers = new Headers();
  applyOidcSetCookies(headers, []);
  return NextResponse.redirect(result.url, { status: 302, headers });
}
