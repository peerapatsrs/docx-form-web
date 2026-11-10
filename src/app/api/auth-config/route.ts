import { NextResponse } from "next/server";
import {
  isOidcEnabled,
  resolveOidcPasskeyManageUrl,
} from "@/server/oidc-config";
import { isOidcPasskeyListingEnabled } from "@/server/oidc-passkey";

export const dynamic = "force-dynamic";

/** Public auth surface — OIDC-only. Passkeys via Keycloak AIA. */
export async function GET() {
  const oidc = isOidcEnabled();
  const passkeyManageUrl = resolveOidcPasskeyManageUrl();
  return NextResponse.json({
    oidc,
    sso: oidc,
    ssoLoginPath: oidc ? "/api/auth/oidc/login" : null,
    ssoLogoutPath: oidc ? "/api/auth/oidc/logout" : null,
    /** AIA: register passwordless passkey (session required). */
    passkeyAddPath: oidc ? "/api/auth/oidc/passkey/add" : null,
    /** AIA remove helper prefix; append ?credentialId= */
    passkeyRemovePath: oidc ? "/api/auth/oidc/passkey/remove" : null,
    /** List own Keycloak credentials when admin client env is set. */
    passkeyListPath: oidc ? "/api/auth/oidc/passkey" : null,
    passkeyListEnabled: oidc && isOidcPasskeyListingEnabled(),
    /** Optional external override only — no account-console default. */
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
