import { NextResponse } from "next/server";
import { safeOidcReturnTo } from "@/server/oidc-identities";
import { getAppBaseUrl } from "@/lib/app-base-url";

export const dynamic = "force-dynamic";

/**
 * Same-origin hop after silent quiet-fail.
 * Strips cross-site Referer (hub) so the final page load cannot re-bypass cooldown.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const next = safeOidcReturnTo(
    url.searchParams.get("next") || url.searchParams.get("returnTo"),
    "/",
  );
  const target = new URL(next, getAppBaseUrl());
  const headers = new Headers();
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "private, no-store");
  return NextResponse.redirect(target, { status: 302, headers });
}
