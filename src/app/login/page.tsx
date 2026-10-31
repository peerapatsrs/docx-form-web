"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { authClient } from "@/lib/auth-client";
import {
  ExternalAccountMark,
  GoogleMark,
  PasskeyMark,
} from "@/components/AuthIcons";

type ProviderInfo = { id: string; label: string };

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
  apple: "Apple",
  discord: "Discord",
  facebook: "Facebook",
  gitlab: "GitLab",
  linkedin: "LinkedIn",
  twitch: "Twitch",
  twitter: "X (Twitter)",
  spotify: "Spotify",
  tiktok: "TikTok",
  reddit: "Reddit",
  line: "LINE",
  kakao: "Kakao",
  notion: "Notion",
  slack: "Slack",
  dropbox: "Dropbox",
  huggingface: "Hugging Face",
  paypal: "PayPal",
  salesforce: "Salesforce",
  zoom: "Zoom",
};

export default function LoginPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/auth-config")
      .then((r) => r.json())
      .then((data: { providers?: string[] }) => {
        const list = Array.isArray(data.providers) ? data.providers : [];
        setProviders(
          list.map((id) => ({
            id,
            label: PROVIDER_LABELS[id] || id,
          })),
        );
      })
      .catch(() => setProviders([]));

    // Conditional UI: offer existing passkeys when browser supports it
    if (
      typeof PublicKeyCredential !== "undefined" &&
      "isConditionalMediationAvailable" in PublicKeyCredential &&
      typeof PublicKeyCredential.isConditionalMediationAvailable === "function"
    ) {
      void PublicKeyCredential.isConditionalMediationAvailable().then((ok) => {
        if (ok) void authClient.signIn.passkey({ autoFill: true });
      });
    }
  }, []);

  const googleFirst = useMemo(() => {
    const g = providers.find((p) => p.id === "google");
    const rest = providers.filter((p) => p.id !== "google");
    return g ? [g, ...rest] : rest;
  }, [providers]);

  async function signInSocial(id: string) {
    setError("");
    setBusy(id);
    try {
      await authClient.signIn.social({
        provider: id as "google",
        callbackURL: "/",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "เข้าสู่ระบบไม่สำเร็จ");
      setBusy(null);
    }
  }

  async function signInPasskey() {
    setError("");
    setBusy("passkey");
    try {
      const { error: err } = await authClient.signIn.passkey({
        autoFill: false,
      });
      if (err) {
        setError(err.message || "พาสคีย์ไม่สำเร็จ");
        setBusy(null);
        return;
      }
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : "พาสคีย์ไม่สำเร็จ");
      setBusy(null);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-card">
        <p className="auth-eyebrow">docx-form</p>
        <h1 className="auth-title">เข้าสู่ระบบ</h1>
        <p className="auth-lead">
          ใช้บัญชีภายนอกที่เชื่อถือได้ — ไม่เก็บรหัสผ่านในระบบนี้ หลังล็อกอินสำเร็จ
          สามารถลงทะเบียนพาสคีย์เพื่อเข้าครั้งถัดไปได้เร็วและปลอดภัยขึ้น
        </p>

        <input
          type="text"
          name="username"
          autoComplete="username webauthn"
          className="auth-webauthn-trap"
          aria-hidden="true"
          tabIndex={-1}
        />

        {error ? (
          <p className="auth-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="auth-actions">
          <button
            type="button"
            className="auth-provider auth-provider-passkey"
            disabled={busy !== null}
            onClick={() => void signInPasskey()}
          >
            <PasskeyMark className="auth-provider-icon" />
            <span>{busy === "passkey" ? "รอพาสคีย์…" : "เข้าด้วยพาสคีย์"}</span>
          </button>

          {googleFirst.length === 0 ? (
            <p className="auth-hint">
              ยังไม่ได้ตั้งค่า OAuth — ใส่ <code>GOOGLE_CLIENT_ID</code> /{" "}
              <code>GOOGLE_CLIENT_SECRET</code> ใน <code>.env.local</code> แล้วรีสตาร์ทเซิร์ฟเวอร์
            </p>
          ) : (
            googleFirst.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`auth-provider${p.id === "google" ? " auth-provider-google" : ""}`}
                disabled={busy !== null}
                onClick={() => void signInSocial(p.id)}
              >
                {p.id === "google" ? (
                  <GoogleMark className="auth-provider-icon" />
                ) : (
                  <ExternalAccountMark className="auth-provider-icon" />
                )}
                <span>{busy === p.id ? "กำลังเปิด…" : `เข้าด้วย ${p.label}`}</span>
              </button>
            ))
          )}
        </div>

        <p className="auth-foot">
          <Link href="/">กลับหน้าหลัก</Link>
          {" · "}
          เซสชันเข้ารหัสในคุกกี้ HttpOnly · OAuth ผ่าน HTTPS ในโปรดักชัน
        </p>
      </div>
    </main>
  );
}
