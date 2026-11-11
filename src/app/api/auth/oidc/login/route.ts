import { runMwOidcHandler } from "@/server/mw-auth-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runMwOidcHandler("/api/auth/oidc/login", "GET", request);
}

export async function POST(request: Request) {
  return runMwOidcHandler("/api/auth/oidc/login", "POST", request);
}
