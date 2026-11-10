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
      {/* Developer scaffolding notes intentionally omitted from the UI (F03/F18). */}
    </div>
  );
}
