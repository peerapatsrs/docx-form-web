import Link from "next/link";
import { BrandLogo } from "@/components/BrandLogo";

export default function NotFound() {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandLogo size={40} className="brand-logo auth-brand-logo" />
        </div>
        <h1 className="auth-title">ไม่พบหน้านี้</h1>
        <p className="auth-lead">
          ลิงก์อาจหมดอายุหรือถูกย้ายแล้ว — กลับไปหน้าหลักเพื่ออัปโหลดเทมเพลตหรือกรอกเอกสาร
        </p>
        <div className="auth-actions">
          <Link className="auth-provider auth-provider-google" href="/">
            กลับไปหน้าหลัก
          </Link>
        </div>
      </div>
    </main>
  );
}
