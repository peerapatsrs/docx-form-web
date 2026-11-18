import { BrandLockup } from "@/components/BrandLogo";
import { formatAppVersionLabel } from "@/lib/app-build-info";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function readAppVersionLabel(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf-8"),
    ) as { version?: string };
    return formatAppVersionLabel(String(pkg.version || "0.0.0"));
  } catch {
    return formatAppVersionLabel("0.0.0");
  }
}

export default function NotFound() {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandLockup versionLabel={readAppVersionLabel()} />
        </div>
        <h1 className="auth-title">ไม่พบหน้านี้</h1>
        <p className="auth-lead">
          หน้าที่ท่านเปิดไม่มีในระบบ — กลับไปหน้าหลักเพื่ออัปโหลดเทมเพลตและกรอกฟอร์ม
        </p>
        <div className="auth-actions">
          {/* Hard nav so the guest shell remounts with app.js. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- intentional full reload */}
          <a className="auth-provider auth-provider-google" href="/">
            ไปหน้าอัปโหลด
          </a>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- intentional full reload */}
          <a
            className="auth-provider"
            href="/login"
            style={{
              minHeight: 44,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            เข้าสู่ระบบ
          </a>
        </div>
      </div>
    </main>
  );
}
