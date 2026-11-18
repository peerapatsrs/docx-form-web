"use client";

import { useEffect, useState } from "react";

type SiteFooterProps = {
  versionLabel: string;
};

/** Footer without owner mailto — support line only for elevated roles. */
export function SiteFooter({ versionLabel }: SiteFooterProps) {
  const [showSupport, setShowSupport] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/me", { credentials: "include" });
        const data = (await res.json().catch(() => ({}))) as {
          user?: { role?: string | null } | null;
        };
        if (cancelled || !data.user?.role) return;
        const roles = String(data.user.role)
          .split(",")
          .map((r) => r.trim().toLowerCase());
        if (roles.some((r) => r === "admin" || r === "superadmin")) {
          setShowSupport(true);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <footer className="credits" id="credits">
      {showSupport ? (
        <div className="credits-identity">
          <p className="credits-name">ติดต่อทีม docx-form</p>
          <a className="credits-email" href="mailto:support@tps18.space">
            support@tps18.space
          </a>
        </div>
      ) : (
        <div className="credits-identity">
          <p className="credits-name">docx-form</p>
          <p className="credits-email credits-email-text">เอกสาร Word จากเทมเพลต .docx</p>
        </div>
      )}
      <div className="credits-meta">
        <span className="credits-ver" id="creditsVersion">
          {versionLabel}
        </span>
      </div>
    </footer>
  );
}
