import { NextResponse } from "next/server";
import {
  isOidcEnabled,
  resolveOidcPasskeyManageUrl,
} from "@/server/oidc-config";

export const dynamic = "force-dynamic";

/** Public auth surface — OIDC-only. Passkeys are managed at Keycloak. */
export async function GET() {
  const oidc = isOidcEnabled();
  const passkeyManageUrl = resolveOidcPasskeyManageUrl();
  return NextResponse.json({
    oidc,
    sso: oidc,
    ssoLoginPath: oidc ? "/api/auth/oidc/login" : null,
    ssoLogoutPath: oidc ? "/api/auth/oidc/logout" : null,
    /** Keycloak account-console URL; null when SSO is not configured. */
    passkeyManageUrl,
    /** @deprecated always false — app no longer hosts WebAuthn */
    passkey: false,
    providers: [],
    passwordLogin: false,
    googleConfigured: false,
    devAuth: false,
    devAuthDefaultEmail: null,
  });
}
