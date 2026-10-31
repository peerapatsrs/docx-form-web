"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { getAuthenticatorName } from "@better-auth/passkey";
import { PasskeyMark } from "@/components/AuthIcons";

type PasskeyRow = {
  id: string;
  name?: string | null;
  aaguid?: string | null;
  createdAt?: string | Date;
  deviceType?: string | null;
  backedUp?: boolean;
};

export default function AccountPage() {
  const [email, setEmail] = useState<string>("");
  const [name, setName] = useState<string>("");
  const [passkeys, setPasskeys] = useState<PasskeyRow[]>([]);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const { data: session } = await authClient.getSession();
    if (!session?.user) {
      window.location.href = "/login";
      return;
    }
    setEmail(session.user.email || "");
    setName(session.user.name || "");
    const { data, error: listErr } = await authClient.passkey.listUserPasskeys();
    if (listErr) {
      setError(listErr.message || "โหลดพาสคีย์ไม่สำเร็จ");
      return;
    }
    setPasskeys(Array.isArray(data) ? (data as PasskeyRow[]) : []);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function addPasskey() {
    setError("");
    setOk("");
    setBusy(true);
    try {
      const label = name || email || "docx-form";
      const { error: err } = await authClient.passkey.addPasskey({
        name: `${label} · ${new Date().toLocaleDateString("th-TH")}`,
      });
      if (err) {
        setError(err.message || "ลงทะเบียนพาสคีย์ไม่สำเร็จ");
        return;
      }
      setOk("ลงทะเบียนพาสคีย์แล้ว — ครั้งถัดไปเข้าด้วยพาสคีย์ได้จากหน้าล็อกอิน");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ลงทะเบียนพาสคีย์ไม่สำเร็จ");
    } finally {
      setBusy(false);
    }
  }

  async function removePasskey(id: string) {
    if (!window.confirm("ลบพาสคีย์นี้?")) return;
    setError("");
    setOk("");
    setBusy(true);
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
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-card auth-card-wide">
        <p className="auth-eyebrow">บัญชี</p>
        <h1 className="auth-title">{name || "ผู้ใช้"}</h1>
        <p className="auth-lead">{email || "—"}</p>

        <section className="auth-section">
          <h2 className="auth-section-title">พาสคีย์</h2>
          <p className="auth-hint">
            ลงทะเบียนหลังล็อกอินด้วย Google (หรือผู้ให้บริการอื่น) แล้ว — ใช้ Face ID / Touch ID /
            Windows Hello หรือ security key เข้าครั้งถัดไปโดยไม่ต้องพึ่งรหัสผ่าน
          </p>

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

          <button
            type="button"
            className="auth-provider auth-provider-passkey"
            disabled={busy}
            onClick={() => void addPasskey()}
          >
            <PasskeyMark className="auth-provider-icon" />
            <span>{busy ? "กำลังทำงาน…" : "เพิ่มพาสคีย์บนเครื่องนี้"}</span>
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
                      </span>
                    </div>
                    <button
                      type="button"
                      className="auth-bar-btn auth-bar-ghost"
                      disabled={busy}
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

        <p className="auth-foot">
          <Link href="/">กลับหน้าหลัก</Link>
          {" · "}
          <button
            type="button"
            className="auth-linkish"
            onClick={() => {
              void authClient.signOut({
                fetchOptions: {
                  onSuccess: () => {
                    window.location.href = "/login";
                  },
                },
              });
            }}
          >
            ออกจากระบบ
          </button>
        </p>
      </div>
    </main>
  );
}
