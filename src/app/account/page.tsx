"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { getAuthenticatorName } from "@better-auth/passkey";
import { PasskeyMark } from "@/components/AuthIcons";
import { BrandLockup } from "@/components/BrandLogo";
import { ProfileAvatar } from "@/components/ProfileAvatar";

type PasskeyRow = {
  id: string;
  name?: string | null;
  aaguid?: string | null;
  createdAt?: string | Date;
  deviceType?: string | null;
  backedUp?: boolean;
};

type AccountRow = {
  id: string;
  providerId: string;
  accountId?: string;
  createdAt?: string | Date;
};

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

function providerLabel(id: string): string {
  const map: Record<string, string> = {
    google: "Google",
    github: "GitHub",
    microsoft: "Microsoft",
    apple: "Apple",
    discord: "Discord",
    credential: "อีเมล/รหัสผ่าน",
  };
  return map[id] || id;
}

export default function AccountPage() {
  const [me, setMe] = useState<MePayload | null>(null);
  const [editName, setEditName] = useState("");
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setError("");
    const meRes = await fetch("/api/me", { credentials: "include" });
    if (meRes.status === 401) {
      // Full navigation — account is gated; soft router can leave app.js shell half-mounted.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- hard nav required
      window.location.assign("/login");
      return;
    }
    const meData = (await meRes.json().catch(() => ({}))) as MePayload & {
      error?: string;
    };
    if (!meRes.ok || !meData.user) {
      setError(meData.error || "โหลดบัญชีไม่สำเร็จ");
      setLoading(false);
      return;
    }
    setMe(meData as MePayload);
    setEditName(meData.user.name || "");

    const [pk, acc, sess, cfg] = await Promise.all([
      authClient.passkey.listUserPasskeys(),
      authClient.listAccounts(),
      authClient.listSessions(),
      fetch("/api/auth-config").then((r) => r.json()).catch(() => ({})),
    ]);

    if (pk.error) {
      setError(pk.error.message || "โหลดพาสคีย์ไม่สำเร็จ");
    } else {
      setPasskeys(Array.isArray(pk.data) ? (pk.data as PasskeyRow[]) : []);
    }

    if (!acc.error && Array.isArray(acc.data)) {
      setAccounts(acc.data as AccountRow[]);
    } else {
      setAccounts([]);
    }

    if (!sess.error && Array.isArray(sess.data)) {
      setSessions(sess.data as SessionRow[]);
    } else {
      setSessions([]);
    }

    const prov = (cfg as { providers?: string[] }).providers;
    setProviders(Array.isArray(prov) ? prov : []);
    setLoading(false);
  }, []);

  useEffect(() => {
    // Defer so setState is not synchronous inside the effect body (react-hooks/set-state-in-effect).
    void Promise.resolve().then(() => reload());
  }, [reload]);

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

  async function addPasskey() {
    setBusy("passkey");
    setError("");
    setOk("");
    try {
      const label = editName || me?.user.email || "docx-form";
      const { error: err } = await authClient.passkey.addPasskey({
        name: `${label} · ${new Date().toLocaleDateString("th-TH")}`,
      });
      if (err) {
        setError(err.message || "ลงทะเบียนพาสคีย์ไม่สำเร็จ");
        return;
      }
      setOk("ลงทะเบียนพาสคีย์แล้ว — เข้าครั้งถัดไปด้วยพาสคีย์ได้จากหน้าล็อกอิน");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ลงทะเบียนพาสคีย์ไม่สำเร็จ");
    } finally {
      setBusy(null);
    }
  }

  async function removePasskey(id: string) {
    if (!window.confirm("ลบพาสคีย์นี้?")) return;
    setBusy(`pk-${id}`);
    setError("");
    setOk("");
    try {
      const { error: err } = await authClient.passkey.deletePasskey({ id });
      if (err) {
        setError(err.message || "ลบไม่สำเร็จ");
        return;
      }
      setOk("ลบพาสคีย์แล้ว");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ลบไม่สำเร็จ");
    } finally {
      setBusy(null);
    }
  }

  async function linkProvider(provider: string) {
    setBusy(`link-${provider}`);
    setError("");
    try {
      await authClient.linkSocial({
        provider: provider as "google",
        callbackURL: "/account",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "เชื่อมบัญชีไม่สำเร็จ");
      setBusy(null);
    }
  }

  async function unlinkProvider(account: AccountRow) {
    if (accounts.length <= 1 && passkeys.length === 0) {
      setError("ต้องเหลือช่องทางเข้าอย่างน้อย 1 อย่าง (OAuth หรือพาสคีย์)");
      return;
    }
    if (!window.confirm(`ยกเลิกการเชื่อม ${providerLabel(account.providerId)}?`)) {
      return;
    }
    setBusy(`unlink-${account.id}`);
    setError("");
    setOk("");
    try {
      const { error: err } = await authClient.unlinkAccount({
        accountId: account.id,
      });
      if (err) {
        setError(err.message || "ยกเลิกการเชื่อมไม่สำเร็จ");
        return;
      }
      setOk(`ยกเลิกการเชื่อม ${providerLabel(account.providerId)} แล้ว`);
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
    void authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- hard nav after sign-out
          window.location.assign("/login");
        },
      },
    });
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
            <Link href="/login">เข้าสู่ระบบ</Link>
          </p>
        </div>
      </main>
    );
  }

  const { user, premium, session: currentSession } = me;
  const linkedProviders = new Set(accounts.map((a) => a.providerId));
  const linkable = providers.filter((p) => !linkedProviders.has(p));
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

        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}
        {ok ? (
          <p className="auth-ok" role="status">
            {ok}
          </p>
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
              สมัครเมื่อ {fmtDate(user.createdAt)} · เข้าด้วย OAuth / พาสคีย์
              (ไม่มีรหัสผ่านในระบบ)
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
          {!premium.paid ? (
            <p className="auth-hint">
              บัญชีฟรีใช้ได้สูงสุด {premium.freeMaxMulti} ไฟล์ต่อครั้ง —
              เมื่ออัปเกรดจะได้ถึง {premium.paidMaxMulti} (ติดต่อผู้ดูแลระบบ)
            </p>
          ) : (
            <p className="auth-hint">
              คุณใช้โควตาสมาชิกจ่ายแล้ว · สร้างหลายเทมเพลตได้สูงสุด{" "}
              {premium.maxMultiTemplates} ไฟล์ต่อครั้ง ({premium.plan || "pro"})
            </p>
          )}
        </section>

        <section className="account-panel">
          <h2 className="auth-section-title">บัญชีที่เชื่อม</h2>
          <p className="auth-hint">ผู้ให้บริการ OAuth ที่ใช้เข้าสู่ระบบ</p>
          {accounts.length === 0 ? (
            <p className="auth-hint">ยังไม่มีบัญชีที่เชื่อม</p>
          ) : (
            <ul className="auth-passkey-list">
              {accounts.map((a) => (
                <li key={a.id} className="auth-passkey-item">
                  <div className="auth-passkey-meta">
                    <strong>{providerLabel(a.providerId)}</strong>
                    <span className="auth-bar-muted">
                      เชื่อมเมื่อ {fmtDate(a.createdAt)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="auth-bar-btn auth-bar-ghost"
                    disabled={busy === `unlink-${a.id}`}
                    onClick={() => void unlinkProvider(a)}
                  >
                    ยกเลิกเชื่อม
                  </button>
                </li>
              ))}
            </ul>
          )}
          {linkable.length > 0 ? (
            <div className="account-link-row">
              {linkable.map((p) => (
                <button
                  key={p}
                  type="button"
                  className="admin-btn"
                  disabled={busy === `link-${p}`}
                  onClick={() => void linkProvider(p)}
                >
                  + เชื่อม {providerLabel(p)}
                </button>
              ))}
            </div>
          ) : null}
        </section>

        <section className="account-panel">
          <h2 className="auth-section-title">พาสคีย์</h2>
          <p className="auth-hint">
            Face ID / Touch ID / Windows Hello หรือ security key —
            เข้าครั้งถัดไปโดยไม่พึ่งรหัสผ่าน
          </p>
          <button
            type="button"
            className="auth-provider auth-provider-passkey"
            disabled={busy === "passkey"}
            onClick={() => void addPasskey()}
          >
            <PasskeyMark className="auth-provider-icon" />
            <span>
              {busy === "passkey" ? "กำลังทำงาน…" : "เพิ่มพาสคีย์บนเครื่องนี้"}
            </span>
          </button>
          {passkeys.length === 0 ? (
            <p className="auth-hint">ยังไม่มีพาสคีย์</p>
          ) : (
            <ul className="auth-passkey-list">
              {passkeys.map((pk) => {
                const label =
                  pk.name ||
                  getAuthenticatorName(pk.aaguid || undefined) ||
                  "Passkey";
                return (
                  <li key={pk.id} className="auth-passkey-item">
                    <PasskeyMark className="auth-passkey-icon" />
                    <div className="auth-passkey-meta">
                      <strong>{label}</strong>
                      <span className="auth-bar-muted">
                        {pk.deviceType || "device"}
                        {pk.backedUp ? " · synced" : ""}
                        {pk.createdAt ? ` · ${fmtDate(pk.createdAt)}` : ""}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="auth-bar-btn auth-bar-ghost"
                      disabled={busy === `pk-${pk.id}`}
                      onClick={() => void removePasskey(pk.id)}
                    >
                      ลบ
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
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
            <ul className="auth-passkey-list">
              {sessions.map((s) => {
                const isCurrent =
                  s.id === currentSession.id ||
                  (currentToken ? s.token === currentToken : false);
                return (
                  <li key={s.id} className="auth-passkey-item">
                    <div className="auth-passkey-meta">
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
                        ปิด
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
          <button type="button" className="admin-btn admin-btn-danger" onClick={signOut}>
            ออกจากระบบ
          </button>
        </footer>
      </div>
    </main>
  );
}
