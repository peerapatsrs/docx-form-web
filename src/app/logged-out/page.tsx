import Link from "next/link";
import { BrandLockup } from "@/components/BrandLogo";

/**
 * Post IdP logout landing — must NOT auto-redirect to /login (that would
 * immediately bounce into Keycloak again via OIDC-only /login).
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
          <Link className="auth-provider auth-provider-sso" href="/login">
            เข้าสู่ระบบด้วย TPS18 SSO
          </Link>
          <Link className="auth-provider" href="/">
            กลับหน้าหลัก
          </Link>
        </div>
      </div>
    </main>
  );
}
