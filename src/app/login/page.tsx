"use client";

import { useEffect, useMemo, useState, type ComponentType } from "react";
import { authClient } from "@/lib/auth-client";
import {
  ExternalAccountMark,
  GoogleMark,
  PasskeyMark,
} from "@/components/AuthIcons";
import { BrandLogo, BRAND_NAME } from "@/components/BrandLogo";
import { resolveDevAutoLoginUser } from "@/lib/dev-auth-auto-login";
import {
  parseTestAccountsPayload,
  resolveTestLoginRedirect,
  shouldShowTestAccountsPanel,
  TEST_ACCOUNTS_LIST_PATH,
  TEST_ACCOUNTS_PANEL_TITLE,
  TEST_LOGIN_PATH,
  type DevTestAccount,
} from "@/lib/dev-test-login";
type ProviderInfo = { id: string; label: string };

type DevUser = {
  id: string;
  name?: string | null;
  email: string;
  role?: string;
  plan?: string;
  banned?: boolean;
};

const INCLUDE_DEV_AUTH_CLIENT =
  process.env.NODE_ENV !== "production" ||
  process.env.NEXT_PUBLIC_DEV_AUTH === "1";

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

type DevPickerProps = {
  users: DevUser[];
  busy: string | null;
  onPick: (user: DevUser) => void;
};

export default function LoginPage() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [devAuth, setDevAuth] = useState(false);
  const [devUsers, setDevUsers] = useState<DevUser[]>([]);
  const [DevPicker, setDevPicker] = useState<ComponentType<DevPickerProps> | null>(
    null,
  );
  const [error, setError] = useState(readLoginErrorFromQuery);
  const [busy, setBusy] = useState<string | null>(null);
  const [accountNext, setAccountNext] = useState(false);
  const [testAccounts, setTestAccounts] = useState<DevTestAccount[]>([]);

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const next = params.get("next") || "";
      setAccountNext(next.startsWith("/account") || next.includes("account"));
      if (params.get("error")) {
        const url = new URL(window.location.href);
        url.searchParams.delete("error");
        window.history.replaceState({}, "", url.pathname + url.search);
      }
    } catch {
      /* ignore */
    }

    void (async () => {
      const data = (await fetch("/api/auth-config")
        .then((r) => r.json())
        .catch(() => ({}))) as {
        providers?: string[];
        devAuth?: boolean;
        devAuthDefaultEmail?: string | null;
      };
      const list = Array.isArray(data.providers) ? data.providers : [];
      setProviders(
        list.map((id) => ({
          id,
          label: PROVIDER_LABELS[id] || id,
        })),
      );

      if (INCLUDE_DEV_AUTH_CLIENT && data.devAuth) {
        const mod = await import("@/components/DevAuthControls");
        setDevPicker(() => mod.DevUserPicker);
        setDevAuth(true);
        const users = await mod.listDevUsers();
        setDevUsers(users);
        // When auth-config returns null/empty default email (no env), show
        // the picker only — never fall back to users[0] auto login-as.
        const target = resolveDevAutoLoginUser(
          users,
          data.devAuthDefaultEmail,
        );
        if (target) {
          void loginAsDev(target, mod.loginAsDevUser);
        }
      } else {
        setDevAuth(false);
      }

      // Backend-gated DEV test accounts (404 → hide). Never asks for passwords.
      try {
        const res = await fetch(TEST_ACCOUNTS_LIST_PATH, {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          setTestAccounts([]);
          return;
        }
        const body = await res.json().catch(() => null);
        const accounts = parseTestAccountsPayload(body);
        setTestAccounts(
          shouldShowTestAccountsPanel(res.status, accounts) ? accounts : [],
        );
      } catch {
        setTestAccounts([]);
      }
    })();

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

  async function loginAsDev(
    user: DevUser,
    loginFn?: (input: {
      userId?: string;
      email?: string;
    }) => Promise<{ ok: boolean; message?: string }>,
  ) {
    if (!INCLUDE_DEV_AUTH_CLIENT) return;
    if (user.banned) {
      setError("ผู้ใช้นี้ถูกแบน");
      return;
    }
    setError("");
    setBusy(`dev-${user.id}`);
    try {
      const loginAsDevUser =
        loginFn ||
        (await import("@/components/DevAuthControls")).loginAsDevUser;
      const result = await loginAsDevUser({ userId: user.id });
      if (!result.ok) {
        setError(result.message || "เลือก user ไม่สำเร็จ");
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

  async function loginAsTestAccount(account: DevTestAccount) {
    setError("");
    setBusy(`test-${account.key}`);
    try {
      const res = await fetch(TEST_LOGIN_PATH, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ key: account.key }),
      });
      if (res.status === 404) {
        setTestAccounts([]);
        setError("บัญชีทดสอบปิดอยู่บนสภาพแวดล้อมนี้");
        setBusy(null);
        return;
      }
      if (!res.ok) {
        let msg = "เข้าด้วยบัญชีทดสอบไม่สำเร็จ";
        try {
          const data = (await res.json()) as { error?: string };
          if (data?.error) msg = String(data.error);
        } catch {
          /* ignore */
        }
        setError(msg);
        setBusy(null);
        return;
      }
      const nextParam = (() => {
        try {
          return new URLSearchParams(window.location.search).get("next");
        } catch {
          return null;
        }
      })();
      window.location.assign(
        resolveTestLoginRedirect(account.role, nextParam),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "เข้าด้วยบัญชีทดสอบไม่สำเร็จ",
      );
      setBusy(null);
    }
  }

  const showTestAccounts = testAccounts.length > 0;

  return (
    <main className="auth-page">
      <div
        className={`auth-card${devAuth || showTestAccounts ? " auth-card-wide" : ""}`}
      >
        <div className="auth-brand">
          <BrandLogo size={40} className="brand-logo auth-brand-logo" />
          <p className="auth-eyebrow">{BRAND_NAME}</p>
        </div>
        <h1 className="auth-title">เข้าสู่ระบบ</h1>
        <p className="auth-lead">
          {accountNext
            ? "เข้าสู่ระบบเพื่อดูบัญชีและบันทึกคีย์ AI ข้ามเครื่อง — ใช้งานฟรีได้โดยไม่ต้องเข้าสู่ระบบ"
            : "เข้าสู่ระบบเพื่อบันทึกงานข้ามเครื่อง หรือใช้แผนจ่ายแล้ว — ใช้งานฟรีได้โดยไม่ต้องเข้าสู่ระบบ"}
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

        {devAuth && DevPicker ? (
          <DevPicker
            users={devUsers}
            busy={busy}
            onPick={(u) => void loginAsDev(u)}
          />
        ) : null}

        {showTestAccounts ? (
          <section
            className="auth-test-accounts"
            aria-label={TEST_ACCOUNTS_PANEL_TITLE}
          >
            <h2 className="auth-test-accounts-title">
              {TEST_ACCOUNTS_PANEL_TITLE}
            </h2>
            <p className="auth-test-accounts-lead">
              กดครั้งเดียวเพื่อเข้าสู่ระบบบน DEV — ไม่มีรหัสผ่านส่งถึงเบราว์เซอร์
            </p>
            <div className="auth-test-accounts-actions">
              {testAccounts.map((account) => (
                <button
                  key={account.key}
                  type="button"
                  className="auth-provider auth-provider-test"
                  disabled={busy !== null}
                  onClick={() => void loginAsTestAccount(account)}
                >
                  <span>
                    {busy === `test-${account.key}`
                      ? "กำลังเข้า…"
                      : account.label}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <div className="auth-actions">
          {googleFirst.length === 0 ? (
            <p className="auth-hint">
              ยังไม่ได้ตั้งค่าการเข้าสู่ระบบด้วยบัญชีภายนอก — ติดต่อฝ่ายสนับสนุน
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

          <button
            type="button"
            className="auth-provider auth-provider-passkey"
            disabled={busy !== null}
            onClick={() => void signInPasskey()}
          >
            <PasskeyMark className="auth-provider-icon" />
            <span>
              {busy === "passkey" ? "รอพาสคีย์…" : "เข้าด้วยพาสคีย์ (ถ้ามีแล้ว)"}
            </span>
          </button>
        </div>

        <p className="auth-foot">
          {/* Hard nav so home remounts cleanly with app.js (soft Link leaves a broken shell). */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- intentional full reload for guest shell */}
          <a className="auth-home-link" href="/" style={{ minHeight: 44, display: "inline-flex", alignItems: "center" }}>
            กลับหน้าหลัก
          </a>
          <span className="auth-foot-sep" aria-hidden="true">
            ·
          </span>
          <span className="auth-foot-note">เซสชันปลอดภัยบนเบราว์เซอร์นี้</span>
        </p>
      </div>
    </main>
  );
}
