import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getOidcConfig, logOidcNotConfigured } from "@/server/oidc-config";
import { safeOidcReturnTo } from "@/server/oidc-identities";
import {
  OIDC_FAIL_COOKIE,
  oidcLoginErrorCopy,
  shouldBlockOidcAutoRedirect,
} from "@/server/oidc-login-guard";
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

function LoginErrorPanel(props: {
  errorCode: string;
  next: string;
}) {
  const copy = oidcLoginErrorCopy(props.errorCode);
  const retryHref = `/api/auth/oidc/login?next=${encodeURIComponent(props.next)}`;
  const logoutHref = "/api/auth/oidc/logout";
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandLockup />
        </div>
        <h1 className="auth-title">{copy.title}</h1>
        <p className="auth-lead" role="alert">
          {copy.lead}
        </p>
        <p className="auth-hint">{copy.hint}</p>
        <p className="auth-foot" style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
          <a className="admin-btn admin-btn-primary" href={retryHref}>
            ลองเข้าใหม่
          </a>
          <a className="admin-btn" href={logoutHref}>
            ออกจากระบบ Keycloak
          </a>
        </p>
      </div>
    </main>
  );
}

/**
 * Interactive OIDC entry (button / protected redirect).
 * Silent SSO is middleware → /api/auth/oidc/silent (prompt=none).
 * With ?error= (or fail-cookie loop guard) → static error page, never auto-redirect.
 */
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = (await searchParams) || {};
  const nextRaw = firstParam(params.next) || firstParam(params.returnTo) || "/";
  const next = safeOidcReturnTo(nextRaw, "/");
  const errorRaw = firstParam(params.error);

  await redirectIfAuthenticated(next === "/" ? "/account" : next);

  if (errorRaw) {
    return <LoginErrorPanel errorCode={String(errorRaw)} next={next} />;
  }

  const jar = await cookies();
  const failRaw = jar.get(OIDC_FAIL_COOKIE)?.value;
  if (shouldBlockOidcAutoRedirect(failRaw)) {
    return <LoginErrorPanel errorCode="oidc_loop_guard" next={next} />;
  }

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

  // Interactive authorize via API (clears post-logout silent-skip cookie).
  redirect(
    `/api/auth/oidc/login?next=${encodeURIComponent(next)}`,
  );
}
