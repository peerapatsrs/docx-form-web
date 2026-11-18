import { runMwOidcHandler } from "@/server/mw-auth-route";

export const dynamic = "force-dynamic";

/** POST-only — top-level HTML form. GET → 405. */
export async function GET(request: Request) {
  return runMwOidcHandler("/api/auth/oidc/logout", "GET", request);
}

export async function POST(request: Request) {
  return runMwOidcHandler("/api/auth/oidc/logout", "POST", request);
}
