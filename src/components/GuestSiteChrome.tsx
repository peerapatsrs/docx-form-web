"use client";

import { AuthBar } from "@/components/AuthBar";
import { BrandLockup } from "@/components/BrandLogo";
import { SITE_NAME } from "@/lib/site-meta";

type GuestSiteChromeProps = {
  children: React.ReactNode;
  versionLabel?: string;
};

/** Minimal site header for guests (login / marketing) — no app.js upload shell. */
export function GuestSiteChrome({
  children,
  versionLabel = "v…",
}: GuestSiteChromeProps) {
  return (
    <>
      <a className="skip-link" href="#main-content">
        ข้ามไปยังเนื้อหาหลัก (ลัด)
      </a>
      <div className="ambient" aria-hidden="true">
        <span className="orb orb-a" />
        <span className="orb orb-b" />
        <span className="orb orb-c" />
        <span className="grain" />
      </div>
      <header className="topbar">
        <BrandLockup versionLabel={versionLabel} />
        <div className="topbar-end">
          <AuthBar />
          <div className="status-pill" id="status" aria-hidden="true">
            <span className="status-dot" id="statusDot" />
            <span id="statusText">{SITE_NAME}</span>
          </div>
        </div>
      </header>
      <div id="main-content" tabIndex={-1}>
        {children}
      </div>
      <footer className="credits credits-minimal">
        <div className="credits-meta">
          <span className="credits-ver">{versionLabel}</span>
        </div>
      </footer>
    </>
  );
}
