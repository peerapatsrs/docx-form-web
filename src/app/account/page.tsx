"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { BrandLockup } from "@/components/BrandLogo";
import { ProfileAvatar } from "@/components/ProfileAvatar";
import { AiKeysSection } from "@/components/AiKeysSection";

type SessionRow = {
  id: string;
  token: string;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  expiresAt?: string | Date;
  ipAddress?: string | null;
  userAgent?: string | null;
};

type MePayload = {
  user: {
    id: string;
    name: string | null;
    email: string | null;
    image: string | null;
    role: string;
    plan: string;
    emailVerified: boolean;
    createdAt: string | Date | null;
  };
  premium: {
    paid: boolean;
    plan: string;
    maxMultiTemplates: number;
    freeMaxMulti: number;
    paidMaxMulti: number;
  };
  session: { id: string; expiresAt: string | Date };
};

type PasskeyRow = {
  id: string;
  label: string;
  createdAt: string | null;
};

function passkeyStatusMessage(
  status: string | null,
): { kind: "ok" | "error"; text: string } | null {
  if (status === "success") {
    return { kind: "ok", text: "จัดการ passkey สำเร็จ" };
  }
  if (status === "cancelled") {
    return { kind: "error", text: "ยกเลิกการจัดการ passkey" };
  }
  if (status === "error") {
    return { kind: "error", text: "จัดการ passkey ไม่สำเร็จ" };
  }
  return null;
}

function isSuperAdmin(role: string): boolean {
  return role
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .includes("superadmin");
}

function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return "—";
  try {
    return new Date(v).toLocaleString("th-TH");
  } catch {
    return String(v);
  }
}

function shortUa(ua: string | null | undefined): string {
  if (!ua) return "ไม่ทราบอุปกรณ์";
  const s = ua.slice(0, 80);
  if (/iPhone|iPad/i.test(ua)) return "iOS / Safari";
  if (/Android/i.test(ua)) return "Android";
  if (/Macintosh/i.test(ua)) return "Mac";
  if (/Windows/i.test(ua)) return "Windows";
  if (/CriOS|Chrome/i.test(ua)) return "Chrome";
  if (/Firefox/i.test(ua)) return "Firefox";
  return s + (ua.length > 80 ? "…" : "");
}

const SSO_LOGOUT_PATH = "/api/auth/oidc/logout";

export default function AccountPage() {
  const [me, setMe] = useState<MePayload | null>(null);
  const [editName, setEditName] = useState("");
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [passkeyAddPath, setPasskeyAddPath] = useState<string | null>(null);
  const [passkeyListEnabled, setPasskeyListEnabled] = useState(false);
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [passkeysLoading, setPasskeysLoading] = useState(false);

  const reload = useCallback(async () => {
    setError("");
    const meRes = await fetch("/api/me", { credentials: "include" });
    const meData = (await meRes.json().catch(() => ({}))) as MePayload & {
      error?: string;
      user?: MePayload["user"] | null;
    };
    if (meRes.ok && !meData.user) {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- hard nav required
      window.location.assign("/login?next=/account");
      return;
    }
    if (!meRes.ok || !meData.user) {
      setError(meData.error || "โหลดบัญชีไม่สำเร็จ");
      setLoading(false);
      return;
    }
    setMe(meData as MePayload);
    setEditName(meData.user.name || "");

    const cfgRes = await fetch("/api/auth-config", { credentials: "include" });
    const cfg = (await cfgRes.json().catch(() => ({}))) as {
      passkeyAddPath?: string | null;
      passkeyListEnabled?: boolean;
      oidc?: boolean;
    };
    const addPath =
      typeof cfg.passkeyAddPath === "string" && cfg.passkeyAddPath
        ? cfg.passkeyAddPath
        : null;
    setPasskeyAddPath(addPath);
    const listEnabled = Boolean(cfg.passkeyListEnabled);
    setPasskeyListEnabled(listEnabled);

    if (listEnabled) {
      setPasskeysLoading(true);
      try {
        const listRes = await fetch("/api/auth/oidc/passkey", {
          credentials: "include",
        });
        const listData = (await listRes.json().catch(() => ({}))) as {
          credentials?: PasskeyRow[];
        };
        setPasskeys(
          listRes.ok && Array.isArray(listData.credentials)
            ? listData.credentials
            : [],
        );
      } finally {
        setPasskeysLoading(false);
      }
    } else {
      setPasskeys([]);
    }

    const sess = await authClient.listSessions();
    if (!sess.error && Array.isArray(sess.data)) {
      setSessions(sess.data as SessionRow[]);
    } else {
      setSessions([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => reload());
  }, [reload]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const msg = passkeyStatusMessage(params.get("passkey"));
    if (!msg) return;
    if (msg.kind === "ok") setOk(msg.text);
    else setError(msg.text);
    params.delete("passkey");
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", next);
  }, []);

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setBusy("profile");
    setError("");
    setOk("");
    try {
      const { error: err } = await authClient.updateUser({
        name: editName.trim() || me?.user.name || "ผู้ใช้",
      });
      if (err) {
        setError(err.message || "บันทึกโปรไฟล์ไม่สำเร็จ");
        return;
      }
      setOk("บันทึกชื่อแสดงแล้ว");
      await reload();
    } finally {
      setBusy(null);
    }
  }

  async function revokeOne(session: SessionRow) {
    setBusy(`sess-${session.id}`);
    setError("");
    setOk("");
    try {
      const { error: err } = await authClient.revokeSession({
        token: session.token,
      });
      if (err) {
        setError(err.message || "ปิดเซสชันไม่สำเร็จ");
        return;
      }
      setOk("ปิดเซสชันแล้ว");
      await reload();
    } finally {
      setBusy(null);
    }
  }

  async function revokeOthers() {
    if (!window.confirm("ออกจากระบบทุกเครื่องอื่น ยกเว้นเครื่องนี้?")) return;
    setBusy("revoke-others");
    setError("");
    setOk("");
    try {
      const { error: err } = await authClient.revokeOtherSessions();
      if (err) {
        setError(err.message || "ปิดเซสชันอื่นไม่สำเร็จ");
        return;
      }
      setOk("ปิดเซสชันเครื่องอื่นแล้ว");
      await reload();
    } finally {
      setBusy(null);
    }
  }

  function signOut() {
    if (
      !window.confirm(
        "ออกจากระบบ?\nจะออกจากบัญชีนี้บนเครื่องนี้และที่ Keycloak",
      )
    ) {
      return;
    }
    // Top-level document POST → 303 to Keycloak end_session.
    const form = document.createElement("form");
    form.method = "POST";
    form.action = SSO_LOGOUT_PATH;
    document.body.appendChild(form);
    form.submit();
  }

  if (loading) {
    return (
      <main className="account-page">
        <div className="account-shell">
          <BrandLockup className="brand account-brand" />
          <p className="auth-hint">กำลังโหลดบัญชี…</p>
        </div>
      </main>
    );
  }

  if (!me) {
    return (
      <main className="account-page">
        <div className="account-shell">
          <BrandLockup className="brand account-brand" />
          <p className="auth-error">{error || "โหลดบัญชีไม่สำเร็จ"}</p>
          <p className="auth-foot">
            <Link href="/login?next=/account">เข้าสู่ระบบ</Link>
          </p>
        </div>
      </main>
    );
  }

  const { user, premium, session: currentSession } = me;
  const currentToken = sessions.find((s) => s.id === currentSession.id)?.token;

  return (
    <main className="account-page">
      <div className="account-shell">
        <BrandLockup className="brand account-brand" />
        <header className="account-hero">
          <ProfileAvatar
            image={user.image}
            name={user.name}
            email={user.email}
            className="account-avatar"
            fallbackClassName="account-avatar account-avatar-fallback"
            size={72}
          />
          <div className="account-hero-copy">
            <p className="auth-eyebrow">บัญชีของฉัน</p>
            <h1 className="auth-title">{user.name || "ผู้ใช้"}</h1>
            <p className="auth-lead">{user.email || "—"}</p>
            <p className="account-badges">
              <span className={`account-badge ${premium.paid ? "is-pro" : ""}`}>
                {premium.paid ? "จ่ายแล้ว (pro)" : "ฟรี"}
              </span>
              <span className="account-badge">{user.role || "user"}</span>
              {user.emailVerified ? (
                <span className="account-badge is-ok">อีเมลยืนยันแล้ว</span>
              ) : (
                <span className="account-badge">อีเมลยังไม่ยืนยัน</span>
              )}
              {isSuperAdmin(user.role) ? (
                <Link className="account-badge is-link" href="/admin">
                  Admin
                </Link>
              ) : null}
            </p>
          </div>
        </header>

        {error || ok ? (
          <div
            className="account-flash"
            role={error ? "alert" : "status"}
            aria-live="polite"
          >
            <p className={error ? "auth-error account-flash-msg" : "auth-ok account-flash-msg"}>
              {error || ok}
            </p>
            <button
              type="button"
              className="account-flash-dismiss"
              aria-label="ปิดข้อความ"
              onClick={() => {
                setError("");
                setOk("");
              }}
            >
              ×
            </button>
          </div>
        ) : null}

        <section className="account-panel">
          <h2 className="auth-section-title">โปรไฟล์</h2>
          <form className="account-form" onSubmit={(e) => void saveProfile(e)}>
            <label className="account-field">
              <span>ชื่อที่แสดง</span>
              <input
                className="admin-input"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                maxLength={80}
                required
              />
            </label>
            <label className="account-field">
              <span>อีเมล</span>
              <input className="admin-input" value={user.email || ""} disabled />
            </label>
            <p className="auth-hint">
              สมัครเมื่อ {fmtDate(user.createdAt)} · เข้าด้วย TPS18 SSO (Keycloak)
              เท่านั้น
            </p>
            <button
              type="submit"
              className="admin-btn admin-btn-primary"
              disabled={busy === "profile"}
            >
              {busy === "profile" ? "กำลังบันทึก…" : "บันทึกโปรไฟล์"}
            </button>
          </form>
        </section>

        <AiKeysSection />

        <section className="account-panel" id="passkeys">
          <div className="account-panel-head">
            <h2 className="auth-section-title">จัดการ passkey</h2>
            {passkeyAddPath ? (
              <a
                className="admin-btn admin-btn-primary"
                href={`${passkeyAddPath}?next=${encodeURIComponent("/account")}`}
              >
                เพิ่ม passkey
              </a>
            ) : null}
          </div>
          <p className="auth-hint">
            Passkey ลงทะเบียนที่ Keycloak ผ่าน SSO (ไม่เก็บในแอปนี้)
          </p>
          {!passkeyAddPath ? (
            <p className="auth-hint">
              SSO ยังไม่ได้ตั้งค่า — ไม่สามารถจัดการ passkey ได้
            </p>
          ) : null}
          {passkeyAddPath && passkeyListEnabled ? (
            passkeysLoading ? (
              <p className="auth-hint">กำลังโหลด passkey…</p>
            ) : passkeys.length === 0 ? (
              <p className="auth-hint">ยังไม่มี passkey</p>
            ) : (
              <ul className="account-row-list">
                {passkeys.map((pk) => (
                  <li key={pk.id} className="account-row-item">
                    <div className="account-row-meta">
                      <strong>{pk.label || "Passkey"}</strong>
                      <span className="auth-bar-muted">
                        สร้างเมื่อ {fmtDate(pk.createdAt)}
                      </span>
                    </div>
                    <a
                      className="auth-bar-btn auth-bar-ghost"
                      href={`/api/auth/oidc/passkey/remove?credentialId=${encodeURIComponent(pk.id)}&next=${encodeURIComponent("/account")}`}
                    >
                      ลบ
                    </a>
                  </li>
                ))}
              </ul>
            )
          ) : passkeyAddPath ? (
            <p className="auth-hint">
              รายการ passkey จะแสดงเมื่อตั้งค่า OIDC_ADMIN_CLIENT_ID /
              OIDC_ADMIN_CLIENT_SECRET
            </p>
          ) : null}
        </section>

        <section className="account-panel">
          <h2 className="auth-section-title">แผน & โควตา</h2>
          <ul className="admin-kv">
            <li>
              <span>แผนปัจจุบัน</span>
              <strong>{premium.paid ? "pro (จ่ายแล้ว)" : "free"}</strong>
            </li>
            <li>
              <span>เทมเพลตพร้อมกันได้</span>
              <strong>{premium.maxMultiTemplates} ไฟล์ / ครั้ง</strong>
            </li>
            <li>
              <span>โควตาฟรี / จ่ายแล้ว</span>
              <strong>
                {premium.freeMaxMulti} / {premium.paidMaxMulti}
              </strong>
            </li>
          </ul>
        </section>

        <section className="account-panel">
          <div className="account-panel-head">
            <h2 className="auth-section-title">เซสชันที่ใช้งาน</h2>
            <button
              type="button"
              className="admin-btn"
              disabled={busy === "revoke-others" || sessions.length <= 1}
              onClick={() => void revokeOthers()}
            >
              ออกจากเครื่องอื่น
            </button>
          </div>
          {sessions.length === 0 ? (
            <p className="auth-hint">ไม่พบเซสชัน</p>
          ) : (
            <ul className="account-row-list">
              {sessions.map((s) => {
                const isCurrent =
                  s.id === currentSession.id ||
                  (currentToken ? s.token === currentToken : false);
                return (
                  <li key={s.id} className="account-row-item">
                    <div className="account-row-meta">
                      <strong>
                        {shortUa(s.userAgent)}
                        {isCurrent ? " · เครื่องนี้" : ""}
                      </strong>
                      <span className="auth-bar-muted">
                        {s.ipAddress || "IP —"}
                        {" · หมดอายุ "}
                        {fmtDate(s.expiresAt)}
                      </span>
                    </div>
                    {!isCurrent ? (
                      <button
                        type="button"
                        className="auth-bar-btn auth-bar-ghost"
                        disabled={busy === `sess-${s.id}`}
                        onClick={() => void revokeOne(s)}
                      >
                        ออกจากเซสชัน
                      </button>
                    ) : (
                      <span className="account-badge is-ok">ปัจจุบัน</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <footer className="account-foot">
          <Link href="/">← หน้าแรก</Link>
          <button
            type="button"
            className="admin-btn admin-btn-danger"
            onClick={signOut}
          >
            ออกจากระบบ
          </button>
        </footer>
      </div>
    </main>
  );
}
