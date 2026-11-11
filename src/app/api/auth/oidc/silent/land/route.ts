import { runMwOidcHandler } from "@/server/mw-auth-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runMwOidcHandler("/api/auth/oidc/silent/land", "GET", request);
}
