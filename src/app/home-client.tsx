"use client";

import { useEffect } from "react";
import { AuthBar } from "@/components/AuthBar";
import { BrandLockup } from "@/components/BrandLogo";
import {
  SITE_ABOUT,
  SITE_FEATURE_BULLETS,
  SITE_NAME,
} from "@/lib/site-meta";

type HomeClientProps = {
  appJsSrc: string;
  fieldNamesSrc: string;
  versionLabel: string;
};

/** Same shell as the original docx-form Web UI — logic lives in /public/app.js */
export function HomeClient({
  appJsSrc,
  fieldNamesSrc,
  versionLabel,
}: HomeClientProps) {
  // Load after React hydration so client render does not wipe #app / status.
  // Soft nav remounts home with a fresh #app — re-run boot (app.js is a singleton).
  // Guest trips through /login must hard-navigate (see AuthBar / login foot)
  // or the shell paints without topbar/status bindings.
  useEffect(() => {
    const w = window as Window & {
      __docxFormBoot?: () => void;
      DocxFieldNames?: unknown;
    };
    const runBoot = () => {
      w.__docxFormBoot?.();
    };
    const loadAppAfterFieldNames = () => {
      // Soft remount: scripts already in DOM — just rebind the shell.
      if (document.querySelector("script[data-docx-form-app]")) {
        requestAnimationFrame(() => requestAnimationFrame(runBoot));
        return;
      }
      const s = document.createElement("script");
      // Module so app.js can import ./ui-labels.js; still waits for field-names.
      s.type = "module";
      s.src = appJsSrc;
      s.dataset.docxFormApp = "1";
      document.body.appendChild(s);
    };

    // Always resolve field-names.js before app.js (classic global, then module).
    if (w.DocxFieldNames) {
      loadAppAfterFieldNames();
      return;
    }
    const existingNames = document.querySelector(
      "script[data-docx-field-names]",
    ) as HTMLScriptElement | null;
    if (existingNames) {
      const resume = () => loadAppAfterFieldNames();
      if (w.DocxFieldNames) resume();
      else existingNames.addEventListener("load", resume, { once: true });
      return;
    }
    const names = document.createElement("script");
    names.src = fieldNamesSrc;
    names.dataset.docxFieldNames = "1";
    names.onload = () => loadAppAfterFieldNames();
    document.body.appendChild(names);
  }, [appJsSrc, fieldNamesSrc]);

  return (
    <>
      <a className="skip-link" href="#main-content">
        ข้ามไปยังเนื้อหาหลัก
      </a>
      <div className="ambient" aria-hidden="true">
        <span className="orb orb-a" />
        <span className="orb orb-b" />
        <span className="orb orb-c" />
        <span className="grain" />
      </div>

      <header className="topbar">
        <BrandLockup versionId="appVersion" versionLabel={versionLabel} />
        <div className="topbar-end">
          <AuthBar />
          <div className="status-pill" id="status">
            <span className="status-dot" id="statusDot" />
            <span id="statusText">กำลังเชื่อมต่อ…</span>
          </div>
        </div>
      </header>

      <div
        id="banner"
        className="banner"
        hidden
        role="status"
        aria-live="polite"
        aria-atomic="true"
      />

      <main className="shell" id="main-content" tabIndex={-1}>
        {/* Crawlable product summary — UI itself mounts into #app via app.js */}
        <section className="sr-only" aria-label={`เกี่ยวกับ ${SITE_NAME}`}>
          <h1>
            {SITE_NAME} — กรอกแบบฟอร์มเอกสาร Word จากเทมเพลต .docx
          </h1>
          <p>
            อัปโหลดเทมเพลตที่มีแท็ก {"{{ชื่อฟิลด์}}"} แล้วกรอกบนหน้าเว็บ ·
            รองรับหลายเทมเพลต · JSON · AI (BYOK)
          </p>
          <p>{SITE_ABOUT}</p>
          <ul>
            {SITE_FEATURE_BULLETS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
        <div className="sheet" id="app" />
      </main>

      <footer className="credits" id="credits">
        <div className="credits-identity">
          <p className="credits-name">Peerapat Surasing</p>
          <a className="credits-email" href="mailto:peerapat.srs@gmail.com">
            peerapat.srs@gmail.com
          </a>
        </div>
        <div className="credits-meta">
          <span className="credits-ver" id="creditsVersion">
            {versionLabel}
          </span>
        </div>
      </footer>
    </>
  );
}
