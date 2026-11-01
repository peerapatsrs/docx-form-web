"use client";

import { useEffect, useMemo, useState } from "react";
import { authClient } from "@/lib/auth-client";
import {
  ExternalAccountMark,
  GoogleMark,
  PasskeyMark,
} from "@/components/AuthIcons";
import { BrandLogo, BRAND_NAME } from "@/components/BrandLogo";

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

/** Only allow same-origin relative paths (block open redirects). */
function safeNextPath(raw: string | null | undefined, fallback = "/"): string {
  const v = String(raw || "").trim();
  if (!v.startsWith("/") || v.startsWith("//")) return fallback;
  return v;
}

const AUTH_ERROR_HINTS: Record<string, string> = {
  state_mismatch:
    "การยืนยัน OAuth ไม่สำเร็จ — อย่ารีเฟรช/ย้อนกลับหน้า callback ให้กดเข้าสู่ระบบใหม่จากหน้านี้",
  state_invalid: "สถานะล็อกอินหมดอายุหรือเสีย — ลองเข้าสู่ระบบใหม่",
  please_restart:
    "รอบล็อกอินนี้ใช้ไม่ได้แล้ว — เริ่มเข้าสู่ระบบใหม่จากหน้านี้",
};

type DevUser = {
  id: string;
  name?: string | null;
  email: string;
  role?: string;
  plan?: string;
  banned?: boolean;
};

function readLoginErrorFromQuery(): string {
  if (typeof window === "undefined") return "";
  try {
    const fromQuery = new URLSearchParams(window.location.search).get("error");
    if (!fromQuery) return "";
    return AUTH_ERROR_HINTS[fromQuery] || `ล็อกอินไม่สำเร็จ (${fromQuery})`;
  } catch {
    return "";
  }
}

export default function LoginPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [devAuth, setDevAuth] = useState(false);
  const [devUsers, setDevUsers] = useState<DevUser[]>([]);
  const [error, setError] = useState(readLoginErrorFromQuery);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get("error")) {
        const url = new URL(window.location.href);
        url.searchParams.delete("error");
        window.history.replaceState({}, "", url.pathname + url.search);
      }
    } catch {
      /* ignore */
    }

    void fetch("/api/auth-config")
      .then((r) => r.json())
      .then((data: { providers?: string[]; devAuth?: boolean }) => {
        const list = Array.isArray(data.providers) ? data.providers : [];
        setProviders(
          list.map((id) => ({
            id,
            label: PROVIDER_LABELS[id] || id,
          })),
        );
        setDevAuth(Boolean(data.devAuth));
        if (data.devAuth) {
          void fetch("/api/auth/dev/users", { credentials: "include" })
            .then((r) => r.json())
            .then((body: { users?: DevUser[] }) => {
              setDevUsers(Array.isArray(body.users) ? body.users : []);
            })
            .catch(() => setDevUsers([]));
        }
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

  function postLoginPath(): string {
    try {
      return safeNextPath(
        new URLSearchParams(window.location.search).get("next"),
        "/",
      );
    } catch {
      return "/";
    }
  }

  async function signInSocial(id: string) {
    setError("");
    setBusy(id);
    try {
      await authClient.signIn.social({
        provider: id as "google",
        callbackURL: postLoginPath(),
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
      window.location.assign(postLoginPath());
    } catch (err) {
      setError(err instanceof Error ? err.message : "พาสคีย์ไม่สำเร็จ");
      setBusy(null);
    }
  }

  async function loginAsDev(user: DevUser) {
    if (user.banned) {
      setError("ผู้ใช้นี้ถูกแบน");
      return;
    }
    setError("");
    setBusy(`dev-${user.id}`);
    try {
      const res = await fetch("/api/auth/dev/login-as", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string | { message?: string };
      };
      if (!res.ok || !data.ok) {
        const msg =
          (typeof data.error === "object" && data.error?.message) ||
          data.message ||
          data.error ||
          "เลือก user ไม่สำเร็จ";
        setError(String(msg));
        setBusy(null);
        return;
      }
      const next = postLoginPath();
      window.location.assign(next === "/" ? "/account" : next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "เลือก user ไม่สำเร็จ");
      setBusy(null);
    }
  }

  return (
    <main className="auth-page">
      <div className={`auth-card${devAuth ? " auth-card-wide" : ""}`}>
        <div className="auth-brand">
          <BrandLogo size={40} className="brand-logo auth-brand-logo" />
          <p className="auth-eyebrow">{BRAND_NAME}</p>
        </div>
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

        {devAuth ? (
          <section className="dev-user-panel" aria-label="Dev user picker">
            <p className="auth-section-title">Dev — เลือก user (ไม่ต้อง OAuth)</p>
            <p className="auth-hint">
              ใช้เฉพาะ local · ตอนนี้มี{" "}
              <strong>peerapat.srs@gmail.com</strong> เป็น superadmin
            </p>
            {devUsers.length === 0 ? (
              <p className="auth-hint">ยังไม่มี user ในฐานข้อมูล — ล็อกอิน Google จริงครั้งหนึ่งก่อน</p>
            ) : (
              <ul className="dev-user-list">
                {devUsers.map((u) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      className="dev-user-btn"
                      disabled={busy !== null || Boolean(u.banned)}
                      onClick={() => void loginAsDev(u)}
                    >
                      <span className="dev-user-main">
                        <strong>{u.name || u.email}</strong>
                        <span>
                          {u.email}
                          {u.banned ? " · แบน" : ""}
                        </span>
                      </span>
                      <span className="dev-user-meta">
                        {u.role || "user"} · {u.plan || "free"}
                        {busy === `dev-${u.id}` ? "…" : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
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
          {/* Hard nav so home remounts cleanly with app.js (soft Link leaves a broken shell). */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- intentional full reload for guest shell */}
          <a href="/">กลับหน้าหลัก</a>
          {" · "}
          เซสชันเข้ารหัสในคุกกี้ HttpOnly · OAuth ผ่าน HTTPS ในโปรดักชัน
        </p>
      </div>
    </main>
  );
}
