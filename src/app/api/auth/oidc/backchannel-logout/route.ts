import { runMwOidcHandler } from "@/server/mw-auth-route";

export const dynamic = "force-dynamic";

/** Keycloak Back-Channel Logout 1.0 — POST logout_token. */
export async function POST(request: Request) {
  return runMwOidcHandler(
    "/api/auth/oidc/backchannel-logout",
    "POST",
    request,
  );
}

export async function GET(request: Request) {
  return runMwOidcHandler(
    "/api/auth/oidc/backchannel-logout",
    "GET",
    request,
  );
}
