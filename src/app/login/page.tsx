import { redirect } from "next/navigation";
import { getOidcConfig, logOidcNotConfigured } from "@/server/oidc-config";
import { buildOidcAuthorizationRedirect } from "@/server/oidc-flow";
import { safeOidcReturnTo } from "@/server/oidc-identities";
import { BrandLockup } from "@/components/BrandLogo";
import { redirectIfAuthenticated } from "@/lib/server-auth";

export const dynamic = "force-dynamic";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function firstParam(
  v: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * OIDC-only entry: immediately redirect to Keycloak authorize URL.
 * No chooser / SSO button. Missing OIDC_* → clear error page (no fallback login).
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = (await searchParams) || {};
  const nextRaw = firstParam(params.next) || firstParam(params.returnTo) || "/";
  const next = safeOidcReturnTo(nextRaw, "/");

  await redirectIfAuthenticated(next === "/" ? "/account" : next);

  const config = getOidcConfig();
  if (!config) {
    logOidcNotConfigured("login");
    return (
      <main className="auth-page">
        <div className="auth-card">
          <div className="auth-brand">
            <BrandLockup />
          </div>
          <h1 className="auth-title">SSO not configured</h1>
          <p className="auth-lead" role="alert">
            Central Keycloak login is not configured on this deployment. Set{" "}
            <code>OIDC_ISSUER</code>, <code>OIDC_CLIENT_ID</code>, and{" "}
            <code>OIDC_CLIENT_SECRET</code> (realm via issuer path, e.g.
            …/realms/tps18-dev). There is no alternate login.
          </p>
          <p className="auth-hint">
            ระบบล็อกอินกลางยังไม่ได้ตั้งค่า — ไม่มีช่องทางเข้าอื่น
          </p>
        </div>
      </main>
    );
  }

  const result = await buildOidcAuthorizationRedirect({
    returnTo: next,
    config,
  });
  if (!result.ok) {
    logOidcNotConfigured(`login-authorize:${result.error}`);
    return (
      <main className="auth-page">
        <div className="auth-card">
          <div className="auth-brand">
            <BrandLockup />
          </div>
          <h1 className="auth-title">SSO unavailable</h1>
          <p className="auth-lead" role="alert">
            Could not start Keycloak login ({result.error}). Check OIDC discovery
            and client credentials. There is no alternate login.
          </p>
        </div>
      </main>
    );
  }

  redirect(result.url);
}
