import { NextResponse } from "next/server";
import { isOidcEnabled } from "@/server/oidc-config";

export const dynamic = "force-dynamic";

/** Public auth surface — OIDC-only. */
export async function GET() {
  const oidc = isOidcEnabled();
  return NextResponse.json({
    oidc,
    sso: oidc,
    ssoLoginPath: oidc ? "/api/auth/oidc/login" : null,
    ssoLogoutPath: oidc ? "/api/auth/oidc/logout" : null,
    /** @deprecated always false — OIDC is the only login */
    providers: [],
    passkey: false,
    passwordLogin: false,
    googleConfigured: false,
    devAuth: false,
    devAuthDefaultEmail: null,
  });
}
