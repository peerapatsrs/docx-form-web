import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import { runMwOidcHandler } from "@/server/mw-auth-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    return NextResponse.redirect(new URL("/login?next=/account", request.url));
  }
  const url = new URL(request.url);
  if (!url.searchParams.get("next")) {
    url.searchParams.set("next", "/account");
    return runMwOidcHandler(
      "/api/auth/oidc/passkey/remove",
      "GET",
      new Request(url.toString(), request),
    );
  }
  return runMwOidcHandler("/api/auth/oidc/passkey/remove", "GET", request);
}
