import { NextResponse } from "next/server";
import { enabledOAuthProviders } from "@/server/auth";
import { isDevAuthEnabled } from "@/server/dev-auth-plugin";

export const dynamic = "force-dynamic";

/** Public list of OAuth providers that have credentials configured. */
export async function GET() {
  return NextResponse.json({
    providers: enabledOAuthProviders,
    passkey: true,
    googleConfigured: enabledOAuthProviders.includes("google"),
    /** Local: pick DB user without real OAuth */
    devAuth: isDevAuthEnabled(),
  });
}
