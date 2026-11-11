import { BrandLockup } from "@/components/BrandLogo";

/**
 * Post IdP logout landing — must NOT auto-redirect to /login (that would
 * immediately bounce into Keycloak again via OIDC-only /login).
 *
 * Home uses a plain <a href="/?sso=1"> so the browser does a full document
 * navigation (Next <Link> soft-nav would skip silent SSO).
 */
export default function LoggedOutPage() {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandLockup />
        </div>
        <h1 className="auth-title">ออกจากระบบแล้ว</h1>
        <p className="auth-lead">
          เซสชันของแอปและ Keycloak ถูกปิดแล้ว — กดด้านล่างเมื่อต้องการเข้าสู่ระบบใหม่
        </p>
        <div className="auth-actions">
          <a className="auth-provider auth-provider-sso" href="/login">
            เข้าสู่ระบบด้วย TPS18 SSO
          </a>
          <a className="auth-provider" href="/?sso=1">
            กลับหน้าหลัก
          </a>
        </div>
      </div>
    </main>
  );
}
