"use client";

import { useEffect } from "react";
import { AuthBar } from "@/components/AuthBar";
import { BrandLockup } from "@/components/BrandLogo";
import {
  SITE_ABOUT,
  SITE_FEATURE_BULLETS,
  SITE_NAME,
} from "@/lib/site-meta";

/** Same shell as the original docx-form Web UI — logic lives in /public/app.js */
export default function Home() {
  // Load after React hydration so client render does not wipe #app / status.
  // Soft nav remounts home with a fresh #app — re-run boot (app.js is a singleton).
  // Guest trips through /login must hard-navigate (see AuthBar / login foot)
  // or the shell paints without topbar/status bindings.
  useEffect(() => {
    const w = window as Window & { __docxFormBoot?: () => void };
    const runBoot = () => {
      w.__docxFormBoot?.();
    };
    const existing = document.querySelector("script[data-docx-form-app]");
    if (existing) {
      // Wait a frame so the remounted #app / #status exist before rebind.
      requestAnimationFrame(() => requestAnimationFrame(runBoot));
      return;
    }
    const s = document.createElement("script");
    s.src = `/app.js?v=web63`;
    s.dataset.docxFormApp = "1";
    document.body.appendChild(s);
  }, []);

  return (
    <>
      <div className="ambient" aria-hidden="true">
        <span className="orb orb-a" />
        <span className="orb orb-b" />
        <span className="orb orb-c" />
        <span className="grain" />
      </div>

      <header className="topbar">
        <BrandLockup versionId="appVersion" />
        <div className="topbar-end">
          <AuthBar />
          <div className="status-pill" id="status">
            <span className="status-dot" id="statusDot" />
            <span id="statusText">กำลังเชื่อมต่อ…</span>
          </div>
        </div>
      </header>

      <div id="banner" className="banner" hidden role="status" aria-live="polite" />

      <main className="shell">
        {/* Crawlable product summary — UI itself mounts into #app via app.js */}
        <section className="sr-only" aria-label={`เกี่ยวกับ ${SITE_NAME}`}>
          <h1>{SITE_NAME} — กรอกแบบฟอร์มเอกสาร Word จากเทมเพลต .docx</h1>
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
            v…
          </span>
        </div>
      </footer>
    </>
  );
}
