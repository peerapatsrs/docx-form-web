import { NextResponse } from "next/server";
import { enabledOAuthProviders } from "@/server/auth";
import { isDevAuthEnabled } from "@/lib/dev-auth-flag";
import { getDefaultDevAuthEmail } from "@/server/dev-auth-email";
import {
  isOidcEnabled,
  isPasswordLoginEnabled,
} from "@/server/oidc-config";

export const dynamic = "force-dynamic";

/** Public list of OAuth providers that have credentials configured. */
export async function GET() {
  const devAuth = isDevAuthEnabled();
  const oidc = isOidcEnabled();
  return NextResponse.json({
    providers: enabledOAuthProviders,
    passkey: true,
    googleConfigured: enabledOAuthProviders.includes("google"),
    /** Central Keycloak SSO (OIDC). Soft-off when OIDC_* env missing. */
    oidc,
    sso: oidc,
    ssoLoginPath: oidc ? "/api/auth/oidc/login" : null,
    ssoLogoutPath: oidc ? "/api/auth/oidc/logout" : null,
    /** Opt-in email/password until migration; default false. */
    passwordLogin: isPasswordLoginEnabled(),
    /** Local: pick DB user without real OAuth */
    devAuth,
    /** Preferred account for Run Local auto sign-in (only when devAuth). */
    devAuthDefaultEmail: devAuth ? getDefaultDevAuthEmail() ?? null : null,
  });
}
