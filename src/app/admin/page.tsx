"use client";

import Link from "next/link";
import { ADMIN_MODULES } from "@/lib/admin-modules";

export default function AdminOverviewPage() {
  const modules = ADMIN_MODULES.filter((m) => m.id !== "");

  return (
    <div className="admin-overview">
      <section className="admin-panel">
        <h2 className="admin-panel-title">โมดูลจัดการ</h2>
        <ul className="admin-card-grid">
          {modules.map((mod) => (
            <li key={mod.href}>
              <Link href={mod.href} className="admin-card">
                <span className="admin-pill admin-pill-live">ใช้งาน</span>
                <strong>{mod.title}</strong>
                <span>{mod.description}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <section className="admin-panel">
        <h2 className="admin-panel-title">เพิ่มโมดูลใหม่</h2>
        <p className="admin-muted">
          ลงทะเบียนใน <code>src/lib/admin-modules.ts</code> แล้วสร้าง{" "}
          <code>src/app/admin/&lt;id&gt;/page.tsx</code> + API ใต้{" "}
          <code>/api/admin/…</code> ถ้าต้องใช้
        </p>
      </section>
    </div>
  );
}
