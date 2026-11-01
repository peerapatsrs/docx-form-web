"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { BrandLogo, BRAND_NAME } from "@/components/BrandLogo";
import {
  ADMIN_MODULES,
  adminModulesByGroup,
  findAdminModule,
} from "@/lib/admin-modules";

/** Shell only — hard auth is in admin/layout.tsx (server) + proxy.ts */
export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() || "/admin";
  const current = findAdminModule(pathname);
  const groups = adminModulesByGroup();
  const liveCount = ADMIN_MODULES.filter((m) => m.status === "live").length;
  const plannedCount = ADMIN_MODULES.filter((m) => m.status === "planned").length;

  return (
    <div className="admin-console">
      <aside className="admin-rail" aria-label="เมนูแอดมิน">
        <div className="admin-rail-brand">
          <BrandLogo size={32} className="brand-logo admin-rail-logo" />
          <div>
            <p className="admin-kicker">{BRAND_NAME}</p>
            <strong>Admin</strong>
          </div>
        </div>

        <nav className="admin-rail-nav">
          {groups.map(({ group, modules }) => (
            <div key={group} className="admin-rail-group">
              <p className="admin-rail-group-label">{group}</p>
              <ul>
                {modules.map((mod) => {
                  const active =
                    mod.href === "/admin"
                      ? pathname === "/admin" || pathname === "/admin/"
                      : pathname === mod.href ||
                        pathname.startsWith(`${mod.href}/`);
                  return (
                    <li key={mod.href}>
                      <Link
                        href={mod.href}
                        className={`admin-rail-link ${active ? "is-active" : ""} ${
                          mod.status === "planned" ? "is-planned" : ""
                        }`}
                        aria-current={active ? "page" : undefined}
                      >
                        <span className="admin-rail-link-title">{mod.title}</span>
                        {mod.status === "planned" ? (
                          <span className="admin-pill">เร็วๆ นี้</span>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="admin-rail-foot">
          <p>
            {liveCount} ใช้งาน · {plannedCount} เตรียมไว้
          </p>
          <p>
            <Link href="/">← หน้าแรก</Link>
            {" · "}
            <Link href="/account">บัญชี</Link>
          </p>
        </div>
      </aside>

      <div className="admin-main">
        <header className="admin-main-head">
          <div>
            <p className="admin-kicker">
              {current?.group || "Admin"}
              {current?.status === "planned" ? " · ยังไม่เปิด" : ""}
            </p>
            <h1 className="admin-main-title">{current?.title || "คอนโซล"}</h1>
            {current?.description ? (
              <p className="admin-main-desc">{current.description}</p>
            ) : null}
          </div>
        </header>
        <div className="admin-main-body">{children}</div>
      </div>
    </div>
  );
}
