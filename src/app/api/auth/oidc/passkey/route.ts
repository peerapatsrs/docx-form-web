import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import {
  isOidcPasskeyListingEnabled,
  listOwnOidcPasskeys,
  resolveOwnKeycloakSub,
} from "@/server/oidc-passkey";
import { isOidcEnabled } from "@/server/oidc-config";

export const dynamic = "force-dynamic";

/**
 * List the signed-in user's own Keycloak webauthn-passwordless credentials.
 * Uses Admin API service-account token server-side — never sent to the browser.
 * When OIDC_ADMIN_CLIENT_* is unset → `{ canList: false, credentials: [] }`.
 */
export async function GET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "ต้องเข้าสู่ระบบ", code: "AUTH_REQUIRED" },
      { status: 401 },
    );
  }

  if (!isOidcEnabled()) {
    return NextResponse.json(
      { canList: false, credentials: [], error: "SSO_NOT_CONFIGURED" },
      { status: 404 },
    );
  }

  if (!isOidcPasskeyListingEnabled()) {
    return NextResponse.json({ canList: false, credentials: [] });
  }

  const sub = await resolveOwnKeycloakSub({
    userId: String(session.user.id),
  });
  if (!sub) {
    return NextResponse.json({
      canList: true,
      credentials: [],
      error: "OIDC_IDENTITY_MISSING",
    });
  }

  const result = await listOwnOidcPasskeys({ keycloakSub: sub });
  if (!result.ok) {
    return NextResponse.json(
      { canList: true, credentials: [], error: result.error },
      { status: result.status === 404 ? 404 : 502 },
    );
  }

  return NextResponse.json({
    canList: true,
    credentials: result.credentials,
  });
}
