"use client";

import { ADMIN_MODULES } from "@/lib/admin-modules";

export default function AdminOverviewPage() {
  const modules = ADMIN_MODULES.filter((m) => m.id !== "");

  return (
    <div className="admin-overview">
      <section className="admin-panel">
        <h2 className="admin-panel-title">ภาพรวมการจัดการ</h2>
        <p className="admin-muted">
          เลือกโมดูลจากเมนูด้านซ้าย — แผน ผู้ใช้ โควตา AI และบันทึกการใช้งาน
        </p>
        <ul className="admin-overview-list">
          {modules.map((mod) => (
            <li key={mod.href}>
              <strong>{mod.title}</strong>
              <span>{mod.description}</span>
            </li>
          ))}
        </ul>
      </section>
      {/* Developer scaffolding notes intentionally omitted from the UI (F03/F18). */}
    </div>
  );
}
