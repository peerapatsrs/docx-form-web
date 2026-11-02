import { NextResponse } from "next/server";
import { enabledOAuthProviders } from "@/server/auth";
import {
  getDefaultDevAuthEmail,
  isDevAuthEnabled,
} from "@/lib/dev-auth-flag";

export const dynamic = "force-dynamic";

/** Public list of OAuth providers that have credentials configured. */
export async function GET() {
  const devAuth = isDevAuthEnabled();
  return NextResponse.json({
    providers: enabledOAuthProviders,
    passkey: true,
    googleConfigured: enabledOAuthProviders.includes("google"),
    /** Local: pick DB user without real OAuth */
    devAuth,
    /** Preferred account for Run Local auto sign-in (only when devAuth). */
    devAuthDefaultEmail: devAuth ? getDefaultDevAuthEmail() : null,
  });
}
