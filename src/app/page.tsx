"use client";

import { useEffect } from "react";
import { AuthBar } from "@/components/AuthBar";

/** Same shell as the original docx-form Web UI — logic lives in /public/app.js */
export default function Home() {
  // Load after React hydration so client render does not wipe #app / status.
  useEffect(() => {
    if (document.querySelector("script[data-docx-form-app]")) return;
    const s = document.createElement("script");
    s.src = `/app.js?v=web19`;
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
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div className="brand-copy">
            <span className="brand-text">docx-form</span>
            <span className="brand-ver" id="appVersion">
              v…
            </span>
          </div>
        </div>
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
          <span className="credits-sep" aria-hidden="true">
            ·
          </span>
          <span className="credits-license">MIT License</span>
        </div>
      </footer>
    </>
  );
}
